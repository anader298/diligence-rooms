// feeds (slow lane, after the sweep): what the person writes and posts, from the RSS/Atom feeds of
// accounts already tied to them. Medium, Substack and WordPress feeds by handle; a personal site
// named on a confirmed profile (feed found by <link rel="alternate">, then /feed and /index.xml);
// and the channel feed of a confirmed YouTube account (last 15 videos → voice.talks).
// Rows carry the post date, so the dossier can show what they wrote about lately.

import { platformOf, hostOf, isBlocked, pool } from "../person-lib.mjs";
import { parseFeed } from "../xml.mjs";

/** Feed URLs for an account, by platform. */
export function feedUrlsFor(a) {
  const h = a.handle;
  if (a.site === "medium" && h) return [`https://medium.com/feed/@${h}`];
  if (a.site === "substack" && h) return [`https://${h}.substack.com/feed`];
  if (a.site === "wordpress" && h) return [`https://${h}.wordpress.com/feed/`];
  return [];
}

/** <link rel="alternate" type="application/rss+xml|atom+xml" href> on a page, made absolute. */
export function discoverFeed(html, base) {
  for (const m of String(html || "").matchAll(/<link\s[^>]*>/gi)) {
    const t = m[0];
    if (!/rel=["']alternate["']/i.test(t) || !/type=["']application\/(rss|atom)\+xml["']/i.test(t)) continue;
    const href = t.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try {
      return new URL(href, base).href;
    } catch {
      continue;
    }
  }
  return null;
}

/** A YouTube channel id from a channel page. */
export const channelIdFrom = (html) => String(html || "").match(/"(?:channelId|externalId)":"(UC[\w-]{22})"/)?.[1] || String(html || "").match(/channel\/(UC[\w-]{22})/)?.[1] || null;

export default {
  id: "feeds",
  /** The ledger variables this module fills (config/form buckets read them to say "no tool yet"). */
  vars: ["voice.writing", "voice.talks"],
  label: "Blog and video feeds of confirmed accounts (Medium, Substack, WordPress, personal site, YouTube)",
  lane: "slow",
  needs: ["name"],
  budgetMs: 15000,
  async run(ctx) {
    const { subject, http, shared } = ctx;
    const company = String(subject.domain || "").toLowerCase().replace(/^www\./, "");
    const tied = (shared.accounts || []).filter((a) => a.confirmed || a.source === "given");
    const jobs = [];
    for (const a of tied) for (const u of feedUrlsFor(a)) jobs.push({ a, url: u, kind: "blog" });
    const sites = [...new Set(tied.flatMap((a) => [a.blog, a.extra?.blog, a.extra?.website]).filter(Boolean).map((u) => (/^https?:/i.test(u) ? u : `https://${u}`)))].filter((u) => {
      const h = hostOf(u);
      return h && !platformOf(u) && !(company && (h === company || h.endsWith("." + company)));
    }).slice(0, 2);
    const yts = tied.filter((a) => a.site === "youtube" && a.handle).slice(0, 2);
    if (!jobs.length && !sites.length && !yts.length) return ctx.miss("voice.writing", "feeds: no confirmed Medium, Substack, WordPress, personal-site or YouTube account to read");
    // a personal site: find its feed first
    await Promise.all(sites.map(async (u) => {
      const r = await http.get(u, { timeout: 6000 });
      const f = r.ok ? discoverFeed(r.text, r.url || u) : null;
      const a = tied.find((x) => [x.blog, x.extra?.blog, x.extra?.website].some((b) => b && hostOf(/^https?:/.test(b) ? b : `https://${b}`) === hostOf(u)));
      if (f) jobs.push({ a, url: f, kind: "blog", site: u });
      else for (const p of ["/feed", "/index.xml"]) jobs.push({ a, url: new URL(p, u).href, kind: "blog", site: u, guess: true });
    }));
    await Promise.all(yts.map(async (a) => {
      const r = await http.get(`https://www.youtube.com/@${a.handle}`, { timeout: 6000 });
      const id = r.ok ? channelIdFrom(r.text) : null;
      if (id) jobs.push({ a, url: `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`, kind: "video" });
    }));
    let n = 0;
    const seenSite = new Set();
    const got = await pool(jobs, 6, async (j) => ({ j, r: await http.get(j.url, { timeout: 6000 }) }));
    for (const { j, r } of got.filter((x) => x?.r)) {
      if (j.guess && seenSite.has(j.site)) continue;
      if (!r.ok || isBlocked(r) || !/<(rss|feed)[\s>]/i.test(r.text || "")) continue;
      if (j.site) seenSite.add(j.site);
      const f = parseFeed(r.text);
      if (!f.items.length) continue;
      n++;
      const grade = j.a && (j.a.source === "given" || (j.a.anchors || []).includes("company")) ? "p" : "w";
      const v = j.kind === "video" ? "voice.talks" : "voice.writing";
      const who = j.a ? `${j.a.site} @${j.a.handle}` : hostOf(j.url);
      for (const it of f.items.slice(0, 8)) ctx.add({ var: v, value: `${it.title || "(untitled)"}${it.date ? ` (${it.date})` : ""} — ${f.title || who}`, url: it.url || j.url, grade, tier: "A", date: it.date, anchors: j.a?.anchors || [], detail: { feed: j.url, account: who, summary: it.summary } });
      const dates = f.items.map((i) => i.date).filter(Boolean).sort();
      ctx.add({ var: v, value: `${f.title || who}: ${f.items.length} item(s) in the feed${dates.length ? `, ${dates[0]} to ${dates.at(-1)}` : ""}`, url: j.url, grade, tier: "A", date: dates.at(-1) || null, anchors: j.a?.anchors || [], detail: { feed: j.url, account: who, count: f.items.length } });
    }
    // a 404 is an answer (no feed there); no answer at all is "couldn't check"
    const answered = got.some((x) => x?.r && (x.r.ok || x.r.status === 404));
    if (!n) ctx.miss("voice.writing", `feeds: none readable at ${jobs.map((j) => j.url).join(", ")}${answered ? "" : "; no feed answered, not checked"}`, { blocked: !answered });
  },
};
