// Companion, fast lane: within a couple of seconds of new speech, clean the
// transcript, guess who is speaking and the stage, and return glance cards:
//   FACT  the fact that answers what was just asked, with its room page and grade
//   NOTE  commitments, numbers they gave, names, open questions, follow-ups
//   CALC  only when a calculation needs a number from the room; the server recomputes
//         it from op + args (the phone computes numbers heard in the conversation itself)
// Model: ASSIST_FAST_MODEL (default claude-opus-5-5), effort ASSIST_FAST_EFFORT (low).
// Knowledge: the whole room + what the user fed it, as cached system blocks.
// Runs behind the room's password gate: the edge function sees /<room>/api/*
// first and refuses anyone without the room cookie.
import type { Config, Context } from "@netlify/functions";
import { askFast, cleanFed, json, loadCorpus, parseJson, systemFor, FAST_EFFORT, type Corpus } from "./_assist.ts";
import { validateCard, isDuplicate, recheckCalc, STAGES, CALC_OPS } from "../../templates/assist/core.js";

export function fastRole(c: Corpus) {
  const names = (c.people || []).map((p) => p.name).concat((c.personas || []).map((p) => p.name));
  const who = [...new Set(names)].join(", ") || "the other side";
  return `You are the fast lane of a silent companion on the user's phone during a live conversation about ${c.title}. The user glances at the screen for two seconds while talking. You never speak to anyone; you only return JSON.

People across the table: ${who}. The user is "us".

You receive NEW SEGMENTS (raw speech-to-text with ids; "(turn)" marks a voice change; names and numbers often garbled), the CONTEXT so far, the current STAGE and SPEAKER guesses, the cards ALREADY SHOWN, and sometimes a typed question.

Return ONLY this JSON object:
{"lines":[{"id":<segment id>,"speaker":"us|<name>|them|unknown","text":"<cleaned>"}],
 "stage":"${STAGES.join("|")}",
 "speaker":"<who spoke last>",
 "question":{"detected":true|false,"kind":"question|pushback|none","text":"<as asked, 12 words max>","asker":"<name|them>"},
 "cards":[ ...FACT, NOTE and CALC cards... ]}

Cleaning: fix obvious transcription errors using the room's names and terms; keep the words otherwise. Speaker: use voice turns, self-introductions, who was addressed, and the persona pages.

Stage: opening, discovery (they explore), numbers (figures on the table), push-back (they challenge something we said), close (wrap-up, next steps). Move forward only when the talk moves.

Cards (empty array when nothing new; never repeat ALREADY SHOWN):
- FACT, when the newest speech holds a question or push-back from them that is not yet answered (in mode "manual", always): 1 or 2 cards {"type":"FACT","q":"<the question, short>","text":"<the fact that answers it, under 18 words>","source":"<room page, e.g. Filings bank row 9>","grade":"<the grade the room gives it: verified|partly|weak|inference|none|not-public|unknown; fed for fed items>"}. Numbers, names and dates exactly as written in the room; never invent one. A "None found" or "Not public" row is never stated as a fact. If the room does not cover it: {"type":"FACT","text":"Not in room. Bridge: <one honest sentence>","source":"","grade":"unknown"}.
- On a push-back, the first FACT has "pushback":"new" (and text starting "New fact: ") when the room or the fed items hold a fact we have not used, or "pushback":"none" (text starting "No new fact: hold <the position>") when they do not.
- NOTE, only for what code would miss (an implied commitment, a decision, a name spelled out): {"type":"NOTE","kind":"commitment|number|name|question|followup","text":"<under 18 words>","who":"<speaker>"}.
- CALC, only when a number they just said should be set against a number in the room: {"type":"CALC","title":"<short>","op":"<${CALC_OPS.join("|")}>","args":{<numeric args for op>},"inputs":[{"label":"","value":"","source":"heard|<room page>"}],"result":"","formula":""}. Args by op: pct_of {pct,base}, share {part,whole}, change_pct {from,to}, ratio {a,b}, cagr {from,to,years}, times {multiple,base}, per_unit {total,units}, payback {cost,annual}, npv {cost,annual,years,rate}, irr {cost,annual,years}, subtract/multiply/divide {a,b}. Our side's numbers only from the room or the fed items, never from memory.

Plain English, no emojis, no prose outside the JSON.`;
}

type Segment = { id: number | string; text: string; turn?: boolean };

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const room = context.params.room;
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad JSON" }, 400); }
  const { mode = "auto", question = "", context: ctx = "", warm = false } = body || {};
  const segments: Segment[] = (Array.isArray(body?.segments) ? body.segments : []).slice(-6).map((s: any) => ({ id: s?.id ?? "", text: String(s?.text ?? "").slice(0, 1200), turn: !!s?.turn }));
  const shown: any[] = (Array.isArray(body?.shown) ? body.shown : []).slice(-40).map((c: any) => validateCard(c).card).filter(Boolean);
  const fed = cleanFed(body?.fed);
  let corpus: Corpus;
  try { corpus = loadCorpus(room); } catch (e: any) { return json({ error: e.message }, 404); }
  const t0 = Date.now();

  const system = systemFor(fastRole(corpus), corpus, fed);
  const brief = (c: any) => c.type + ": " + (c.text || c.title || c.say || c.ask || "");
  const user = `mode: ${mode === "manual" ? "manual" : "auto"}
STAGE: ${STAGES.includes(body?.stage) ? body.stage : "opening"}
SPEAKER: ${String(body?.speaker || "unknown").slice(0, 60)}
${question ? `typed question: ${String(question).slice(0, 500)}\n` : ""}ALREADY SHOWN:
${shown.map(brief).join("\n").slice(0, 2500) || "(nothing yet)"}

CONTEXT (cleaned, oldest first):
${String(ctx).slice(-4000) || "(none yet)"}

NEW SEGMENTS (oldest first; the last matters most):
${segments.length ? segments.map((s) => `[${s.id}]${s.turn ? " (turn)" : ""} ${s.text}`).join("\n") : "(none)"}`;

  try {
    // A warm-up call (when the user presses Listen) only loads the room into the cache.
    const { msg, model } = await askFast({ max_tokens: warm ? 16 : 1500, system, messages: [{ role: "user", content: warm ? "Reply with {}" : user }], effort: FAST_EFFORT });
    const cache = msg.usage?.cache_read_input_tokens ?? 0;
    if (msg.stop_reason === "refusal") return json({ lines: [], cards: [], model, ms: Date.now() - t0, error: "the model declined this request" });
    if (warm) return json({ warm: true, model, ms: Date.now() - t0, cache });
    const text = (msg.content || []).map((b: any) => (b.type === "text" ? b.text : "")).join("");
    const parsed = parseJson(text);
    if (!parsed) return json({ lines: [], cards: [], model, ms: Date.now() - t0, cache, error: "no JSON in the reply" });
    return json({ ...shapeFast(parsed, shown, mode, question), model, ms: Date.now() - t0, cache });
  } catch (e: any) {
    return json({ lines: [], cards: [], error: String(e?.message || e).slice(0, 300) }, 502);
  }
};

/** Validate the fast lane's JSON: keep valid cards, recompute CALCs, drop repeats. */
export function shapeFast(parsed: any, shown: any[], mode = "auto", typed = "") {
  const cards: any[] = [];
  let dropped = 0;
  for (const raw of Array.isArray(parsed?.cards) ? parsed.cards.slice(0, 8) : []) {
    const v = validateCard(raw);
    if (!v.ok || !v.card) { dropped++; continue; }
    let card: any = { ...v.card, lane: "fast" };
    if (card.type === "SUGGEST") { dropped++; continue; } // the deep lane owns SUGGEST
    if (card.type === "CALC") card = recheckCalc(card, raw.args);
    if (isDuplicate(card, shown) || isDuplicate(card, cards)) { dropped++; continue; }
    cards.push(card);
  }
  const q = parsed?.question || {};
  return {
    lines: (Array.isArray(parsed?.lines) ? parsed.lines : []).slice(0, 12).map((l: any) => ({ id: l?.id, speaker: String(l?.speaker || "").slice(0, 60), text: String(l?.text || "").slice(0, 1200) })),
    stage: STAGES.includes(parsed?.stage) ? parsed.stage : "",
    speaker: String(parsed?.speaker || "").slice(0, 60),
    question: { detected: !!q.detected || (mode === "manual" && !!typed), kind: ["question", "pushback"].includes(q.kind) ? q.kind : "question", text: String(q.text || typed || "").slice(0, 200), asker: String(q.asker || "").slice(0, 60) },
    cards,
    dropped,
  };
}

export const config: Config = { path: "/:room/api/suggest" };
