// Talks and interviews on YouTube: one search page for the name with the employer, read from the
// ytInitialData blob the page carries (no key). A video counts only when its title, description
// snippet or channel names the subject (words adjacent) and the company: a namesake's wrestling
// match or a fan edit called "Steve & Ferrante" never does.

import { nameMatch, companyIn, isBlocked, blockedMiss, normName } from "../person-lib.mjs";

const CAP = 8;

/** Every videoRenderer in a YouTube results page, flattened. */
export function parseYouTubeResults(html) {
  const m = String(html || "").match(/var ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/) || String(html || "").match(/ytInitialData"\]\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return null;
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const out = [];
  const runs = (x) => (x?.runs || []).map((r) => r.text).join("") || x?.simpleText || "";
  (function walk(o, depth) {
    if (!o || typeof o !== "object" || depth > 40) return;
    if (o.videoRenderer) {
      const v = o.videoRenderer;
      out.push({
        id: v.videoId,
        title: runs(v.title),
        channel: runs(v.ownerText) || runs(v.longBylineText),
        published: runs(v.publishedTimeText),
        length: runs(v.lengthText),
        views: runs(v.viewCountText),
        snippet: [...(v.detailedMetadataSnippets || []).map((s) => runs(s.snippetText)), runs(v.descriptionSnippet)].filter(Boolean).join(" "),
      });
      return;
    }
    for (const k in o) walk(o[k], depth + 1);
  })(data, 0);
  return out.filter((v) => v.id && v.title);
}

/** "2y ago", "8 months ago", "3 weeks ago" -> approximate YYYY-MM-DD (relative to now). */
export function approxDate(rel, now = Date.now()) {
  const m = String(rel || "").match(/(\d+)\s*(y|year|mo|month|w|week|d|day|h|hour|min|minute)s?\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const day = 864e5;
  const ms = unit.startsWith("y") ? n * 365 * day : unit.startsWith("mo") ? n * 30 * day : unit.startsWith("w") ? n * 7 * day : unit.startsWith("d") ? n * day : 0;
  return new Date(now - ms).toISOString().slice(0, 10);
}

export default {
  id: "talks",
  /** The ledger variables this module fills (config/form buckets read them to say "no tool yet"). */
  vars: ["voice.talks"],
  label: "Talks and interviews on YouTube",
  lane: "fast",
  needs: ["name"],
  budgetMs: 15000,
  async run(ctx) {
    const { subject, http, shared } = ctx;
    const q = `"${subject.name}"${subject.company ? ` ${subject.company}` : ""}`;
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&hl=en&gl=US`;
    const r = await http.get(url, { timeout: 12000, headers: { cookie: "CONSENT=YES+1" } });
    const vids = r.ok ? parseYouTubeResults(r.text) : null;
    if (!vids) {
      if (!r.ok || isBlocked(r)) blockedMiss(ctx, "voice.talks", "YouTube search", r, "retry in a few minutes");
      else ctx.miss("voice.talks", "YouTube search: page had no result data (layout changed?), unknown", { blocked: true });
      return;
    }
    const talks = (shared.talks ||= []);
    let n = 0;
    const seen = new Set();
    for (const v of vids) {
      if (n >= CAP) break;
      const text = `${v.title} ${v.snippet} ${v.channel}`;
      if (!nameMatch(text, subject)) continue;
      const co = companyIn(text, subject);
      if (!co) continue; // the name alone on YouTube is a namesake more often than not
      const k = normName(v.title).slice(0, 60);
      if (seen.has(k)) continue;
      seen.add(k);
      const date = approxDate(v.published);
      talks.push({ ...v, url: `https://www.youtube.com/watch?v=${v.id}`, date });
      ctx.add({
        var: "voice.talks",
        value: `${v.title} — ${v.channel || "YouTube"}${v.published ? `, ${v.published.replace(/^Streamed /, "")}` : ""}${v.length ? `, ${v.length}` : ""}`,
        url: `https://www.youtube.com/watch?v=${v.id}`,
        date,
        grade: nameMatch(v.title, subject) ? "p" : "w",
        tier: "C",
        anchors: ["name", "company"],
        detail: { channel: v.channel, published: v.published, approxDate: date, length: v.length, views: v.views, snippet: v.snippet.slice(0, 240), engine: "youtube" },
      });
      n++;
    }
    if (!n) ctx.miss("voice.talks", `YouTube: ${vids.length} videos for ${q}, none naming ${subject.name} with ${subject.company || "the company"}`);
  },
};
