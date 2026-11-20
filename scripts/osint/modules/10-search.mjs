// Web search for the person: ~15 query variants (profiles on each network, talks, obituary and
// wedding leads, race results, boards), most valuable first, inside a fixed time budget.
//
// Engines, in order of preference:
//   1. Brave Search API when BRAVE_API_KEY is set (fast, honours site: and quotes).
//   2. DuckDuckGo html (honours site:), one call per 3 s; on a 202 or anomaly page it stops.
//   3. Public SearXNG JSON instances for the site: queries DuckDuckGo did not get to.
//   4. Bing RSS in parallel for the plain-name queries (it ignores site: and quotes, so every
//      result is filtered by the name anyway).
// Every result is kept in shared.searchResults; rows are added only where the title or snippet
// names the person. Snippets are tier C: grade w, or p when the company or city also appears.

import { nameMatch, parseDdgHtml, ddgBlocked, parseBingRss, parseSearx, parseBrave, platformOf, handleFromUrl, hostOf, snippetGrade } from "../person-lib.mjs";

const SEARX = ["https://etsi.me/", "https://searx.dresden.network/", "https://www.isci.si/", "https://search.lumy.live/"];
const DEADLINE_MS = 27000;

/** Query plan: [query, kind]. kind "site" needs an engine that honours site:. */
export function queryPlan(subject) {
  const N = `"${subject.name}"`;
  const co = subject.company ? ` "${subject.company}"` : "";
  // DuckDuckGo works down this list in order (it blocks after a handful of calls, so the
  // most valuable site: queries go first); Bing RSS runs the "plain" ones in parallel.
  return [
    [`${N} site:linkedin.com/in`, "site"],
    [`${N}${co}`, "plain"],
    [`${N} site:instagram.com`, "site"],
    [`${N} site:x.com`, "site"],
    [`${N} site:facebook.com`, "site"],
    [`${N} site:youtube.com`, "site"],
    [`${N} site:github.com`, "site"],
    [`${N} site:strava.com`, "site"],
    [`${N} site:medium.com`, "site"],
    [`${N} site:substack.com`, "site"],
    [`${N} site:threads.net`, "site"],
    [`${N} site:podcasts.apple.com`, "site"],
    [`${N} podcast`, "plain"],
    [`${N} keynote`, "plain"],
    [`${N} obituary`, "plain"],
    [`${N} marathon results`, "plain"],
    [`${N} "board of directors"`, "plain"],
    [`${N} wedding`, "plain"],
    [`${N}`, "plain"],
  ];
}

const AGGREGATORS = /(^|\.)(theorg\.com|rocketreach\.co|zoominfo\.com|signalhire\.com|crunchbase\.com|apollo\.io|contactout\.com|lusha\.com|clustrmaps\.com|peoplelooker\.com|fastpeoplesearch\.com|truepeoplesearch\.com|spokeo\.com|radaris\.com|idcrawl\.com)$/;

/** Map one search result to a variable. Returns { var, kind } or null. */
export function classify(r, subject) {
  const text = `${r.title} ${r.snippet}`;
  const host = hostOf(r.url);
  const path = (() => {
    try {
      return new URL(r.url).pathname;
    } catch {
      return "";
    }
  })();
  const plat = platformOf(r.url);
  // A profile URL counts as his profile only when its title carries the name; a name that
  // appears only in the snippet is a "people also viewed" list on someone else's page.
  const titled = nameMatch(r.title, subject);
  if (plat === "strava" && /^\/athletes\/\d+/.test(path)) return titled ? { var: "social.accounts", kind: "profile", platform: "strava" } : { var: "news.articles", kind: "mention" };
  if (plat && handleFromUrl(r.url)) return titled ? { var: "social.accounts", kind: "profile", platform: plat, handle: handleFromUrl(r.url) } : { var: "news.articles", kind: "mention" };
  if (/podcasts\.apple\.com|open\.spotify\.com\/(episode|show)|podbean|buzzsprout|simplecast|libsyn|transistor\.fm|podchaser|listennotes/.test(host + path) || /\bpodcast|episode\b/i.test(text))
    return { var: "voice.talks", kind: "podcast" };
  if (/\b(keynote|webinar|panel(?:ist)?|fireside|summit|conference|speaker|speaks|session|interview)\b/i.test(text) || (host === "youtube.com" && path === "/watch"))
    return { var: "voice.talks", kind: "talk" };
  if ((host === "medium.com" && path.split("/").length > 2) || (/substack\.com$/.test(host) && path.startsWith("/p/"))) return { var: "voice.writing", kind: "post" };
  if (/legacy\.com|obituar|tributearchive|dignitymemorial|funeral/i.test(host + path + " " + r.title)) return { var: "family.close_circle", kind: "obituary" };
  if (/theknot\.com|zola\.com|weddingwire|minted\.com\/wedding|\bwedding\b/i.test(host + path + " " + r.title)) return { var: "family.partner", kind: "wedding" };
  if (/athlinks|runsignup|raceroster|ultrasignup|racewire|mychiptime|runraceresults|strava\.com\/activities|\bmarathon|triathlon|ironman|half marathon|5k\b/i.test(host + path + " " + text))
    return { var: "hobby.endurance", kind: "race" };
  if (/board of directors|board member|trustee|board of trustees|serves on the board|joins? (?:the )?board/i.test(text)) return { var: "cause.boards", kind: "board" };
  if (AGGREGATORS.test(host)) return { var: "career.timeline", kind: "profile-aggregator" };
  if (subject.domain && host.endsWith(subject.domain)) return { var: "career.timeline", kind: "company-site" };
  return { var: "news.articles", kind: "web" };
}

/** Weak family leads from obituary and wedding snippets. */
export function familyLeads(snippet) {
  const out = [];
  const s = String(snippet || "");
  const sp = s.match(/\b(?:survived by|husband of|wife of|married to|beloved (?:wife|husband) of|(?:his|her) (?:wife|husband|partner)(?: of \d+ years)?,?)\s+([A-Z][a-z]+(?: [A-Z]\.)?(?: [A-Z][a-z]+)?)/);
  if (sp) out.push({ var: "family.partner", value: sp[0] });
  const kids = s.match(/\b(?:children|sons?|daughters?|father of|mother of)\b[^.]{0,120}/i);
  if (kids) out.push({ var: "family.kids", value: kids[0] });
  return out;
}

export default {
  id: "search",
  label: "Web search (profiles, talks, races, boards, obituary and wedding leads)",
  lane: "fast",
  needs: ["name"],
  env: ["BRAVE_API_KEY"],
  budgetMs: 34000,
  async run(ctx) {
    const { subject, http, env, shared } = ctx;
    const t0 = Date.now();
    const plan = queryPlan(subject);
    const results = (shared.searchResults ||= []);
    const engineLog = [];
    const late = () => Date.now() - t0 > DEADLINE_MS;

    const keep = (q, engine, list) => {
      engineLog.push({ q, engine, n: list.length });
      for (const r of list) results.push({ ...r, q, engine });
      return list.length;
    };

    if (env.BRAVE_API_KEY) {
      for (const [q] of plan) {
        if (late()) break;
        let r = await http.json(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=20`, { headers: { "X-Subscription-Token": env.BRAVE_API_KEY }, timeout: 8000 });
        if (r.status === 429) {
          await new Promise((res) => setTimeout(res, 1100));
          r = await http.json(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=20`, { headers: { "X-Subscription-Token": env.BRAVE_API_KEY }, timeout: 8000 });
        }
        if (r.ok) keep(q, "brave", parseBrave(r.data));
        else engineLog.push({ q, engine: "brave", error: r.status || r.error });
      }
    } else {
      // DuckDuckGo takes the whole plan in order; Bing RSS runs the plain queries alongside.
      let ddgOk = true;
      const searxQueue = [];
      const ddgRun = (async () => {
        for (const [q, kind] of plan) {
          if (late()) break;
          if (!ddgOk) {
            if (kind === "site") searxQueue.push(q);
            continue;
          }
          const r = await http.get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, { timeout: 8000 });
          if (ddgBlocked(r) || (!r.ok && r.status)) {
            ddgOk = false;
            engineLog.push({ q, engine: "ddg", blocked: r.status });
            if (kind === "site") searxQueue.push(q);
            continue;
          }
          keep(q, "ddg", parseDdgHtml(r.text));
        }
      })();
      const bingRun = (async () => {
        for (const [q, kind] of plan) {
          if (kind !== "plain" || late()) continue;
          const r = await http.get(`https://www.bing.com/search?format=rss&setlang=en-US&cc=US&q=${encodeURIComponent(q)}`, { timeout: 8000 });
          if (r.ok) keep(q, "bing", parseBingRss(r.text));
        }
      })();
      await ddgRun;
      // SearXNG for the site: queries DuckDuckGo could not run.
      let inst = 0;
      for (const q of searxQueue.slice(0, 6)) {
        while (inst < SEARX.length && !late()) {
          const r = await http.json(`${SEARX[inst]}search?q=${encodeURIComponent(q)}&format=json`, { timeout: 6000 });
          if (r.ok && r.data) {
            keep(q, "searxng", parseSearx(r.data));
            break;
          }
          inst++;
        }
      }
      await bingRun;
    }
    shared.searchEngines = engineLog;

    const ran = engineLog.filter((e) => !e.error && !e.blocked);
    const blocked = engineLog.filter((e) => e.blocked || e.error);
    // One row per distinct URL whose title or snippet names the person.
    const seen = new Set();
    const profiles = (shared.searchProfiles ||= []);
    let rows = 0;
    for (const r of results) {
      if (seen.has(r.url)) continue;
      const text = `${r.title} ${r.snippet}`;
      if (!nameMatch(text, subject)) continue;
      seen.add(r.url);
      const c = classify(r, subject);
      const { grade, anchors } = snippetGrade(text, subject, shared);
      if (c.kind === "mention" && !anchors.includes("company")) continue; // name in someone else's sidebar
      const detail = { query: r.q, engine: r.engine, snippet: r.snippet, kind: c.kind };
      if (c.kind === "profile") {
        profiles.push({ platform: c.platform, handle: c.handle || null, url: r.url, title: r.title, snippet: r.snippet, anchors });
        const loc = r.snippet.match(/Location:\s*([^·|]+?)(?:\s*[·|]|$)/);
        if (loc && c.platform === "linkedin") {
          detail.location = loc[1].trim();
          ctx.add({ var: "place.home_metro", value: `${loc[1].trim()} (LinkedIn snippet)`, url: r.url, grade: anchors.includes("company") ? "p" : "w", tier: "C", anchors, detail });
        }
      }
      if (rows < 45) {
        ctx.add({ var: c.var, value: `${r.title}${r.snippet ? " — " + r.snippet.slice(0, 200) : ""}`, url: r.url, grade: c.var.startsWith("family.") ? "w" : grade, tier: "C", anchors, detail, date: r.date || null });
        rows++;
      }
      if (c.kind === "obituary" || c.kind === "wedding") {
        for (const f of familyLeads(r.snippet)) ctx.add({ var: f.var, value: `Lead only, not tied to the subject yet: "${f.value}"`, url: r.url, grade: "w", tier: "C", anchors, detail });
      }
    }
    if (!rows) ctx.miss("news.articles", `${ran.length} searches (${[...new Set(ran.map((e) => e.engine))].join(", ") || "none"}) returned nothing naming ${subject.name}${blocked.length ? `; blocked: ${blocked.map((b) => b.engine + " " + (b.blocked || b.error)).join(", ")}` : ""}`);
    const siteOf = { linkedin: "linkedin.com", instagram: "instagram.com", x: "x.com", facebook: "facebook.com", youtube: "youtube.com", github: "github.com", strava: "strava.com" };
    for (const [p, dom] of Object.entries(siteOf)) {
      if (profiles.some((x) => x.platform === p)) continue;
      const tried = ran.some((e) => e.q.includes("site:" + dom) && e.engine !== "bing");
      ctx.miss("social.accounts", tried ? `site:${dom} search found no profile titled ${subject.name}` : `site:${dom} search not run (engine blocked or out of time)`);
    }
    if (!results.some((r) => /obituary|wedding/.test(r.q) && nameMatch(r.title + " " + r.snippet, subject))) ctx.miss("family.partner", `obituary and wedding searches: nothing naming ${subject.name}`);
    ctx.log(`${ran.length} queries, ${results.length} results, ${rows} rows; engines ${[...new Set(ran.map((e) => e.engine))].join("+")}${blocked.length ? "; blocked " + blocked.map((b) => b.engine).join(",") : ""}`);
  },
};
