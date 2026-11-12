// Shared code for the companion (the live helper): load a room's knowledge, build
// the cached system prompt, and call the two lanes.
//
//   fast lane  ASSIST_FAST_MODEL  (default claude-opus-5-5)  transcript cleanup, speaker, stage,
//                                                              FACT and NOTE cards (+ CALC from room numbers)
//   deep lane  ASSIST_DEEP_MODEL  (default claude-fable-5-2)   the considered SUGGEST card, and the
//                                                              full answer on Think, streamed
//
// Both lanes get the same knowledge: the whole room (every page, personas, banks, one
// card, glossary, corrections, connector findings) as one cached system block, then
// what the user fed it for this session as a second cached block. After the first call
// of a session each request pays only for the transcript and the question.
// Refusals: both lanes opt in to server-side fallbacks ("default" routing). Set
// ASSIST_REFUSAL_FALLBACK=off to drop it (e.g. on a gateway that rejects the beta).
import type Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type Entry = { title: string; source: string; text: string; kind?: string; id?: string };
export type Person = { name: string; title?: string; slug?: string };
export type Persona = { name: string; title?: string; page: string };
export type Meeting = { date: string; time?: string; title?: string; who?: string; format?: string; length?: string };
export type Corpus = { room: string; title: string; asOf: string; summary?: string; people?: Person[]; personas?: Persona[]; meetings?: Meeting[]; entries: Entry[] };
export type Fed = { title: string; text: string; kind?: string; at?: string };

const cache = new Map<string, Corpus>();

// Written by scripts/build.mjs into netlify/functions/corpus/<room>.json and
// shipped with the functions via included_files in netlify.toml.
export function loadCorpus(room: string): Corpus {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(room || "")) throw new Error("bad room");
  const hit = cache.get(room);
  if (hit) return hit;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, "corpus", `${room}.json`), join(process.cwd(), "netlify/functions/corpus", `${room}.json`)]) {
    try {
      const c = JSON.parse(readFileSync(p, "utf8")) as Corpus;
      cache.set(room, c);
      return c;
    } catch {}
  }
  throw new Error(`no knowledge built for room "${room}"`);
}
/** For tests: put a corpus in the cache without a file. */
export function setCorpus(c: Corpus) { cache.set(c.room, c); }

const list = (s = "") => s.split(",").map((x) => x.trim()).filter(Boolean);
const uniq = (a: string[]) => [...new Set(a)];

export const FAST_MODEL = process.env.ASSIST_FAST_MODEL || "claude-opus-5-5";
export const DEEP_MODEL = process.env.ASSIST_DEEP_MODEL || "claude-fable-5-2";
// Tried in order; the next one is used only when a model id is not available.
// ASSIST_MODELS (older setting) is appended to both lists as a last resort.
export const FAST_MODELS = uniq([FAST_MODEL, DEEP_MODEL, ...list(process.env.ASSIST_MODELS)]);
export const DEEP_MODELS = uniq([DEEP_MODEL, FAST_MODEL, ...list(process.env.ASSIST_MODELS)]);
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const FAST_EFFORT = EFFORTS.includes(process.env.ASSIST_FAST_EFFORT || "") ? process.env.ASSIST_FAST_EFFORT! : "low";
export const DEEP_EFFORT = EFFORTS.includes(process.env.ASSIST_DEEP_EFFORT || "") ? process.env.ASSIST_DEEP_EFFORT! : "medium";

const FALLBACK_BETA = "server-side-fallback-2026-07-01";
let fallbackOn = (process.env.ASSIST_REFUSAL_FALLBACK || "default") !== "off";

// ---------------------------------------------------------------- client (injectable for tests)

type ClientLike = { beta: { messages: { create: (body: any) => Promise<any>; stream: (body: any) => any } } };
let makeClient: () => Promise<ClientLike> = async () => {
  const { default: AnthropicSDK } = await import("@anthropic-ai/sdk");
  return new AnthropicSDK() as unknown as ClientLike;
};
/** Tests swap in a mock so no paid API is ever called. Pass null to restore the SDK. */
export function setClientFactory(f: (() => ClientLike | Promise<ClientLike>) | null) {
  makeClient = f ? async () => f() : async () => {
    const { default: AnthropicSDK } = await import("@anthropic-ai/sdk");
    return new AnthropicSDK() as unknown as ClientLike;
  };
}

// ---------------------------------------------------------------- knowledge

/** The room as one cached system block, with the people, personas and meetings first. */
export function roomBlock(c: Corpus): Anthropic.TextBlockParam {
  const head = [
    `ROOM: ${c.title} (as of ${c.asOf})`,
    c.summary ? `SUMMARY: ${c.summary}` : "",
    c.people?.length ? `PEOPLE ACROSS THE TABLE: ${c.people.map((p) => p.name + (p.title ? ` (${p.title})` : "")).join("; ")}` : "",
    c.personas?.length ? `PERSONA PAGES: ${c.personas.map((p) => `${p.name}${p.title ? `, ${p.title}` : ""} (${p.page})`).join("; ")}` : "",
    c.meetings?.length ? `MEETINGS: ${c.meetings.map((m) => [m.date, m.time, m.title, m.who, m.format, m.length].filter(Boolean).join(" · ")).join("; ")}` : "",
    "Grades appear inline as [grade: verified|partly|weak|inference|none|not-public|unknown].",
  ].filter(Boolean).join("\n");
  return {
    type: "text",
    text: head + "\n\n" + c.entries.map((e) => `<<<${e.title} | ${e.source}${e.kind ? ` | ${e.kind}` : ""}>>>\n${e.text}\n<<<end>>>`).join("\n\n"),
    cache_control: { type: "ephemeral" }, // the same on every call in a session
  };
}

export const FED_MAX_ITEM = 20000;
export const FED_MAX_TOTAL = 60000;

/** Clean what the phone sent as fed items: strings only, capped, in the order given (the order keeps the cache warm). */
export function cleanFed(raw: unknown): Fed[] {
  const out: Fed[] = [];
  let total = 0;
  for (const f of Array.isArray(raw) ? raw.slice(0, 40) : []) {
    const text = String((f as any)?.text ?? "").replace(/\u0000/g, "").trim().slice(0, FED_MAX_ITEM);
    if (!text) continue;
    if (total + text.length > FED_MAX_TOTAL) break;
    total += text.length;
    out.push({ title: String((f as any)?.title ?? "note").slice(0, 80), text, kind: String((f as any)?.kind ?? "note").slice(0, 20), at: String((f as any)?.at ?? "").slice(0, 30) });
  }
  return out;
}

/** What the user fed the companion for this meeting, as a second cached block (or null). */
export function fedBlock(fed: Fed[]): Anthropic.TextBlockParam | null {
  if (!fed.length) return null;
  return {
    type: "text",
    text: "FED BY THE USER FOR THIS MEETING (their own notes and files; newer than the room; grade as \"fed\"; cite as \"Fed: <title>\"):\n\n" +
      fed.map((f) => `<<<Fed: ${f.title} | ${f.kind || "note"}${f.at ? ` | ${f.at}` : ""}>>>\n${f.text}\n<<<end>>>`).join("\n\n"),
    cache_control: { type: "ephemeral" },
  };
}

/** Role text first, then the room, then the fed items: the order every lane uses. */
export function systemFor(role: string, c: Corpus, fed: Fed[] = []): Anthropic.TextBlockParam[] {
  const blocks: Anthropic.TextBlockParam[] = [{ type: "text", text: role }, roomBlock(c)];
  const f = fedBlock(fed);
  if (f) blocks.push(f);
  return blocks;
}

/** What the companion knows, for the phone's "knows" line. */
export function knows(c: Corpus) {
  const kinds: Record<string, number> = {};
  for (const e of c.entries) kinds[e.kind || "page"] = (kinds[e.kind || "page"] || 0) + 1;
  return {
    room: c.room, title: c.title, asOf: c.asOf,
    pages: c.entries.filter((e) => !e.kind || !["fed", "connector"].includes(e.kind)).length,
    kinds,
    personas: (c.personas || []).map((p) => ({ name: p.name, title: p.title || "", page: p.page })),
    people: (c.people || []).map((p) => ({ name: p.name, title: p.title || "" })),
    savedFed: c.entries.filter((e) => e.kind === "fed").map((e) => e.title),
    chars: c.entries.reduce((n, e) => n + e.text.length, 0),
  };
}

// ---------------------------------------------------------------- calls

const isModelMissing = (e: any) => {
  const status = e?.status ?? e?.statusCode;
  const text = String(e?.message || "");
  return status === 404 || (status === 400 && /model/i.test(text) && !/fallback/i.test(text)) || /not found|unsupported model|invalid model|model .*not (available|supported)/i.test(text);
};
const isFallbackRejected = (e: any) => (e?.status ?? e?.statusCode) === 400 && /fallback|anthropic-beta|beta/i.test(String(e?.message || ""));

function withFallback(params: Record<string, unknown>) {
  return fallbackOn ? { ...params, betas: [FALLBACK_BETA], fallbacks: "default" } : params;
}

type Params = { system: Anthropic.TextBlockParam[]; messages: Anthropic.MessageParam[]; max_tokens: number; effort: string };

/** Fast lane: one non-streaming call, falling through the model list. */
export async function askFast(p: Params) {
  const client = await makeClient();
  let lastErr: unknown;
  for (const model of FAST_MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const body = withFallback({ model, max_tokens: p.max_tokens, system: p.system, messages: p.messages, output_config: { effort: p.effort } });
        const msg = (await client.beta.messages.create(body as any)) as any;
        return { msg, model: (msg.model as string) || model };
      } catch (e) {
        lastErr = e;
        if (fallbackOn && isFallbackRejected(e)) { fallbackOn = false; continue; } // retry once without fallbacks
        if (isModelMissing(e)) break;
        throw e;
      }
    }
  }
  throw lastErr;
}

/**
 * Deep lane: a streamed call. Yields text as it arrives, then a final summary.
 * Falls through the model list only if nothing has been streamed yet.
 */
export async function* streamDeep(p: Params): AsyncGenerator<{ type: "model"; model: string } | { type: "text"; text: string } | { type: "end"; stop: string; cache: number; model: string }> {
  const client = await makeClient();
  let lastErr: unknown;
  for (const model of DEEP_MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let sent = false;
      try {
        const body = withFallback({ model, max_tokens: p.max_tokens, system: p.system, messages: p.messages, thinking: { type: "adaptive" }, output_config: { effort: p.effort } });
        const stream = client.beta.messages.stream(body as any);
        for await (const ev of stream as any) {
          if (ev.type === "message_start") yield { type: "model", model: ev.message?.model || model };
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
            sent = true;
            yield { type: "text", text: ev.delta.text };
          }
        }
        const final: any = await stream.finalMessage();
        yield { type: "end", stop: final.stop_reason, cache: final.usage?.cache_read_input_tokens ?? 0, model: final.model || model };
        return;
      } catch (e) {
        lastErr = e;
        if (sent) throw e;
        if (fallbackOn && isFallbackRejected(e)) { fallbackOn = false; continue; }
        if (isModelMissing(e)) break;
        throw e;
      }
    }
  }
  throw lastErr;
}

/** Deep lane, collected: the whole text once the stream ends (for the SUGGEST card). */
export async function askDeep(p: Params) {
  let text = "", model = "", stop = "", cache = 0;
  for await (const ev of streamDeep(p)) {
    if (ev.type === "model") model = ev.model;
    else if (ev.type === "text") text += ev.text;
    else { stop = ev.stop; cache = ev.cache; model = ev.model || model; }
  }
  return { text, model, stop, cache };
}

/** The first JSON object in a model reply, or null. */
export function parseJson(text: string): any {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
