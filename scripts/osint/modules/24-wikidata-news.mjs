// Wikidata (notable people: birth date, schools, employers, spouse, linked accounts), GDELT
// news (last 12 months), Hacker News mentions, and the Wayback Machine for personal domains.

import { nameMatch, nameParts, companyIn, hostOf } from "../person-lib.mjs";

const wdLabel = (e) => e?.labels?.en?.value || null;
const claimIds = (e, p) => (e?.claims?.[p] || []).map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
const claimStr = (e, p) => (e?.claims?.[p] || []).map((c) => c.mainsnak?.datavalue?.value).filter((v) => typeof v === "string");
const claimTime = (e, p) => (e?.claims?.[p] || []).map((c) => c.mainsnak?.datavalue?.value?.time).filter(Boolean)[0]?.replace(/^\+/, "").slice(0, 10) || null;

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
      ctx.add({ var: "career.timeline", value: `Wikidata ${e.id}: ${desc || "person"}${born ? `; born ${born}` : ""}${employers.length ? `; employers ${employers.join(", ")}` : ""}${co ? "" : " (may be a namesake: company not mentioned)"}`, url, grade, tier: "A", anchors, detail: { born, birthplace: claimIds(e, "P19").map(L), occupations: claimIds(e, "P106").map(L), positions: claimIds(e, "P39").map(L) } });
      const edu = claimIds(e, "P69").map(L);
      if (edu.length) ctx.add({ var: "career.education", value: edu.join("; ") + " (Wikidata)", url, grade, tier: "A", anchors });
      const sp = claimIds(e, "P26").map(L);
      if (sp.length) ctx.add({ var: "family.partner", value: sp.join("; ") + " (Wikidata)", url, grade, tier: "A", anchors });
      const acc = [["P2002", "x", (h) => `https://x.com/${h}`], ["P2003", "instagram", (h) => `https://www.instagram.com/${h}/`], ["P2037", "github", (h) => `https://github.com/${h}`], ["P6634", "linkedin", (h) => `https://www.linkedin.com/in/${h}`], ["P2013", "facebook", (h) => `https://www.facebook.com/${h}`]];
      for (const [p, site, u] of acc) for (const h of claimStr(e, p)) {
        ctx.add({ var: "social.accounts", value: `${site}: @${h} (listed on Wikidata ${e.id})`, url: u(h), grade, tier: "A", anchors });
        (ctx.shared.wikidataAccounts ||= []).push({ site, handle: h, url: u(h), anchors });
      }
    }
  },
};

const gdelt = {
  id: "person-news",
  label: "News mentions, last 12 months (GDELT)",
  lane: "sweep", // after the company GDELT call in the fast lane: GDELT allows one call per 5 s
  needs: ["name"],
  budgetMs: 38000,
  async run(ctx) {
    const { subject, http } = ctx;
    const url = `http://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(`"${subject.name}"`)}&mode=artlist&format=json&maxrecords=50&timespan=1y&sort=datedesc`;
    // GDELT's TLS endpoint often stalls from scripts; plain http answers the same JSON.
    let r = await http.get(url, { timeout: 22000 });
    if (r.status === 429) {
      await new Promise((res) => setTimeout(res, 5500)); // one request per 5 s per IP
      r = await http.get(url, { timeout: 12000 });
    }
    if (!r.ok) return ctx.miss("news.articles", `GDELT: HTTP ${r.status || r.error}${r.status === 429 ? " (one request per 5 s per IP)" : ""}`);
    let arts = [];
    try {
      arts = JSON.parse(r.text).articles || [];
    } catch {
      return ctx.miss("news.articles", `GDELT: ${r.text.slice(0, 80) || "empty answer"}`);
    }
    if (!arts.length) return ctx.miss("news.articles", `GDELT: no articles naming "${subject.name}" in the last 12 months`);
    const seen = new Set();
    let n = 0;
    for (const a of arts) {
      const k = (a.title || "").toLowerCase().slice(0, 60);
      if (seen.has(k)) continue;
      seen.add(k);
      const co = companyIn(a.title, subject);
      const d = a.seendate ? `${a.seendate.slice(0, 4)}-${a.seendate.slice(4, 6)}-${a.seendate.slice(6, 8)}` : null;
      ctx.add({ var: "news.articles", value: `${a.title} (${a.domain})`, url: a.url, date: d, image: a.socialimage || null, grade: co ? "p" : "w", tier: "C", anchors: co ? ["name", "company"] : ["name"], detail: { engine: "gdelt", language: a.language, country: a.sourcecountry } });
      if (++n >= 15) break;
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
    const hits = (r.data?.hits || []).filter((h) => nameMatch(`${h.title || ""} ${h.story_text || ""} ${h.comment_text || ""}`, subject));
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
