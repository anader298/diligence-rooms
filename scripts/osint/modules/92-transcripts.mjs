// transcripts (heavy, opt-in: --transcribe, or --heavy transcripts for captions only). Captions of
// the talks and interviews the other modules found (YouTube URLs among voice.talks rows and
// shared.talks, plus any YouTube URL passed with --articles), read by youtube-transcript-api in a
// Python sidecar (scripts/osint/py/transcript.py). With --transcribe, podcast audio found by the
// media modules is also transcribed on CPU by faster-whisper (about 4 min per audio hour, so at
// most two episodes, the first hour each). Audio URLs can also be given with --articles. Output: what was said, top terms, company mentions.

import { runSidecar, depMiss } from "../sidecar.mjs";
import { UA } from "../core.mjs";
import { topTerms, companyIn } from "../person-lib.mjs";

/** YouTube video id from a URL, or null. */
export function videoId(url) {
  const s = String(url || "");
  const m = s.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

/** Videos and audio to transcribe, from the ledger, shared.talks and --articles. */
export function mediaOf(rows = [], shared = {}, opts = {}) {
  const vids = new Map();
  const audio = new Map();
  for (const r of rows) {
    if (!["voice.talks", "voice.quotes", "news.articles"].includes(r.var)) continue;
    const id = videoId(r.url);
    if (id && !vids.has(id)) vids.set(id, { id, title: String(r.value).split(" — ")[0].slice(0, 160), url: r.url, ref: r.id, date: r.date || null });
    const au = r.detail?.audio || r.detail?.episodeUrl || r.detail?.enclosure || (/\.(mp3|m4a|aac|ogg)(\?|$)/i.test(r.url || "") ? r.url : null);
    if (au && r.var === "voice.talks" && !audio.has(au)) audio.set(au, { url: au, title: String(r.value).slice(0, 160), page: r.url, ref: r.id, date: r.date || null });
  }
  for (const t of shared.talks || []) {
    const id = videoId(t.url);
    if (id && !vids.has(id)) vids.set(id, { id, title: t.title, url: t.url, date: t.date || null });
  }
  for (const u of opts.articles || []) {
    const id = videoId(u);
    if (id && !vids.has(id)) vids.set(id, { id, title: u, url: u, given: true });
    else if (/\.(mp3|m4a|aac|ogg|wav)(\?|$)/i.test(u) && !audio.has(u)) audio.set(u, { url: u, title: u, page: u, given: true });
  }
  return { videos: [...vids.values()].slice(0, 6), audio: [...audio.values()].slice(0, 2) };
}

// spoken filler that tops every caption track
const FILLER = new Set("right really think going like sort mean know yeah okay well kind actually things thing want look people gonna lot little bit maybe some even every take make made said says something stuff whole much many back come came could would should because being where there their them those".split(" "));

/** Summary of one transcript: words, minutes, company mentions with their timestamps, top terms. */
export function summarize(segments, subject) {
  const text = segments.map((s) => s[1]).join(" ").replace(/\s+/g, " ").trim();
  const hits = subject.company || subject.domain ? segments.filter((s) => companyIn(s[1], subject)) : [];
  const end = segments.length ? segments.at(-1)[0] : 0;
  return {
    words: text ? text.split(" ").length : 0,
    minutes: Math.round(end / 60),
    companyMentions: hits.length,
    mentionAt: hits.slice(0, 8).map((s) => ({ t: s[0], text: s[1].slice(0, 160) })),
    terms: topTerms([text], 30).map(([w]) => w).filter((w) => !FILLER.has(w)).slice(0, 10),
    text: text.slice(0, 40000),
  };
}

const ts = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

export default {
  id: "transcripts",
  label: "Talk and podcast transcripts (opt-in: --transcribe)",
  lane: "heavy",
  flag: "--transcribe",
  needs: ["name"],
  deps: { python: ["youtube_transcript_api"], extra: { faster_whisper: "podcast audio with --transcribe" } },
  budgetMs: 240000,
  async run(ctx) {
    const { subject, shared, opts = {} } = ctx;
    const { videos, audio } = mediaOf(ctx.rows || [], shared, opts);
    const whisper = !!opts.transcribe && audio.length > 0;
    if (!videos.length && !whisper) return ctx.miss("voice.transcripts", `transcripts not run: no YouTube talks found by the talk modules${audio.length ? " (podcast audio needs --transcribe)" : ""}`);
    const r = await runSidecar("transcript", { videos: videos.map((v) => ({ id: v.id })), audio: whisper ? audio.map((a) => ({ url: a.url })) : [], whisper, whisper_model: ctx.env.OSINT_WHISPER_MODEL || "base.en", max_audio_seconds: 3600, user_agent: UA }, { timeoutMs: whisper ? 230000 : 60000, env: ctx.env });
    if (r.missing) return depMiss(ctx, "voice.transcripts", "transcripts", r.missing, null, ["youtube_transcript_api", ...(whisper ? ["faster_whisper"] : [])]);
    if (!r.ok) {
      ctx.status("error", `sidecar: ${r.error}`);
      return ctx.miss("voice.transcripts", `transcripts not run: sidecar failed (${r.error})`);
    }
    const byId = new Map(videos.map((v) => [v.id, v]));
    let blocked = 0;
    for (const t of r.data.videos || []) {
      const v = byId.get(t.id);
      if (t.error || !t.segments?.length) {
        if (/RequestBlocked|IpBlocked|TooManyRequests/i.test(t.error || "")) blocked++;
        ctx.miss("voice.transcripts", `YouTube captions for "${v?.title || t.id}": ${t.error ? (/RequestBlocked|IpBlocked|TooManyRequests/i.test(t.error) ? `blocked (${t.error.split(":")[0]}), unknown` : `none (${t.error.split(":")[0]})`) : "empty"}`);
        continue;
      }
      const s = summarize(t.segments, subject);
      ctx.add({
        var: "voice.transcripts",
        value: `${v?.title || t.id}: ${s.minutes} min, ${s.words.toLocaleString()} words of ${t.generated ? "auto-generated" : "published"} captions${s.companyMentions ? `; ${subject.company} at ${s.mentionAt.map((m) => ts(m.t)).slice(0, 5).join(", ")}` : ""}; terms: ${s.terms.join(", ")}`,
        url: v?.url || `https://www.youtube.com/watch?v=${t.id}`,
        date: v?.date || null,
        // the talk itself was graded by the module that found it; the captions add what was said
        grade: "w",
        tier: "C",
        anchors: v?.ref ? [v.ref] : [],
        detail: { source: "youtube captions", language: t.language, generated: t.generated, ...s },
      });
    }
    for (const a of r.data.audio || []) {
      const m = audio.find((x) => x.url === a.url);
      if (a.error || !a.segments?.length) {
        if (a.error) ctx.status("partial", `Whisper: ${a.error.slice(0, 120)}`);
        ctx.miss("voice.transcripts", `Whisper on "${m?.title || a.url}": ${a.error ? `not run (${a.error.slice(0, 160)}), unknown` : "no speech"}`);
        continue;
      }
      const s = summarize(a.segments, subject);
      ctx.add({ var: "voice.transcripts", value: `${m?.title || a.url}: ${s.minutes} min transcribed by Whisper (a lead: re-check quotes against the audio)${s.companyMentions ? `; ${subject.company} at ${s.mentionAt.map((x) => ts(x.t)).slice(0, 5).join(", ")}` : ""}; terms: ${s.terms.join(", ")}`, url: m?.page || a.url, date: m?.date || null, grade: "w", tier: "D", anchors: m?.ref ? [m.ref] : [], detail: { source: "faster-whisper", model: ctx.env.OSINT_WHISPER_MODEL || "base.en", audio: a.url, ...s } });
    }
    if (blocked && blocked === (r.data.videos || []).length) ctx.status("blocked", "YouTube refused the caption requests");
    else if (audio.length && !opts.transcribe) ctx.miss("voice.transcripts", `${audio.length} podcast episode(s) not transcribed: add --transcribe (Whisper on CPU, about 4 min per audio hour)`);
  },
};
