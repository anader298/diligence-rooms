// media-feeds: podcast episodes where the person is a guest or host. iTunes Search (no key) for
// episodes whose title or description names the person; Podcast Index search/byperson (person
// tags plus text) with PODCASTINDEX_API_KEY and PODCASTINDEX_API_SECRET (free; HMAC-style SHA-1
// auth headers). An episode that also names the company is graded p; the name alone is w (a
// namesake is possible). The YouTube channel feed of a confirmed account is read by `feeds`.

import { createHash } from "node:crypto";
import { nameMatch, companyIn, stripTags, isBlocked, blockedMiss } from "../person-lib.mjs";

/** iTunes podcastEpisode results that name the subject. */
export function itunesEpisodes(json, subject) {
  return (json?.results || []).filter((e) => e.kind === "podcast-episode" || e.wrapperType === "podcastEpisode").map((e) => {
    const text = `${e.trackName || ""} ${stripTags(e.description || e.shortDescription || "")}`;
    return { show: e.collectionName, title: e.trackName, date: String(e.releaseDate || "").slice(0, 10) || null, url: e.trackViewUrl || e.collectionViewUrl, audio: e.episodeUrl || null, minutes: e.trackTimeMillis ? Math.round(e.trackTimeMillis / 60000) : null, named: nameMatch(text, subject), company: companyIn(text, subject), snippet: stripTags(e.shortDescription || e.description || "").slice(0, 240) };
  }).filter((e) => e.named);
}

/** Podcast Index auth headers for a key, secret and unix time. */
export function podcastIndexHeaders(key, secret, now = Math.floor(Date.now() / 1000)) {
  return { "X-Auth-Key": key, "X-Auth-Date": String(now), Authorization: createHash("sha1").update(key + secret + now).digest("hex"), "user-agent": "diligence-rooms osint" };
}

/** Podcast Index byperson items that name the subject. */
export function podcastIndexEpisodes(json, subject) {
  return (json?.items || []).map((e) => {
    const text = `${e.title || ""} ${stripTags(e.description || "")} ${(e.persons || []).map((p) => p.name).join(" ")}`;
    return { show: e.feedTitle, title: e.title, date: e.datePublished ? new Date(e.datePublished * 1000).toISOString().slice(0, 10) : null, url: e.link || e.feedUrl || null, audio: e.enclosureUrl || null, named: nameMatch(text, subject), company: companyIn(text, subject), role: (e.persons || []).find((p) => nameMatch(p.name, subject))?.role || null, snippet: stripTags(e.description || "").slice(0, 240) };
  }).filter((e) => e.named);
}

export default {
  id: "media-feeds",
  label: "Podcast appearances (iTunes, Podcast Index)",
  lane: "fast",
  needs: ["name"],
  env: ["PODCASTINDEX_API_KEY", "PODCASTINDEX_API_SECRET"],
  budgetMs: 10000,
  async run(ctx) {
    const { subject, http, env } = ctx;
    const term = encodeURIComponent(`"${subject.name}"`);
    const pi = env.PODCASTINDEX_API_KEY && env.PODCASTINDEX_API_SECRET;
    const [it, px] = await Promise.all([
      http.json(`https://itunes.apple.com/search?media=podcast&entity=podcastEpisode&term=${term}&limit=50`, { timeout: 7000 }),
      pi ? http.json(`https://api.podcastindex.org/api/1.0/search/byperson?q=${encodeURIComponent(subject.name)}&max=40`, { timeout: 7000, cache: false, headers: podcastIndexHeaders(env.PODCASTINDEX_API_KEY, env.PODCASTINDEX_API_SECRET) }) : null,
    ]);
    const eps = [];
    if (it.ok) eps.push(...itunesEpisodes(it.data, subject).map((e) => ({ ...e, src: "iTunes" })));
    else if (isBlocked(it)) blockedMiss(ctx, "voice.talks", "iTunes Search", it, "retry in a minute", { partial: true });
    if (px?.ok) eps.push(...podcastIndexEpisodes(px.data, subject).map((e) => ({ ...e, src: "Podcast Index" })));
    else if (px) blockedMiss(ctx, "voice.talks", "Podcast Index", px, "check PODCASTINDEX_API_KEY and PODCASTINDEX_API_SECRET", { partial: true });
    else ctx.miss("voice.talks", "Podcast Index: not checked (set PODCASTINDEX_API_KEY and PODCASTINDEX_API_SECRET, free at api.podcastindex.org)");
    // one row per episode (title + show), company-anchored first, newest first
    const seen = new Set();
    const uniq = eps.filter((e) => {
      const k = `${String(e.show).toLowerCase()}|${String(e.title).toLowerCase()}`;
      return !seen.has(k) && seen.add(k);
    }).sort((a, b) => Number(b.company) - Number(a.company) || String(b.date || "").localeCompare(String(a.date || "")));
    if (!uniq.length) return ctx.miss("voice.talks", `podcasts: no episode titled or described with "${subject.name}" (iTunes${pi ? ", Podcast Index" : ""})`);
    for (const e of uniq.slice(0, 12)) ctx.add({ var: "voice.talks", value: `Podcast: ${e.show} — "${e.title}"${e.date ? ` (${e.date})` : ""}${e.minutes ? `, ${e.minutes} min` : ""}${e.role ? `, ${e.role}` : ""}`, url: e.url, grade: e.company ? "p" : "w", tier: "B", date: e.date, anchors: ["name", ...(e.company ? ["company"] : [])], detail: e });
    if (uniq.length > 12) ctx.add({ var: "voice.talks", value: `${uniq.length} podcast episodes name ${subject.name} (${uniq.filter((e) => e.company).length} also name ${subject.company || "the company"}); 12 listed`, url: `https://podcasts.apple.com/us/search?term=${term}`, grade: uniq.some((e) => e.company) ? "p" : "w", tier: "B", detail: { total: uniq.length, shows: [...new Set(uniq.map((e) => e.show))].slice(0, 20) } });
  },
};
