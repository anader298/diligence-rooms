// Companion, deep lane: a considered answer to one question, streamed as it is
// written. Triggered for each question the fast lane detects, or by Think.
// Model: ASSIST_DEEP_MODEL (default claude-fable-5-2); effort ASSIST_DEEP_EFFORT
// (default medium). The whole room, then what the user fed it, are the cached system prompt.
//
// Response: newline-delimited JSON, one object per line:
//   {"t":"model","model":"..."}   {"t":"text","d":"..."}   {"t":"done","ms":..,"cache":..,"stop":".."}
//   {"t":"error","error":"..."}
// Behind the room's password gate, like every /<room>/api/* path.
import type { Config, Context } from "@netlify/functions";
import { cleanFed, json, loadCorpus, streamDeep, systemFor, DEEP_EFFORT, type Corpus } from "./_assist.ts";

function role(c: Corpus) {
  const names = (c.people || []).map((p) => p.name).join(", ") || "the other side";
  return `You are the deep lane of a silent companion during a live conversation about ${c.title}, with ${names}. A fast lane has already put FACT, CALC and NOTE cards on screen. Your job is the considered answer the user glances at in a pause. You never speak to the people in the room.

Work only from the ROOM below and the items the user FED it for this meeting (newer than the room; cite them as "Fed: <title>"). Read the persona page of whoever asked (their "what they will probe", "how they judge" and "red flags" sections), the answer and practice banks, the one card, the page for the current meeting, and the evidence pages. Refer to a person's inner view only as "the <name> persona". Numbers, names and dates exactly as written in the room; never invent one. If the room does not cover something, say "Not in room" and give the honest bridge.

Write exactly these five sections, in this order, each heading alone on its own line in capitals, no markdown symbols:

BEST ANSWER
What the user should say, in the first person, in our words: 3 to 5 short spoken sentences, strongest point first.

EVIDENCE
2 to 4 lines, each starting with "- ", each one fact from the room followed by the page in brackets, e.g. (Filings bank row 10).

WHAT THEY ARE TESTING
One or two sentences: what the asker's persona is really checking with this question, and what a good answer proves to them.

ASK BACK
One question the user can ask back that moves the conversation forward.

RISK TO AVOID
One sentence: the trap in this question, or the claim the user must not make.

Plain English, no emojis, nothing before the first heading or after the last section.`;
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad JSON" }, 400); }
  const question = String(body?.question || "").trim().slice(0, 800);
  if (!question) return json({ error: "no question" }, 400);
  let corpus: Corpus;
  try { corpus = loadCorpus(context.params.room); } catch (e: any) { return json({ error: e.message }, 404); }

  const speaker = String(body?.speaker || "").slice(0, 80);
  const quick = body?.card && typeof body.card === "object" ? body.card : null;
  const user = `QUESTION: ${question}
ASKED BY: ${speaker || "unknown (guess from the context)"}
STAGE: ${String(body?.stage || "unknown").slice(0, 20)}${body?.kind === "pushback" ? "\nTHIS IS A PUSH-BACK on something the user said." : ""}
${quick ? `CARDS ALREADY SHOWN: ${JSON.stringify(quick).slice(0, 1500)}\n` : ""}
CONVERSATION SO FAR (oldest first):
${String(body?.context || "").slice(-6000) || "(no transcript; typed question)"}`;

  const system = systemFor(role(corpus), corpus, cleanFed(body?.fed));
  const t0 = Date.now();
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (o: unknown) => ctrl.enqueue(enc.encode(JSON.stringify(o) + "\n"));
      try {
        for await (const ev of streamDeep({ max_tokens: 4000, system, messages: [{ role: "user", content: user }], effort: DEEP_EFFORT })) {
          if (ev.type === "model") send({ t: "model", model: ev.model });
          else if (ev.type === "text") send({ t: "text", d: ev.text });
          else {
            if (ev.stop === "refusal") send({ t: "error", error: "The model declined this one. Use the FACT card." });
            send({ t: "done", ms: Date.now() - t0, cache: ev.cache, stop: ev.stop, model: ev.model });
          }
        }
      } catch (e: any) {
        send({ t: "error", error: String(e?.message || e).slice(0, 300) });
      }
      ctrl.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
};

export const config: Config = { path: "/:room/api/deep" };
