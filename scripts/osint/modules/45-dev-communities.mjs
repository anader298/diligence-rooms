// dev-communities (slow lane, so the sweep's Hacker News accounts are known):
// - Stack Exchange 2.3 users?inname on Stack Overflow: accounts whose display name matches go into
//   the candidate list (scored by the identity module). 300 calls a day without STACKEXCHANGE_KEY.
//   Content is CC BY-SA; the terms note travels in the row detail.
// - Hacker News (Algolia): profile "about", karma and the latest comments for a given or confirmed
//   HN handle → social.dev_activity. (Mentions of the name on HN are the existing `hn` module.)

import { nameMatch, stripTags, topTerms, isBlocked, blockedMiss } from "../person-lib.mjs";
import { makeAccount, pushAccount } from "./40-actor-search.mjs";

/** Stack Exchange users whose display name matches the subject. */
export function seMatches(json, subject) {
  return (json?.items || []).filter((u) => nameMatch(stripTags(u.display_name || ""), subject)).map((u) => ({
    site: "stackoverflow",
    handle: String(u.user_id),
    url: u.link,
    name: stripTags(u.display_name),
    location: u.location ? stripTags(u.location) : null,
    avatar: u.profile_image || null,
    blog: u.website_url || null,
    extra: { reputation: u.reputation, created: u.creation_date ? new Date(u.creation_date * 1000).toISOString().slice(0, 10) : null, lastSeen: u.last_access_date ? new Date(u.last_access_date * 1000).toISOString().slice(0, 10) : null, website: u.website_url || null },
  }));
}

/** Summary of an HN user's recent comments from Algolia search_by_date. */
export function hnActivity(user, comments) {
  const hits = comments?.hits || [];
  const dates = hits.map((h) => String(h.created_at || "").slice(0, 10)).filter(Boolean).sort();
  const threads = [...new Set(hits.map((h) => h.story_title).filter(Boolean))].slice(0, 5);
  const terms = topTerms(hits.map((h) => stripTags(h.comment_text || "")), 8);
  return { about: stripTags(user?.about || "") || null, karma: user?.karma ?? null, count: comments?.nbHits ?? hits.length, first: dates[0] || null, last: dates.at(-1) || null, threads, terms };
}

export default {
  id: "dev-communities",
  label: "Developer communities (Stack Overflow, Hacker News activity)",
  lane: "slow",
  needs: ["name"],
  env: ["STACKEXCHANGE_KEY"],
  budgetMs: 14000,
  async run(ctx) {
    const { subject, http, shared, env } = ctx;
    const key = env.STACKEXCHANGE_KEY ? `&key=${env.STACKEXCHANGE_KEY}` : "";
    const given = (subject.handles || []).map((h) => h.replace(/^@/, ""));
    const hnAccts = (shared.accounts || []).filter((a) => a.site === "hackernews" && (a.confirmed || a.source === "given" || (a.anchors || []).length > 1));
    const hn = [...new Map([...hnAccts.map((a) => [a.handle.toLowerCase(), { handle: a.handle, acct: a }]), ...given.map((h) => [h.toLowerCase(), { handle: h, acct: null, given: true }])]).values()].slice(0, 3);
    const [se, ...hnRes] = await Promise.all([
      http.json(`https://api.stackexchange.com/2.3/users?inname=${encodeURIComponent(subject.name)}&site=stackoverflow&pagesize=20&order=desc&sort=reputation${key}`, { timeout: 6000 }),
      // Algolia usually answers in 0.2-0.3 s but was measured at 7 s on 20 Nov 2026: both calls at once
      ...hn.map(async (x) => {
        const [u, c] = await Promise.all([
          http.json(`https://hn.algolia.com/api/v1/users/${encodeURIComponent(x.handle)}`, { timeout: 9000 }),
          http.json(`https://hn.algolia.com/api/v1/search_by_date?tags=comment,author_${encodeURIComponent(x.handle)}&hitsPerPage=30`, { timeout: 9000 }),
        ]);
        return { x, u, c };
      }),
    ]);
    if (se.ok) {
      const m = seMatches(se.data, subject);
      for (const a of m) pushAccount(shared, makeAccount({ ...a, source: "name-search", extra: { ...a.extra, terms: "Stack Exchange content is CC BY-SA" } }, subject, shared));
      if (!m.length) ctx.miss("social.accounts", `Stack Overflow user search "${subject.name}": no display name matches (${(se.data?.items || []).length} users returned)`);
    } else if (isBlocked(se) || se.status === 400) blockedMiss(ctx, "social.accounts", "Stack Exchange API", se, env.STACKEXCHANGE_KEY ? "daily quota used; retry tomorrow" : "set STACKEXCHANGE_KEY (free, 10,000 a day)", { partial: true });
    for (const { x, u, c } of hnRes) {
      if (!u.ok && u.status !== 404) blockedMiss(ctx, "social.dev_activity", `Hacker News (Algolia) @${x.handle}`, u, "retry later", { partial: true });
      if (!u.ok || !u.data?.username) continue;
      const a = hnActivity(u.data, c.ok ? c.data : null);
      const anchored = x.given || (x.acct?.anchors || []).includes("company");
      ctx.add({
        var: "social.dev_activity",
        value: `Hacker News @${u.data.username}: karma ${a.karma ?? "?"}, ${a.count} comment(s)${a.last ? `, latest ${a.last}` : ""}${a.about ? `; about: "${a.about.slice(0, 140)}"` : ""}${a.threads.length ? `; recent threads: ${a.threads.slice(0, 3).join(" | ")}` : ""}${a.terms.length ? `; words: ${a.terms.join(", ")}` : ""}`,
        url: `https://news.ycombinator.com/user?id=${u.data.username}`,
        grade: anchored ? "p" : "w",
        tier: "B",
        date: a.last,
        anchors: x.given ? ["given"] : x.acct?.anchors || [],
        detail: { ...a, handle: u.data.username, source: x.given ? "given" : `sweep (${(x.acct?.anchors || []).join(", ") || "name"})` },
      });
    }
    if (!hn.length) ctx.miss("social.dev_activity", "Hacker News activity: no given or confirmed HN handle to read");
  },
};
