// Companion, deep lane, glance card: the considered SUGGEST card. What to say or ask
// next and where to steer, from the conversation stage and the persona of whoever is
// speaking (what they judge on). Called when a question or push-back is detected and
// when the stage moves; the phone shows it as the SUGGEST card.
// Model: ASSIST_DEEP_MODEL (default claude-fable-5-2), effort ASSIST_DEEP_EFFORT (medium).
// Knowledge: the whole room + what the user fed it, as cached system blocks.
// Behind the room's password gate, like every /<room>/api/* path.
import type { Config, Context } from "@netlify/functions";
import { askDeep, cleanFed, json, loadCorpus, parseJson, systemFor, DEEP_EFFORT, type Corpus } from "./_assist.ts";
import { validateCard, isDuplicate, STAGES } from "../../templates/assist/core.js";

export function steerRole(c: Corpus) {
  const personas = (c.personas || []).map((p) => `${p.name} (${p.page})`).join(", ") || "the persona pages in the room";
  return `You are the deep lane of a silent companion on the user's phone during a live conversation about ${c.title}. You write the SUGGEST card: what the user should say or ask next, and where to steer, in one glance. You never speak to anyone; you only return JSON.

Read the persona page of whoever is speaking (${personas}): what they will probe, how they judge, their red flags, their question bank. Shape the line to how that person judges: if they want a number first, lead with the number; if they mark down hedging, choose. Refer to a person's inner view only as "the <name> persona". Use the room's practice bank, answer bank, push-back drills and one card, the meeting page for this meeting, and the fed items (newer than the room).

By stage:
- opening: the line from the one card, and one rapport hook from the persona.
- discovery: answer, then the question that moves them toward what we need to learn.
- numbers: the number to hold (from the room or the fed items only) and the risk with it.
- push-back: first decide "new" (the room or fed items hold a fact we have not used) or "none" (hold the position and say what would change it). Never cave without a new fact.
- close: the open questions from the one card not yet asked, and the next step to secure.

Return ONLY: {"cards":[{"type":"SUGGEST","say":"<what to say, first person, under 26 words>","ask":"<a question to ask back, under 20 words, or empty>","steer":"<where to take the conversation next, under 14 words>","why":"<what this person judges on, under 16 words>","persona":"<name of the person it is shaped for>","pushback":"new|none (only on a push-back)"}]}
One card, two at most. Numbers, names and dates exactly as written in the room; never invent one. Nothing already shown. Plain English, no emojis.`;
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad JSON" }, 400); }
  let corpus: Corpus;
  try { corpus = loadCorpus(context.params.room); } catch (e: any) { return json({ error: e.message }, 404); }
  const fed = cleanFed(body?.fed);
  const shown: any[] = (Array.isArray(body?.shown) ? body.shown : []).slice(-30).map((c: any) => validateCard(c).card).filter(Boolean);
  const stage = STAGES.includes(body?.stage) ? body.stage : "discovery";
  const notes = (Array.isArray(body?.notes) ? body.notes : []).slice(-12).map((n: any) => `- ${String(n?.kind || "")}: ${String(n?.text || "").slice(0, 160)}`).join("\n");
  const user = `STAGE: ${stage}
SPEAKING: ${String(body?.speaker || "unknown").slice(0, 60)}
${body?.question ? `LAST QUESTION (${body?.kind === "pushback" ? "push-back" : "question"}): ${String(body.question).slice(0, 400)}\n` : ""}ALREADY SHOWN:
${shown.map((c) => c.type + ": " + (c.text || c.title || c.say || c.ask || "")).join("\n").slice(0, 2000) || "(nothing yet)"}
NOTES SO FAR:
${notes || "(none)"}

CONVERSATION SO FAR (oldest first):
${String(body?.context || "").slice(-6000) || "(no transcript yet)"}`;

  const t0 = Date.now();
  try {
    const r = await askDeep({ max_tokens: 4000, system: systemFor(steerRole(corpus), corpus, fed), messages: [{ role: "user", content: user }], effort: DEEP_EFFORT });
    if (r.stop === "refusal") return json({ cards: [], model: r.model, ms: Date.now() - t0, error: "the model declined this one" });
    const parsed = parseJson(r.text);
    const cards: any[] = [];
    for (const raw of Array.isArray(parsed?.cards) ? parsed.cards.slice(0, 2) : []) {
      const v = validateCard({ ...raw, type: "SUGGEST" });
      if (v.ok && v.card && !isDuplicate(v.card, shown) && !isDuplicate(v.card, cards)) cards.push({ ...v.card, lane: "deep", stage });
    }
    return json({ cards, model: r.model, ms: Date.now() - t0, cache: r.cache });
  } catch (e: any) {
    return json({ cards: [], error: String(e?.message || e).slice(0, 300) }, 502);
  }
};

export const config: Config = { path: "/:room/api/steer" };
