// Quotes attributed to the person: "…," said Dan Holloway, President of … / Holloway said "…".
// Sources, all keyless: snippets the search and news modules already hold, press-release and
// company pages among those results (PR Newswire and the company's own site answer scripts;
// Business Wire and GlobeNewswire do not), and press releases filed with the SEC as 8-K exhibits
// (EDGAR full-text search). At most six pages are read, three at a time.

import { nameMatch, nameVariants, nameParts, companyIn, hostOf, stripTags, pool, isBlocked } from "../person-lib.mjs";
import { metaTags, SEC_UA } from "../core.mjs";

const PRESS = /(^|\.)(prnewswire\.com|businesswire\.com|globenewswire\.com|accesswire\.com|newswire\.com|einpresswire\.com|sec\.gov)$/;
const VERB = "said|says|added|adds|noted|notes|explained|commented|stated|continued";
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Quotes attributed to the subject in a block of plain text. Surname-only attributions
 *  ("said Holloway") count only when the text also carries the full name. */
export function extractQuotes(text, subject) {
  const t = String(text || "").replace(/\s+/g, " ");
  const names = nameVariants(subject).map(reEsc);
  const { last } = nameParts(subject.name);
  const surname = String(subject.name).trim().split(/\s+/).at(-1);
  if (nameMatch(t, subject) && surname.length > 2) names.push(`(?:Mr\\.|Ms\\.|Mrs\\.|Dr\\.)?\\s?${reEsc(surname)}`);
  const N = `(?:${names.join("|")})`;
  const Q = `[“"]([^“”"]{25,700}?)[,.!?]?[”"]`;
  const pats = [
    new RegExp(`${Q},?\\s*(?:${VERB})\\s+${N}\\b`, "gi"),
    new RegExp(`${Q},?\\s*${N}(?:,[^“”".]{2,160},)?\\s+(?:${VERB})\\b`, "gi"),
    new RegExp(`${N}(?:,[^“”".]{2,160},)?\\s+(?:${VERB})(?: in a statement| in an interview)?[,:]?\\s*${Q}`, "gi"),
  ];
  const out = [];
  for (const re of pats) for (const m of t.matchAll(re)) {
    const q = m[1].trim();
    if (q.split(" ").length < 6 || !last) continue;
    if (!out.some((x) => x.slice(0, 50) === q.slice(0, 50))) out.push(q);
  }
  return out;
}

export default {
  id: "quotes",
  /** The ledger variables this module fills (config/form buckets read them to say "no tool yet"). */
  vars: ["voice.quotes"],
  label: "Quotes attributed to the person (press releases, news, SEC exhibits)",
  lane: "slow",
  needs: ["name"],
  budgetMs: 15000,
  async run(ctx) {
    const { subject, http, shared } = ctx;
    const quotes = [];
    const add = (q, src) => {
      if (quotes.some((x) => x.q.slice(0, 50) === q.slice(0, 50))) return;
      quotes.push({ q, ...src });
    };
    // 1. Snippets already in hand.
    const pool0 = [...(shared.searchResults || []), ...(shared.newsItems || [])];
    for (const r of pool0) for (const q of extractQuotes(`${r.title || ""} ${r.snippet || ""}`, subject)) add(q, { url: r.url, source: hostOf(r.url), date: r.date || null, from: "snippet", co: companyIn(`${r.title} ${r.snippet}`, subject) });

    // 2. Pages worth opening: press wires and the company's own site, naming the subject.
    const pages = [];
    const seen = new Set();
    // Press wires and the company site first, then any article naming the subject with the
    // company. Social sites and Google News redirect links refuse scripts and are skipped.
    const NOFETCH = /(^|\.)(linkedin|facebook|instagram|x|twitter|tiktok|youtube|news\.google|pinterest|reddit|glassdoor|indeed|zoominfo|rocketreach|crunchbase|theorg)\.com$|news\.google\.com$/;
    const ranked = [];
    for (const r of pool0) {
      const h = hostOf(r.url);
      const t = `${r.title || ""} ${r.snippet || ""}`;
      if (seen.has(r.url) || NOFETCH.test(h) || !nameMatch(t, subject)) continue;
      seen.add(r.url);
      const rank = PRESS.test(h) || (subject.domain && h.endsWith(subject.domain)) ? 0 : /\b(said|says|announces?|appoints?|interview|press release)\b/i.test(t) ? 1 : companyIn(t, subject) ? 2 : 9;
      if (rank < 9) ranked.push({ url: r.url, date: r.date || null, rank });
    }
    pages.push(...ranked.sort((a, b) => a.rank - b.rank).slice(0, 4));
    // 3. Press releases filed as 8-K exhibits (public companies): EDGAR full-text search by name.
    const t0 = Date.now();
    let edgarBlocked = null;
    if (subject.company) {
      const q = nameVariants(subject).slice(0, 2).map((n) => `"${n}"`).join(" OR ");
      const r = await http.json(`https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(q)}&forms=8-K&dateRange=custom&startdt=${new Date(Date.now() - 3 * 365 * 864e5).toISOString().slice(0, 10)}&enddt=${new Date().toISOString().slice(0, 10)}`, { timeout: 8000, headers: { "user-agent": SEC_UA() } });
      if (!r.ok && isBlocked(r)) edgarBlocked = r.status;
      for (const h of (r.data?.hits?.hits || []).slice(0, 12)) {
        const s = h._source || {};
        const [adsh, file] = String(h._id || "").split(":");
        const cik = String((s.ciks || [])[0] || "").replace(/^0+/, "");
        if (!adsh || !file || !cik || !/ex-?99|ex99|press/i.test(file + " " + (s.file_type || ""))) continue;
        if (!companyIn(`${(s.display_names || []).join(" ")}`, subject)) continue;
        const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${adsh.replace(/-/g, "")}/${file}`;
        if (!seen.has(url)) {
          seen.add(url);
          pages.push({ url, date: s.file_date || null, sec: true });
        }
        if (pages.filter((p) => p.sec).length >= 3) break;
      }
    }
    const left = Math.max(3000, 13000 - (Date.now() - t0));
    const deadline = Date.now() + left;
    let read = 0;
    let refused = 0;
    await pool(pages.slice(0, 6), 3, async (p) => {
      if (Date.now() > deadline) return;
      const r = await http.get(p.url, { timeout: Math.min(6000, deadline - Date.now()), headers: p.sec ? { "user-agent": SEC_UA() } : {} });
      if (!r.ok) {
        if (isBlocked(r)) refused++;
        return;
      }
      read++;
      const m = metaTags(r.text);
      const body = stripTags(r.text);
      const date = (m["article:published_time"] || m["og:published_time"] || "").slice(0, 10) || p.date;
      for (const q of extractQuotes(body, subject)) add(q, { url: p.url, source: m["og:site_name"] || hostOf(p.url), title: m["og:title"] || m.title || null, date, from: p.sec ? "sec" : "page", co: companyIn(body.slice(0, 20000), subject) });
    });

    let n = 0;
    for (const x of quotes.slice(0, 8)) {
      ctx.add({
        var: "voice.quotes",
        value: `“${x.q}” — ${subject.name}${x.title ? `, in "${String(x.title).slice(0, 90)}"` : ""} (${x.source}${x.date ? `, ${String(x.date).slice(0, 10)}` : ""})`,
        url: x.url,
        date: x.date ? String(x.date).slice(0, 10) : null,
        grade: x.co ? "p" : "w",
        tier: x.from === "sec" || (subject.domain && hostOf(x.url).endsWith(subject.domain)) ? "A" : "C",
        anchors: x.co ? ["name", "company"] : ["name"],
        detail: { from: x.from, source: x.source },
      });
      n++;
    }
    if (!n) ctx.miss("voice.quotes", `no quote attributed to ${subject.name}: ${pool0.length} search/news snippets, ${read} of ${pages.length} press or company pages read${refused ? ` (${refused} refused scripts: blocked, unknown)` : ""}${edgarBlocked ? `; EDGAR full-text blocked (HTTP ${edgarBlocked}), unknown` : ""}`, { blocked: !read && !pool0.length && !!(refused || edgarBlocked) });
  },
};
