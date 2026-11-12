// Live helper, step 1: turn an 8-second audio chunk from the phone into text.
// The page falls back to the browser's own speech recognition if this fails.
// A new line per speaker: the phone treats each line break as a voice turn.
import type { Config } from "@netlify/functions";
import { GoogleGenAI } from "@google/genai";
import { json, loadCorpus } from "./_assist.ts";

export default async (req: Request, context: any) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const { audio, mime = "audio/mp4" } = await req.json();
  if (!audio) return json({ error: "no audio" }, 400);
  // Names and terms from the room help the transcriber spell them right.
  let vocab = "";
  try {
    const c = loadCorpus(context.params.room);
    vocab = [...(c.people || []).map((p) => p.name), ...(c.personas || []).map((p) => p.name), ...c.entries.map((e) => e.title)].join(", ").slice(0, 800);
  } catch {}
  const t0 = Date.now();
  try {
    const ai = new GoogleGenAI({});
    const r = await ai.models.generateContent({
      model: process.env.ASSIST_STT_MODEL || "gemini-2.5-flash",
      contents: [{ role: "user", parts: [
        { text: "Transcribe this audio verbatim in English. Output only the spoken words. Start each new speaker on a new line. Terms that may appear: " + vocab },
        { inlineData: { mimeType: mime, data: audio } },
      ] }],
    });
    return json({ text: (r.text || "").trim(), ms: Date.now() - t0 });
  } catch (e: any) {
    return json({ error: "transcription failed: " + String(e?.message || e).slice(0, 200) }, 502);
  }
};

export const config: Config = { path: "/:room/api/transcribe" };
