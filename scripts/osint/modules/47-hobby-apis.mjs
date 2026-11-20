// hobby-apis (slow lane, after the sweep): what the person does for fun, from public APIs keyed by
// a given or confirmed handle. Discogs (record collection; 25 calls a minute, User-Agent needed),
// Letterboxd RSS (films watched, ratings, dates → hobby.media) and chess.com ratings
// (→ hobby.games). The chess.com and Lichess profiles themselves are found by the sweep.
// A profile counts when its name matches the person or the handle was given.

import { nameMatch, isBlocked, blockedMiss } from "../person-lib.mjs";
import { parseFeed } from "../xml.mjs";
import { makeAccount, pushAccount } from "./40-actor-search.mjs";

/** Letterboxd RSS → { name, films: [{ title, year, watched, rating, rewatch, url }] }. */
export function letterboxdFeed(xml) {
  const f = parseFeed(xml);
  if (!f.title || !/Letterboxd/i.test(f.title)) return null;
  const films = f.items.filter((i) => i.extra?.["letterboxd:filmTitle"]).map((i) => ({ title: i.extra["letterboxd:filmTitle"], year: i.extra["letterboxd:filmYear"] || null, watched: i.extra["letterboxd:watchedDate"] || i.date, rating: i.extra["letterboxd:memberRating"] ? Number(i.extra["letterboxd:memberRating"]) : null, rewatch: i.extra["letterboxd:rewatch"] === "Yes", url: i.url }));
  return { name: f.title.replace(/^Letterboxd\s*-\s*/i, "").trim(), films };
}

/** chess.com stats → [{ kind, rating, best }] for the formats played. */
export function chessRatings(stats) {
  const out = [];
  for (const [k, v] of Object.entries(stats || {})) {
    if (!/^chess/.test(k) || !v?.last?.rating) continue;
    out.push({ kind: k.replace(/^chess_?/, "").replace("960_daily", "960 daily") || k, rating: v.last.rating, best: v.best?.rating ?? null, games: v.record ? (v.record.win || 0) + (v.record.loss || 0) + (v.record.draw || 0) : null, last: v.last.date ? new Date(v.last.date * 1000).toISOString().slice(0, 10) : null });
  }
  if (stats?.fide) out.push({ kind: "FIDE (self-reported)", rating: stats.fide, best: null, games: null, last: null });
  return out;
}

export default {
  id: "hobby-apis",
  /** The ledger variables this module fills (config/form buckets read them to say "no tool yet"). */
  vars: ["hobby.media", "hobby.games"],
  label: "Hobby APIs (Discogs, Letterboxd, chess.com ratings)",
  lane: "slow",
  needs: ["name"],
  budgetMs: 12000,
  async run(ctx) {
    const { subject, http, shared } = ctx;
    const given = (subject.handles || []).map((h) => h.replace(/^@/, "").toLowerCase());
    const accts = shared.accounts || [];
    const conf = accts.filter((a) => a.confirmed && a.handle && /^[a-z0-9_.-]{2,40}$/i.test(a.handle)).map((a) => a.handle.toLowerCase());
    const handles = [...new Set([...given, ...conf])].slice(0, 4);
    const chess = [...new Set([...accts.filter((a) => a.site === "chess.com" && (a.confirmed || a.source === "given")).map((a) => a.handle.toLowerCase()), ...given])].slice(0, 3);
    if (!handles.length) return ctx.miss("hobby.media", "hobby APIs: no given or confirmed handle to look up (Discogs, Letterboxd, chess.com)");
    const ok = (h, name) => given.includes(h) || nameMatch(name || "", subject);
    let n = 0;
    const [dc, lb, ch] = await Promise.all([
      Promise.all(handles.slice(0, 3).map(async (h) => ({ h, r: await http.json(`https://api.discogs.com/users/${encodeURIComponent(h)}`, { timeout: 6000 }) }))),
      Promise.all(handles.map(async (h) => ({ h, r: await http.get(`https://letterboxd.com/${encodeURIComponent(h)}/rss/`, { timeout: 6000 }) }))),
      Promise.all(chess.map(async (h) => ({ h, r: await http.json(`https://api.chess.com/pub/player/${encodeURIComponent(h)}/stats`, { timeout: 6000 }) }))),
    ]);
    for (const { h, r } of dc) {
      if (isBlocked(r) && r.status !== 404) blockedMiss(ctx, "hobby.media", "Discogs", r, "retry in a minute (25 calls a minute)", { partial: true });
      const d = r.ok ? r.data : null;
      if (!d?.username || !ok(h, d.name)) continue;
      n++;
      pushAccount(shared, makeAccount({ site: "discogs", handle: d.username, url: d.uri || `https://www.discogs.com/user/${d.username}`, name: d.name || null, location: d.location || null, avatar: d.avatar_url || null, blog: d.home_page || null, bio: d.profile || null, source: given.includes(h) ? "given" : "hobby", extra: { registered: d.registered } }, subject, shared));
      ctx.add({ var: "hobby.media", value: `Discogs @${d.username}${d.name ? ` (${d.name})` : ""}: ${d.num_collection ?? 0} records in collection, ${d.num_wantlist ?? 0} on wantlist${d.location ? `, ${d.location}` : ""}; joined ${String(d.registered || "").slice(0, 10)}`, url: d.uri || `https://www.discogs.com/user/${d.username}`, grade: given.includes(h) && nameMatch(d.name || "", subject) ? "p" : "w", tier: "B", date: String(d.registered || "").slice(0, 10) || null, detail: { site: "discogs", collection: d.num_collection, wantlist: d.num_wantlist, location: d.location, homePage: d.home_page } });
    }
    for (const { h, r } of lb) {
      const f = r.ok ? letterboxdFeed(r.text) : null;
      if (!f || !ok(h, f.name)) continue;
      n++;
      pushAccount(shared, makeAccount({ site: "letterboxd", handle: h, url: `https://letterboxd.com/${h}/`, name: f.name, source: given.includes(h) ? "given" : "hobby" }, subject, shared));
      const rated = f.films.filter((x) => x.rating != null);
      const avg = rated.length ? (rated.reduce((a, x) => a + x.rating, 0) / rated.length).toFixed(1) : null;
      ctx.add({ var: "hobby.media", value: `Letterboxd @${h} (${f.name}): ${f.films.length} recent film(s)${f.films[0] ? `, latest ${f.films[0].title}${f.films[0].year ? ` (${f.films[0].year})` : ""} on ${f.films[0].watched}` : ""}${avg ? `; average rating ${avg}/5` : ""}; e.g. ${f.films.slice(0, 6).map((x) => x.title).join(", ")}`, url: `https://letterboxd.com/${h}/`, grade: given.includes(h) && nameMatch(f.name, subject) ? "p" : "w", tier: "B", date: f.films[0]?.watched || null, detail: { site: "letterboxd", films: f.films.slice(0, 20) } });
    }
    for (const { h, r } of ch) {
      const rs = r.ok ? chessRatings(r.data) : [];
      if (!rs.length) continue;
      n++;
      const acc = accts.find((a) => a.site === "chess.com" && a.handle.toLowerCase() === h);
      ctx.add({ var: "hobby.games", value: `chess.com @${h}: ${rs.map((x) => `${x.kind} ${x.rating}${x.best ? ` (best ${x.best})` : ""}`).join(", ")}`, url: `https://www.chess.com/member/${h}`, grade: given.includes(h) || (acc?.anchors || []).length > 1 ? "p" : "w", tier: "B", date: rs.map((x) => x.last).filter(Boolean).sort().at(-1) || null, detail: { site: "chess.com", ratings: rs } });
    }
    // no site answered at all (every call failed): "couldn't check", not "nothing found"
    const answered = [...dc, ...lb, ...ch].some(({ r }) => r.ok || r.status === 404);
    if (!n) ctx.miss("hobby.media", `Discogs, Letterboxd${chess.length ? ", chess.com" : ""}: nothing under ${handles.join(", ")} that names ${subject.name}${answered ? "" : "; no site answered, not checked"}`, { blocked: !answered });
  },
};
