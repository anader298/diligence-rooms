// Wikidata (notable people: birth date, schools, employers, spouse, linked accounts), news naming
// the person (GDELT, last 12 months, with a Google News RSS fallback), Hacker News mentions, and
// the Wayback Machine for personal domains.

import { nameMatch, nameParts, companyIn, hostOf, isBlocked, blockedMiss, decodeEntities } from "../person-lib.mjs";

const wdLabel = (e) => e?.labels?.en?.value || null;
// Statements ranked "deprecated" are known-wrong values; never read them.
const live = (e, p) => (e?.claims?.[p] || []).filter((c) => c.rank !== "deprecated");
const claimIds = (e, p) => live(e, p).map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
const claimStr = (e, p) => live(e, p).map((c) => c.mainsnak?.datavalue?.value).filter((v) => typeof v === "string");
const claimTime = (e, p) => live(e, p).map((c) => c.mainsnak?.datavalue?.value?.time).filter(Boolean)[0]?.replace(/^\+/, "").slice(0, 10) || null;

const wikidata = {
  id: "person-wikidata",
  label: "Wikidata entity (notable people)",
  lane: "fast",
  needs: ["name"],
  budgetMs: 15000,
  async run(ctx) {
    const { subject, http } = ctx;
    const H = { "user-agent": "diligence-rooms/1.0 (public-source research script)" };
    const s = await http.json(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(subject.name)}&language=en&type=item&limit=7&format=json`, { headers: H, timeout: 8000 });
    const ids = (s.data?.search || []).filter((x) => nameMatch(x.label, subject)).map((x) => x.id);
    if (!ids.length) return ctx.miss("career.timeline", `Wikidata: no entity labelled ${subject.name} (not notable there)`);
    const g = await http.json(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids.join("|")}&props=claims|descriptions|labels&languages=en&format=json`, { headers: H, timeout: 8000 });
    const humans = Object.values(g.data?.entities || {}).filter((e) => claimIds(e, "P31").includes("Q5"));
    if (!humans.length) return ctx.miss("career.timeline", "Wikidata: entities with the name are not people");
    const refs = [...new Set(humans.flatMap((e) => ["P69", "P108", "P19", "P26", "P27", "P39", "P106"].flatMap((p) => claimIds(e, p))))].slice(0, 50);
    const lab = refs.length ? await http.json(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${refs.join("|")}&props=labels&languages=en&format=json`, { headers: H, timeout: 8000 }) : { data: {} };
    const L = (id) => wdLabel(lab.data?.entities?.[id]) || id;
    for (const e of humans) {
      const desc = e.descriptions?.en?.value || "";
      const employers = claimIds(e, "P108").map(L);
      const co = companyIn(`${desc} ${employers.join(" ")}`, subject);
      const grade = co ? "p" : "w";
      const anchors = co ? ["name", "company"] : ["name"];
      const url = `https://www.wikidata.org/wiki/${e.id}`;
      const born = claimTime(e, "P569");
      if (!co) {
        // A person with this name whose entry never mentions the company: a namesake until shown
        // otherwise. One weak row so the reader sees it was ruled out; no education, spouse or
        // accounts from it.
        ctx.add({ var: "career.timeline", value: `Wikidata ${e.id} has the same name but not ${subject.company || "the company"}: ${desc || "person"}${born ? `; born ${born}` : ""} (likely a namesake; nothing taken from it)`, url, grade: "i", tier: "A", anchors, detail: { verdict: "namesake", born, occupations: claimIds(e, "P106").map(L) } });
        continue;
      }
      ctx.add({ var: "career.timeline", value: `Wikidata ${e.id}: ${desc || "person"}${born ? `; born ${born}` : ""}${employers.length ? `; employers ${employers.join(", ")}` : ""}`, url, grade, tier: "A", anchors, detail: { born, birthplace: claimIds(e, "P19").map(L), occupations: claimIds(e, "P106").map(L), positions: claimIds(e, "P39").map(L) } });
      const edu = claimIds(e, "P69").map(L);
      if (edu.length) ctx.add({ var: "career.education", value: edu.join("; ") + " (Wikidata)", url, grade, tier: "A", anchors });
      const sp = claimIds(e, "P26").map(L);
      if (sp.length) ctx.add({ var: "family.partner", value: sp.join("; ") + " (Wikidata)", url, grade, tier: "A", anchors });
      // Accounts listed on the entity go to the identity module (an official link anchors them).
      const acc = [["P2002", "x", (h) => `https://x.com/${h}`], ["P2003", "instagram", (h) => `https://www.instagram.com/${h}/`], ["P2037", "github", (h) => `https://github.com/${h}`], ["P6634", "linkedin", (h) => `https://www.linkedin.com/in/${h}`], ["P2013", "facebook", (h) => `https://www.facebook.com/${h}`]];
      for (const [p, site, u] of acc) for (const h of claimStr(e, p)) (ctx.shared.wikidataAccounts ||= []).push({ site, handle: h, url: u(h), anchors });
    }
  },
};

/** Google News RSS items: title "Headline - Source", pubDate, link. */
export function parseGoogleNews(xml) {
  return [...String(xml || "").matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const g = (t) => decodeEntities(((m[1].match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`)) || [])[1] || "").replace(/<!\[CDATA\[|\]\]>/g, "")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return { title: g("title"), url: g("link"), date: g("pubDate"), source: g("source"), snippet: g("description") };
  }).filter((x) => x.title && x.url);
}

/** Keep a news item only when its headline names the subject or the company. */
const newsKeeps = (title, subject) => nameMatch(title, subject) || companyIn(title, subject);

const gdelt = {
  id: "person-news",
  label: "News naming the person, last 12 months (GDELT, Google News)",
  lane: "sweep", // after the company GDELT call in the fast lane: GDELT allows one call per 5 s
  needs: ["name"],
  budgetMs: 38000,
  async run(ctx) {
    const { subject, http, shared } = ctx;
    const items = (shared.newsItems ||= []);
    const seen = new Set();
    let n = 0;
    const push = (x) => {
      const k = (x.title || "").toLowerCase().replace(/\s+-\s+[^-]+$/, "").slice(0, 60);
      if (seen.has(k) || n >= 15) return;
      seen.add(k);
      const co = companyIn(`${x.title} ${x.snippet || ""}`, subject);
      const named = nameMatch(x.title, subject);
      // Obituaries and funeral notices: only with the company in the headline (namesakes otherwise).
      if (/\b(obituar|funeral|memorial service|visitation|passed away)/i.test(x.title) && !co) return;
      items.push({ title: x.title, url: x.url, snippet: x.snippet || "", date: x.date });
      // p: the headline names him and the company is in it; a company headline that matched only
      // in the body (Google News, GDELT) is a lead, graded w and labelled.
      ctx.add({ var: "news.articles", value: `${x.title}${x.domain ? ` (${x.domain})` : ""}${named ? "" : ` — names ${subject.name} in the body, not the headline`}`, url: x.url, date: x.date, image: co && named ? x.image || null : null, grade: co && named ? "p" : "w", tier: "C", anchors: [...(named ? ["name"] : []), ...(co ? ["company"] : [])], detail: { engine: x.engine, language: x.language || null, country: x.country || null } });
      n++;
    };
    const url = `http://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(`"${subject.name}"`)}&mode=artlist&format=json&maxrecords=50&timespan=1y&sort=datedesc`;
    // GDELT's TLS endpoint often stalls from scripts; plain http answers the same JSON.
    const r = await http.get(url, { timeout: 15000 });
    let arts = [];
    try {
      arts = r.ok ? JSON.parse(r.text).articles || [] : [];
    } catch {}
    let dropped = 0;
    for (const a of arts) {
      // GDELT matches the name anywhere in the body; "Funeral notices in the Chronicle" is not news
      // about him. The headline must name him or the company.
      if (!newsKeeps(a.title, subject)) {
        dropped++;
        continue;
      }
      push({ title: a.title, url: a.url, domain: a.domain, image: a.socialimage, engine: "gdelt", language: a.language, country: a.sourcecountry, date: a.seendate ? `${a.seendate.slice(0, 4)}-${a.seendate.slice(4, 6)}-${a.seendate.slice(6, 8)}` : null });
    }
    const gdeltBlocked = !r.ok;
    // Google News RSS: the name with the company (namesake obituaries drop out), then the name alone.
    const queries = [subject.company ? `"${subject.name}" "${subject.company}"` : null, `"${subject.name}"`].filter(Boolean);
    let gn = null;
    for (const q of queries) {
      if (n >= 10) break;
      gn = await http.get(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`, { timeout: 9000 });
      if (!gn.ok) break;
      for (const x of parseGoogleNews(gn.text)) {
        const headline = x.title.replace(/\s+-\s+[^-]+$/, "");
        if (!nameMatch(headline, subject) && !(companyIn(headline, subject) && q.includes(subject.company || "\u0000"))) continue;
        const d = Date.parse(x.date);
        push({ title: headline, url: x.url, domain: x.source, engine: "google-news", date: Number.isFinite(d) ? new Date(d).toISOString().slice(0, 10) : null });
      }
    }
    if (!n) {
      if (gdeltBlocked && (!gn || !gn.ok)) blockedMiss(ctx, "news.articles", "News search (GDELT and Google News)", gn && !gn.ok ? gn : r, "retry in a minute (GDELT allows one call per 5 s per IP)");
      else ctx.miss("news.articles", `GDELT and Google News: no headline naming "${subject.name}"${subject.company ? ` or ${subject.company} alongside the name` : ""} in the last 12 months${dropped ? ` (${dropped} articles mention the name only in the body; set aside)` : ""}${gdeltBlocked ? `; GDELT blocked (HTTP ${r.status || r.error}), unknown` : ""}`);
    }
  },
};

const hn = {
  id: "hn",
  label: "Hacker News mentions",
  lane: "fast",
  needs: ["name"],
  budgetMs: 10000,
  async run(ctx) {
    const { subject, http } = ctx;
    const r = await http.json(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(`"${subject.name}"`)}&hitsPerPage=20`, { timeout: 8000 });
    if (!r.ok) return ctx.miss("news.articles", `Hacker News search: HTTP ${r.status || r.error}`);
    // The name must stand as a name (adjacent words) in the story or comment, and a story by a user
    // whose handle merely contains the surname is not about him.
    const hits = (r.data?.hits || []).filter((h) => nameMatch(`${h.title || ""} ${String(h.story_text || "").replace(/<[^>]+>/g, " ")} ${String(h.comment_text || "").replace(/<[^>]+>/g, " ")}`, subject));
    if (!hits.length) return ctx.miss("news.articles", `Hacker News: no story or comment naming "${subject.name}"`);
    for (const h of hits.slice(0, 6)) {
      const text = (h.title || h.comment_text || h.story_text || "").replace(/<[^>]+>/g, " ").slice(0, 200);
      const co = companyIn(text, subject);
      ctx.add({ var: "news.articles", value: `Hacker News ${h.title ? "story" : "comment"} by ${h.author}: ${text}`, url: `https://news.ycombinator.com/item?id=${h.objectID}`, date: String(h.created_at || "").slice(0, 10), grade: co ? "p" : "w", tier: "C", anchors: co ? ["name", "company"] : ["name"] });
    }
  },
};

const wayback = {
  id: "person-wayback",
  label: "Archived personal sites (Wayback Machine)",
  lane: "slow",
  needs: ["name"],
  budgetMs: 20000,
  async run(ctx) {
    const { subject, http, shared } = ctx;
    const { first, last } = nameParts(subject.name);
    const doms = new Set([`${first}${last}.com`]);
    const skip = /linkedin|facebook|instagram|twitter|x\.com|github|youtube|medium|substack|tiktok|bsky|wikipedia|google|bing|duckduckgo|linktr/;
    for (const a of shared.accounts || []) if (a.confirmed && a.blog) doms.add(hostOf(/^https?:/.test(a.blog) ? a.blog : "https://" + a.blog));
    for (const r of shared.searchResults || []) {
      const h = hostOf(r.url);
      if (h && h.replace(/[^a-z]/g, "").includes(last) && !skip.test(h) && nameMatch(`${r.title} ${r.snippet}`, subject)) doms.add(h);
    }
    let n = 0;
    for (const d of [...doms].filter(Boolean).slice(0, 4)) {
      const r = await http.json(`https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(d)}&output=json&fl=timestamp,original,statuscode&collapse=timestamp:4&limit=200`, { timeout: 12000 });
      if (!r.ok) {
        ctx.miss("place.web_archive", `Wayback CDX for ${d}: HTTP ${r.status || r.error}`);
        continue;
      }
      const rows = (r.data || []).slice(1);
      if (!rows.length) continue;
      const years = rows.map((x) => x[0].slice(0, 4));
      ctx.add({ var: "place.web_archive", value: `${d}: archived in ${years.length} year(s), ${years[0]}–${years.at(-1)}`, url: `https://web.archive.org/web/*/${d}*`, grade: "w", tier: "A", detail: { first: rows[0][0], last: rows.at(-1)[0], years } });
      n++;
    }
    if (!n) ctx.miss("place.web_archive", `no archived personal site (checked ${[...doms].join(", ")})`);
  },
};

export default [wikidata, gdelt, hn, wayback];
