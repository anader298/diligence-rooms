// Pure helpers for the company-side OSINT modules (modules 50-79): SEC parsing, job-board
// parsing, table extraction and the estimate math. No network here, so the tests can feed
// fixtures straight in.

import { normName, nameIn } from "./core.mjs";

// ---------------------------------------------------------------- text

const ENT = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', mdash: "-", ndash: "-", hellip: "...", bull: "-", middot: "-", reg: "", trade: "", copy: "" };
export function decodeEntities(s) {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeChar(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => safeChar(Number(n)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in ENT ? ENT[n.toLowerCase()] : m));
}
function safeChar(n) {
  if (n === 160) return " ";
  if (n === 8217 || n === 8216) return "'";
  if (n === 8220 || n === 8221) return '"';
  if (n === 8211 || n === 8212) return "-";
  try {
    return String.fromCodePoint(n);
  } catch {
    return " ";
  }
}

/** HTML to one line of plain text, entities decoded. Block tags become ". "-safe spaces. */
export function htmlText(html) {
  return decodeEntities(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

export const money = (n) => {
  if (n == null || !isFinite(n)) return "?";
  const a = Math.abs(n);
  const s = n < 0 ? "-" : "";
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
  if (a >= 1e3) return `${s}$${Math.round(a / 1e3)}k`;
  return `${s}$${Math.round(a)}`;
};
export const pct = (x) => (x == null || !isFinite(x) ? "?" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);
const num = (s) => {
  const t = String(s ?? "").replace(/[$,\s]/g, "");
  if (/^\(.*\)$/.test(t)) return -Number(t.slice(1, -1));
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** Sentences of a text that pass a test. */
export function sentences(text) {
  return String(text || "")
    .replace(/\b(Mr|Ms|Mrs|Dr|Jr|Sr|St|Inc|Corp|Co|Ltd|No|vs|Messrs|Prof|Gen|Lt|Col|[A-Z])\./g, "$1\u2024")
    .split(/(?<=[.!?])\s+(?=[A-Z"'(])/)
    .map((s) => s.replace(/\u2024/g, ".").trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------- company names

const SUFFIX = /\b(incorporated|inc|corp|corporation|co|company|ltd|limited|llc|l l c|plc|lp|l p|holdings?|group|the|sa|ag|nv|se|gmbh|technologies|technology)\b/g;
export function normCompany(s) {
  return normName(String(s || "").replace(/\/[a-z]{2}\/?$/i, ""))
    .replace(SUFFIX, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pick the SEC registrant for a company name (or ticker) from company_tickers.json.
 * Returns { cik, ticker, title, score } or null. Exact normalised match wins; otherwise the
 * best token overlap, and only when every token of the query is in the registrant name.
 */
export function matchCompany(tickers, { name, ticker } = {}) {
  const list = Array.isArray(tickers) ? tickers : Object.values(tickers || {});
  if (ticker) {
    const t = list.find((x) => String(x.ticker).toUpperCase() === String(ticker).toUpperCase());
    if (t) return { cik: Number(t.cik_str), ticker: t.ticker, title: t.title, score: 1 };
  }
  const q = normCompany(name);
  if (!q) return null;
  const qt = q.split(" ");
  let best = null;
  for (const x of list) {
    const n = normCompany(x.title);
    if (!n) continue;
    let score = 0;
    if (n === q) score = 1;
    else {
      const nt = n.split(" ");
      if (!qt.every((t) => nt.includes(t))) continue;
      score = qt.length / nt.length - 0.05; // fewer extra words in the registrant name is better
    }
    // several share classes list the same CIK; prefer the first (largest) listing
    if (!best || score > best.score) best = { cik: Number(x.cik_str), ticker: x.ticker, title: x.title, score };
  }
  return best && best.score >= 0.5 ? best : null;
}

export const cik10 = (cik) => String(cik).padStart(10, "0");

// ---------------------------------------------------------------- XBRL

const REV = ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet", "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueGoodsNet", "RevenuesNetOfInterestExpense"];
const days = (a, b) => (new Date(b) - new Date(a)) / 864e5;

function series(facts, concept, unit = "USD", ns = "us-gaap") {
  const u = facts?.facts?.[ns]?.[concept]?.units?.[unit];
  return Array.isArray(u) ? u : [];
}
function dedupe(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = (r.start || "") + "|" + r.end;
    const prev = m.get(k);
    if (!prev || r.filed > prev.filed) m.set(k, r);
  }
  return [...m.values()].sort((a, b) => (a.end < b.end ? -1 : 1));
}

/**
 * Latest annual and quarterly revenue from companyfacts, with the same quarter a year earlier.
 * Picks the revenue concept whose newest data point is the most recent.
 */
export function pickRevenue(facts) {
  let pick = null;
  for (const c of REV) {
    const s = series(facts, c).filter((r) => r.start);
    if (!s.length) continue;
    const last = s.reduce((a, b) => (a.end > b.end ? a : b)).end;
    if (!pick || last > pick.last) pick = { concept: c, rows: dedupe(s), last };
  }
  if (!pick) return null;
  const q = pick.rows.filter((r) => days(r.start, r.end) > 80 && days(r.start, r.end) < 100);
  const y = pick.rows.filter((r) => days(r.start, r.end) > 350 && days(r.start, r.end) < 380);
  const quarter = q.at(-1) || null;
  const annual = y.at(-1) || null;
  const priorQuarter = quarter ? q.find((r) => Math.abs(days(r.end, quarter.end) - 364) < 20) || null : null;
  const priorAnnual = annual ? y.find((r) => Math.abs(days(r.end, annual.end) - 364) < 20) || null : null;
  return {
    concept: pick.concept,
    quarter,
    priorQuarter,
    quarterYoY: quarter && priorQuarter ? quarter.val / priorQuarter.val - 1 : null,
    annual,
    priorAnnual,
    annualYoY: annual && priorAnnual ? annual.val / priorAnnual.val - 1 : null,
  };
}

/** Newest value among concepts (instant or duration), e.g. cash or debt. */
export function latestFact(facts, concepts, { unit = "USD", ns = "us-gaap", duration = null } = {}) {
  let best = null;
  for (const c of concepts) {
    for (const r of series(facts, c, unit, ns)) {
      if (duration === "quarter" && !(r.start && days(r.start, r.end) > 80 && days(r.start, r.end) < 100)) continue;
      if (duration === "annual" && !(r.start && days(r.start, r.end) > 350)) continue;
      if (!best || r.end > best.end || (r.end === best.end && r.filed > best.filed)) best = { ...r, concept: c };
    }
  }
  return best;
}

// ---------------------------------------------------------------- Form 3/4

const tag = (xml, t) => {
  const m = String(xml).match(new RegExp(`<${t}>\\s*(?:<value>)?\\s*([\\s\\S]*?)\\s*(?:</value>)?\\s*</${t}>`, "i"));
  return m ? decodeEntities(m[1].replace(/<[^>]+>/g, "").trim()) : null;
};
export const TX_CODES = { P: "open-market buy", S: "open-market sale", A: "grant/award", M: "option exercise", F: "tax withholding", G: "gift", D: "disposition to issuer", C: "conversion", X: "option exercise", J: "other", W: "will/inheritance", I: "discretionary" };

/** Parse an SEC ownership XML (Form 3, 4 or 5). */
export function parseForm4(xml) {
  const s = String(xml || "");
  const out = {
    form: tag(s, "documentType"),
    period: tag(s, "periodOfReport"),
    issuer: tag(s, "issuerName"),
    issuerCik: tag(s, "issuerCik"),
    ticker: tag(s, "issuerTradingSymbol"),
    owner: tag(s, "rptOwnerName"),
    ownerCik: tag(s, "rptOwnerCik"),
    isDirector: /<isDirector>\s*(1|true)/i.test(s),
    isOfficer: /<isOfficer>\s*(1|true)/i.test(s),
    title: tag(s, "officerTitle"),
    trades: [],
    holdings: [],
  };
  const blocks = [
    ...[...s.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g)].map((m) => [m[1], false, true]),
    ...[...s.matchAll(/<derivativeTransaction>([\s\S]*?)<\/derivativeTransaction>/g)].map((m) => [m[1], true, true]),
    ...[...s.matchAll(/<nonDerivativeHolding>([\s\S]*?)<\/nonDerivativeHolding>/g)].map((m) => [m[1], false, false]),
    ...[...s.matchAll(/<derivativeHolding>([\s\S]*?)<\/derivativeHolding>/g)].map((m) => [m[1], true, false]),
  ];
  for (const [b, derivative, isTx] of blocks) {
    const sec = tag(b, "securityTitle");
    const after = num(tag(b, "sharesOwnedFollowingTransaction"));
    const direct = tag(b, "directOrIndirectOwnership");
    if (isTx) {
      const code = tag(b, "transactionCode");
      out.trades.push({
        date: tag(b, "transactionDate"),
        code,
        what: TX_CODES[code] || code,
        shares: num(tag(b, "transactionShares")),
        price: num(tag(b, "transactionPricePerShare")),
        ad: tag(b, "transactionAcquiredDisposedCode"),
        after,
        security: sec,
        derivative,
        direct,
      });
    } else out.holdings.push({ security: sec, after, derivative, direct });
  }
  return out;
}

// ---------------------------------------------------------------- HTML tables

export function htmlTables(html) {
  const out = [];
  for (const m of String(html).matchAll(/<table[\s\S]*?<\/table>/gi)) out.push({ at: m.index, html: m[0] });
  return out;
}
/** Rows of cells, empty and lone "$" / ")" / "%" cells dropped (EDGAR splits numbers across cells). */
export function tableRows(tableHtml) {
  return [...String(tableHtml).matchAll(/<tr[\s\S]*?<\/tr>/gi)]
    .map((r) =>
      [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map((c) => htmlText(c[1]))
        .filter((c) => c !== "" && c !== "$" && c !== ")" && c !== "%" && c !== "(" && c !== "-"),
    )
    .filter((r) => r.length);
}

/**
 * Summary Compensation Table row for a person in a proxy (DEF 14A).
 * Returns { found, isNeo, header, years: [{ year, cells: {col: value}, total }], neos: [names] }.
 */
export function parseSCT(html, name) {
  const marks = [...String(html).matchAll(/summary compensation table/gi)].map((m) => m.index);
  const last = normName(name).split(" ").at(-1);
  for (const t of htmlTables(html)) {
    if (!marks.some((m) => t.at > m && t.at - m < 6000)) continue;
    const rows = tableRows(t.html);
    const hi = rows.findIndex((r) => /salary/i.test(r.join(" ")) && /total/i.test(r.join(" ")));
    if (hi < 0 || hi > 4) continue;
    const header = rows[hi].map((h) => h.replace(/\(\d\)|\(\$\)|\$|\(\s*\)/g, "").replace(/\s+/g, " ").trim());
    const yearIdx = header.findIndex((h) => /^year$|fiscal year/i.test(h));
    const body = rows.slice(hi + 1);
    const neos = [];
    let current = null;
    const people = [];
    for (const r of body) {
      const first = r[0];
      if (!/^(19|20)\d\d$/.test(first)) {
        current = { label: first, years: [] };
        people.push(current);
        neos.push(first.split(/,| - /)[0].trim());
        const rest = r.slice(1);
        if (/^(19|20)\d\d$/.test(rest[0] || "")) current.years.push(rest);
      } else if (current) current.years.push(r);
    }
    if (!people.length) continue;
    const who = people.find((p) => nameIn(p.label, name) || (last && normName(p.label).split(" ").includes(last)));
    const cols = header.slice(yearIdx >= 0 ? yearIdx + 1 : 2);
    const map = (yr) => {
      const vals = yr.slice(1);
      const cells = {};
      // align from the right: Total is always last, missing columns are blank on the left
      const off = cols.length - vals.length;
      vals.forEach((v, i) => (cells[cols[i + Math.max(0, off)] || `col${i}`] = num(v)));
      return { year: Number(yr[0]), cells, total: num(vals.at(-1)) };
    };
    if (!who) return { found: true, isNeo: false, header, neos, years: [] };
    return { found: true, isNeo: true, label: who.label, header, neos, years: who.years.map(map).sort((a, b) => b.year - a.year) };
  }
  return { found: false, isNeo: false, years: [], neos: [] };
}

/**
 * A person's bio paragraph from a filing or web page: sentences that name the person
 * (full name, "Ms./Mr. Last", or first name), plus pronoun sentences that follow them.
 */
export function bioFrom(text, name, { max = 2200 } = {}) {
  const parts = normName(name).split(" ");
  const first = parts[0];
  const last = parts.at(-1);
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
  const reName = new RegExp(`\\b(${cap(first)}\\s+(?:[A-Z]\\.?\\s+)?${cap(last)}|(?:Mr|Ms|Mrs|Dr)\\.?\\s+${cap(last)}|${cap(first)})\\b`);
  const prose = (x) => x.length >= 20 && x.length <= 450 && (x.match(/\d[\d,.]*/g) || []).length <= 6 && (x.match(/\d/g) || []).length / x.length < 0.12;
  const ss = sentences(text);
  const PRON = /^(She|He|They|Her|His|Prior|Before|Previously|Earlier|Since|From|In \d{4}|Additionally|Most recently|Under (?:her|his))\b/;
  // runs of sentences about the person; runs a few sentences apart merge into one bio
  const runs = [];
  for (let i = 0; i < ss.length; i++) {
    if (!prose(ss[i]) || !reName.test(ss[i])) continue;
    let j = i + 1;
    while (j < ss.length && j < i + 16 && prose(ss[j]) && (reName.test(ss[j]) || PRON.test(ss[j]))) j++;
    const prev = runs.at(-1);
    if (prev && i - prev.end <= 3 && ss.slice(prev.end, i).every(prose)) prev.end = j;
    else runs.push({ start: i, end: j });
    i = j - 1;
  }
  let best = [];
  for (const r of runs) {
    const cand = ss.slice(r.start, r.end);
    if (cand.join(" ").length > best.join(" ").length) best = cand;
  }
  const out = best.join(" ");
  return out.length > max ? out.slice(0, max) + "..." : out;
}

const DEGREE = /\b(Ph\.?\s?D|M\.?B\.?A|J\.?D|M\.?D|B\.?S\.?(?:M\.?E\.?T)?|B\.?A|M\.?S|M\.?A|B\.?Eng|M\.?Eng|BSc|MSc|Bachelor(?:'s)?(?: of [A-Z][A-Za-z ]+| degree)?|Master(?:'s)?(?: of [A-Z][A-Za-z ]+| degree)?|doctorate|LL\.?M|CPA)\b/;
const SCHOOL = /((?:the\s+)?(?:University of [A-Z][A-Za-z.&' -]+|[A-Z][A-Za-z.&' -]+ (?:University|College|Institute of Technology|Institute|School of [A-Z][A-Za-z]+|Business School|Law School)|[A-Z]{3,6}(?= with| in|,| and)|Harvard|Yale|Stanford|MIT|Wharton|INSEAD|Princeton|Columbia|Dartmouth|Cornell))/;
/** Degree + school pairs in a bio. */
export function educationFrom(bio) {
  const out = [];
  for (const s of sentences(bio)) {
    if (!/(graduat|degree|earned|holds|received|alumn|\bB\.?S\b|\bB\.?A\b|M\.?B\.?A|Bachelor|Master|Ph\.?D|studied)/i.test(s)) continue;
    const school = s.match(SCHOOL)?.[1]?.replace(/^the\s+/i, "").trim();
    const degree = s.match(DEGREE)?.[0];
    if (school || degree) out.push(s.length > 260 ? s.slice(0, 260) + "..." : s);
  }
  return [...new Set(out)];
}

/** Employer/role history from a bio: "CMO of Acquia", "COO of the ALOE Group", "at Oracle". */
export function careerFrom(bio) {
  const out = [];
  for (const s of sentences(bio)) {
    if (/(joined|served|was |held|prior|previously|before|career|began|role|position|leader|officer|president|director|manager|head of)/i.test(s) && !/graduat|degree|earned his|earned her/i.test(s)) out.push(s.length > 300 ? s.slice(0, 300) + "..." : s);
  }
  return out.slice(0, 8);
}

/** Years mentioned with "since"/"joined ... in" near the person: role start candidates. */
export function startFrom(bio) {
  const m =
    bio.match(/(?:in this role|in the role|in (?:his|her|their) current role|this position) since ([A-Z][a-z]+ \d{4}|\d{4})/i) ||
    bio.match(/join(?:ed|ing) [^.]{0,60}?in ([A-Z][a-z]+ (?:of )?\d{4}|\d{4})/i) ||
    bio.match(/since ([A-Z][a-z]+ \d{4}|\d{4})/);
  return m ? m[1].replace(" of ", " ") : null;
}

const TITLE_WORDS = /\b(Chief|President|Vice President|VP|EVP|SVP|Director|Officer|Head|Manager|General Manager|Founder|Co-Founder|CEO|CFO|CTO|COO|CIO|CMO|CRO|CPO|CHRO|Chair(?:man|woman|person)?|Partner|Controller|Treasurer|Secretary|Counsel|Lead)\b/;
export const looksLikeTitle = (s) => s && s.length < 120 && TITLE_WORDS.test(s);
const NOT_NAME = /\b(Leadership|Team|Board|Directors|Management|Executive|Company|About|Our|Contact|News|Careers|Investors|Products?|Solutions?|Services|Home|Menu|Search|Read|More|View|Learn|Privacy|Policy|Terms|Cookie|Training|Partners?|Find|Demand|Download|Free|Trial|Started|Sign|Login|Request|Demo|Webinars?|Documentation|Community|Academy|Center|Portal|Store|Shop|Industries|Resources|Support|Blog|Events|Customers|Partners|Platform|Pricing|Senior|Global|North|South|America|Europe|United|States|Office|Inc|LLC|Corporation)\b/;
export const looksLikeName = (s) => /^[A-Z][a-zA-Z'’.-]+(?: [A-Z][a-zA-Z'’.-]*\.?){1,3}$/.test(s) && s.length <= 40 && !NOT_NAME.test(s) && !TITLE_WORDS.test(s);

/** Pull a title out of bio prose: "as VP of Operations", "is the CEO of", "position of Vice President, X". */
export function titleFromBio(bio) {
  const m =
    bio.match(/(?:holds the position of|position of|serves as|serving as|currently (?:serves|is) (?:as )?(?:the )?)\s*((?:[A-Z][\w&,'-]*\s?){1,9})/) ||
    bio.match(/\bis (?:the |our )?((?:[A-Z][\w&'-]*\s?){1,7}?) (?:of|at) [A-Z]/) ||
    bio.match(/\bas (?:the |our )?((?:Chief|Senior|Executive|Vice|VP|SVP|EVP|Director|Head|General|President|Global|Managing)[\w&,' -]{2,80}?)(?=[.,;]| of the| for| and| at| in| where|\s[a-z])/);
  const t = m?.[1]?.replace(/[,\s]+$/, "").trim();
  return t && looksLikeTitle(t) ? t : null;
}

/**
 * People cards on a leadership page: name in a heading/strong/span, title in the next short
 * text block, bio paragraph after. Returns [{ name, title, bio, img }].
 */
export function parseLeadership(html) {
  const h = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  // tokenise into blocks: text between block-level boundaries, with the last img seen
  const blocks = [];
  let lastImg = null;
  for (const m of h.matchAll(/<img\b[^>]*>|<\/?(?:h[1-6]|p|div|li|span|strong|b|a|td|section|article|figure|figcaption|br)\b[^>]*>|[^<]+/gi)) {
    const tok = m[0];
    if (/^<img/i.test(tok)) {
      const src = tok.match(/data-lazy-src=["']([^"']+)/i)?.[1] || tok.match(/data-src=["']([^"']+)/i)?.[1] || tok.match(/\ssrc=["']([^"']+)/i)?.[1];
      if (src && !src.startsWith("data:")) lastImg = { src, alt: decodeEntities(tok.match(/alt=["']([^"']*)/i)?.[1] || "") };
      continue;
    }
    if (tok.startsWith("<")) continue;
    const t = decodeEntities(tok).replace(/\s+/g, " ").trim();
    if (t) blocks.push({ t, img: lastImg });
  }
  const people = [];
  const seen = new Set();
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i].t;
    if (!looksLikeName(b) || seen.has(b)) continue;
    const next = blocks.slice(i + 1, i + 4).map((x) => x.t);
    // the title sits between the name and the bio; a long block is the bio and ends the search
    let title = null;
    for (const x of next) {
      if (x.length > 100 || /[.!?]\s|\b(is|was|has|joined|leads)\b/.test(x)) break;
      if (looksLikeName(x)) break;
      if (looksLikeTitle(x)) {
        title = x;
        break;
      }
    }
    const bio = next.find((x) => x.length > 60 && (x.includes(b.split(" ").at(-1)) || x.includes(b.split(" ")[0]))) || "";
    if (!title && bio) title = titleFromBio(bio);
    if (!title) continue;
    if (/\s(at|@)\s+\S/.test(title)) continue; // "VP Product at OtherCo": a customer quote or testimonial, not this company's team
    seen.add(b);
    const img = blocks[i].img && (normName(blocks[i].img.alt).includes(normName(b).split(" ").at(-1)) || normName(blocks[i].img.src).includes(normName(b).split(" ").at(-1))) ? blocks[i].img.src : null;
    people.push({ name: b, title, bio, img });
  }
  return people;
}

// ---------------------------------------------------------------- job boards

const plain = (html) => htmlText(decodeEntities(html || ""));
/** Normalise any supported board's payload to [{ title, dept, location, url, text, date }]. */
export function parseJobs(kind, data) {
  try {
    switch (kind) {
      case "greenhouse":
      case "gem":
        return (data?.jobs || data || []).map((j) => ({ title: j.title?.trim(), dept: j.departments?.[0]?.name || null, location: j.location?.name || null, url: j.absolute_url, text: j.content_plain || plain(j.content), date: j.first_published || j.first_published_at || j.updated_at || null }));
      case "lever":
        return (data || []).map((j) => ({ title: j.text?.trim(), dept: j.categories?.department || j.categories?.team || null, location: j.categories?.location || null, url: j.hostedUrl, text: [j.descriptionPlain, ...(j.lists || []).map((l) => l.text + " " + plain(l.content)), j.additionalPlain].join(" "), date: j.createdAt ? new Date(j.createdAt).toISOString() : null }));
      case "ashby":
        return (data?.jobs || []).filter((j) => j.isListed !== false).map((j) => ({ title: j.title?.trim(), dept: j.department || j.team || null, location: j.location || null, url: j.jobUrl, text: j.descriptionPlain || plain(j.descriptionHtml), date: j.publishedAt || null }));
      case "smartrecruiters":
        return (data?.content || []).map((j) => ({ title: j.name?.trim(), dept: j.department?.label || j.function?.label || null, location: [j.location?.city, j.location?.region, j.location?.country].filter(Boolean).join(", ") || null, url: j.ref ? `https://jobs.smartrecruiters.com/${j.company?.identifier}/${j.id}` : null, text: "", date: j.releasedDate || null }));
      case "workable":
        return (data?.jobs || []).map((j) => ({ title: j.title?.trim(), dept: j.department || null, location: [j.city, j.state, j.country].filter(Boolean).join(", ") || null, url: j.url || j.shortlink, text: plain(j.description), date: j.published_on || j.created_at || null }));
      case "recruitee":
        return (data?.offers || []).map((j) => ({ title: j.title?.trim(), dept: j.department || null, location: j.location || [j.city, j.country].filter(Boolean).join(", ") || null, url: j.careers_url, text: plain(j.description) + " " + plain(j.requirements), date: j.published_at || null }));
      case "paylocity":
        return (data?.Jobs || []).map((j) => ({ title: j.JobTitle?.trim(), dept: j.HiringDepartment || null, location: j.LocationName || null, url: `https://recruiting.paylocity.com/Recruiting/Jobs/Details/${j.JobId}`, text: j.Description || "", date: j.PublishedDate || null }));
      case "jobvite":
        return data || [];
    }
  } catch {}
  return [];
}

/** window.pageData from a Paylocity board page. */
export function paylocityPageData(html) {
  const m = String(html).match(/window\.pageData\s*=\s*(\{[\s\S]*?\});\s*(?:<\/script>|window\.)/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** jobs.jobvite.com/<slug>/jobs: category headings, then rows with name + location. */
export function parseJobviteHtml(html, base = "https://jobs.jobvite.com") {
  const out = [];
  let dept = null;
  for (const m of String(html).matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>|<td class="jv-job-list-name">\s*<a href="([^"]+)">([\s\S]*?)<\/a>\s*<\/td>\s*<td class="jv-job-list-location">([\s\S]*?)<\/td>/gi)) {
    if (m[1] != null) dept = htmlText(m[1]);
    else out.push({ title: htmlText(m[3]), dept, location: htmlText(m[4]).replace(/\s*,\s*/g, ", ").replace(/^,\s*/, ""), url: base + m[2], text: "", date: null });
  }
  return out;
}

const DEPT_RULES = [
  ["Engineering", /engineer|developer|devops|sre|architect|software|platform|qa\b|security|data scien|machine learning|\bml\b|\bai\b/i],
  ["Sales", /sales|account exec|account manager|business develop|\bsdr\b|\bbdr\b|partner manager|solutions? consult|pre-?sales/i],
  ["Marketing", /marketing|brand|content|demand gen|communications|\bseo\b|growth/i],
  ["Customer", /customer|support|success|onboarding|implementation|service/i],
  ["Product/Design", /product manager|product owner|designer|\bux\b|\bui\b|product design/i],
  ["Finance", /financ|account(ant|ing)|controller|fp&a|tax|payroll|treasury/i],
  ["People", /recruit|talent|people|\bhr\b|human resources/i],
  ["Operations", /operat|manufactur|production|maintenance|mechanic|warehouse|supply|logistic|quality|operator|technician|plant|process|lean|extrusion/i],
  ["Legal", /legal|counsel|paralegal|compliance/i],
];
export const deptOf = (j) => j.dept && j.dept !== "Unspecified" ? j.dept : DEPT_RULES.find(([, re]) => re.test(j.title))?.[0] || "Other";

export const SIGNAL_TERMS = ["AI", "LLM", "agent", "automation", "Salesforce", "HubSpot", "Snowflake", "dbt", "SAP", "NetSuite", "Workday", "ServiceNow", "Kubernetes", "AWS", "Azure", "GCP", "Python", "Lean", "Six Sigma", "DMAIC", "Kaizen", "ERP", "MES", "OEE", "KPI", "OKR", "ARR", "NRR", "pipeline", "forecast", "quota", "SOX", "ISO", "FDA", "GMP", "migration", "integration", "data quality", "efficiency", "cost reduction", "scale", "growth", "transformation", "Rust", "security", "public sector", "FedRAMP"];

/** Count terms across job texts and titles (word-boundary, case rules: short acronyms are case-sensitive). */
export function termCounts(texts, terms = SIGNAL_TERMS) {
  const out = {};
  for (const t of terms) {
    const flags = t.length <= 4 && t === t.toUpperCase() ? "g" : "gi";
    const re = new RegExp(`(?<![A-Za-z])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z])`, flags);
    let n = 0;
    for (const x of texts) if (re.test(String(x || ""))) n++;
    if (n) out[t] = n;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

/** Drop sentences that recur in many postings (company boilerplate, EEO text, "used by Salesforce, SAP..."). */
export function stripBoilerplate(texts, share = 0.4) {
  if (texts.length < 4) return texts;
  const freq = new Map();
  const split = texts.map((t) => [...new Set(sentences(String(t || "").replace(/\n+/g, ". ")))]);
  for (const ss of split) for (const x of ss) freq.set(x, (freq.get(x) || 0) + 1);
  const cut = Math.max(2, texts.length * share);
  return split.map((ss) => ss.filter((x) => freq.get(x) < cut).join(" "));
}

/** "reports to the VP of Operations" / "reporting to our CFO" phrases in postings. */
export function reportsTo(texts) {
  const out = {};
  for (const x of texts) {
    for (const m of String(x || "").matchAll(/[Rr]eport(?:s|ing)? (?:directly )?(?:in)?to (?:the |our |a )?((?:[A-Z][\w&/,-]*\s?(?:of |and |& )?){1,7})/g)) {
      const t = m[1].replace(/[\s,]+$/, "").replace(/ (of|and|&)$/, "").trim();
      if (looksLikeTitle(t) && t.length < 70) out[t] = (out[t] || 0) + 1;
    }
  }
  return Object.entries(out).sort((a, b) => b[1] - a[1]);
}

/** Words from the person's title used to rank relevant postings (e.g. "Operations", "Digital Experience"). */
export function titleWords(title) {
  return normName(title || "")
    .split(" ")
    .filter((w) => w.length > 3 && !/^(vice|president|senior|executive|general|manager|chief|officer|director|head|global|lead|principal|staff)$/.test(w));
}

// ---------------------------------------------------------------- earnings releases

/** KPI mentions with numbers: ARR, NRR, RPO, customers > $100k, DBNR, gross margin. */
export function kpisFrom(text) {
  const t = String(text || "");
  const pats = [
    ["ARR", /\b(?:ARR|annual(?:ized)? recurring revenue)\b[^.]{0,80}?(\$\s?[\d.,]+\s?(?:million|billion|[MB])\b)/i],
    ["ARR growth", /\b(?:ARR|annual(?:ized)? recurring revenue)\b[^.]{0,80}?(\d+(?:\.\d+)?%)/i],
    ["NRR", /\b(?:NRR|net (?:revenue |dollar )?retention(?: rate)?)\b[^.]{0,60}?(\d+(?:\.\d+)?%)/i],
    ["DBNR", /\bdollar[- ]based net (?:retention|expansion)[^.]{0,60}?(\d+(?:\.\d+)?%)/i],
    ["RPO", /\b(?:RPO|remaining performance obligations?)\b[^.]{0,80}?(\$\s?[\d.,]+\s?(?:million|billion|[MB])\b)/i],
    ["Customers >$100k", /([\d,]+)\s+customers (?:with|contributing|generating) (?:more than |over |greater than )?\$100(?:,000|k|K)/i],
    ["Customers", /\b(?:total of |over |more than )?([\d,]{3,})\s+(?:total )?customers\b/i],
    ["Free cash flow", /\bfree cash flow\b[^.]{0,60}?(\$\s?[\d.,]+\s?(?:million|billion|[MB])\b)/i],
    ["Operating margin", /\b(?:non-GAAP )?operating margin\b[^.]{0,40}?(\d+(?:\.\d+)?%)/i],
    ["Gross margin", /\bgross margin\b[^.]{0,40}?(\d+(?:\.\d+)?%)/i],
    ["Guidance", /\b(?:guidance|outlook|expects?)\b[^.]{0,60}?revenue[^.]{0,40}?(\$\s?[\d.,]+\s?(?:million|billion|[MB])?\s?(?:to|-)\s?\$\s?[\d.,]+\s?(?:million|billion|[MB]))/i],
  ];
  const out = [];
  for (const [k, re] of pats) {
    const m = t.match(re);
    if (m) {
      const i = m.index;
      out.push({ kpi: k, value: m[1].replace(/\s+/g, " "), context: t.slice(Math.max(0, i - 40), i + m[0].length + 40).trim() });
    }
  }
  return out;
}

export const THEMES = { AI: /\b(AI|artificial intelligence|agentic|generative|GenAI|LLM)\b/g, growth: /\bgrowth\b/gi, platform: /\bplatform\b/gi, efficiency: /\b(efficienc\w*|margin expansion|cost (?:savings|reduction))\b/gi, restructuring: /\b(restructur\w*|reduction in force|layoffs?)\b/gi, acquisition: /\b(acqui\w+|M&A|merger)\b/gi, cloud: /\b(cloud|SaaS)\b/gi, security: /\b(security|cyber\w*)\b/gi, customers: /\bcustomers?\b/gi, recurring: /\b(recurring|subscription|ARR)\b/gi, "free cash flow": /\bfree cash flow\b/gi, debt: /\b(debt|leverage|revolver|credit facility)\b/gi };
export function themeCounts(text, extra = []) {
  const t = String(text || "");
  const out = {};
  for (const [k, re] of Object.entries(THEMES)) out[k] = (t.match(re) || []).length;
  for (const w of extra) out[w] = (t.match(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi")) || []).length;
  return out;
}

// ---------------------------------------------------------------- estimates

const SENIORITY = [
  [/\b(evp|executive vice president)\b/i, "evp"],
  [/\b(svp|senior vice president)\b/i, "svp"],
  [/\b(vp|vice president)\b/i, "vp"],
  [/\b(chief executive|ceo|co-?founder|founder|managing director)\b|^president\b/i, "c-suite-ceo"],
  [/\b(chief|cfo|cto|coo|cio|cmo|cro|cpo|chro)\b/i, "c-suite"],
  [/\bgeneral manager\b/i, "evp"],
  [/\b(head of|senior director)\b/i, "head"],
  [/\bdirector\b/i, "director"],
  [/\b(manager|lead)\b/i, "manager"],
];
export const seniorityOf = (title) => SENIORITY.find(([re]) => re.test(title || ""))?.[1] || "ic";

// Total cash + equity bands (USD) by seniority and revenue size, from public proxy medians.
const COMP = {
  "c-suite-ceo": [[1e8, 300e3, 600e3], [1e9, 1.5e6, 5e6], [1e10, 5e6, 15e6], [Infinity, 12e6, 30e6]],
  "c-suite": [[1e8, 220e3, 400e3], [1e9, 800e3, 3e6], [1e10, 2.5e6, 7e6], [Infinity, 5e6, 15e6]],
  evp: [[1e8, 200e3, 350e3], [1e9, 700e3, 2.8e6], [1e10, 2e6, 5e6], [Infinity, 4e6, 10e6]],
  svp: [[1e8, 190e3, 320e3], [1e9, 400e3, 1.2e6], [1e10, 800e3, 2.5e6], [Infinity, 1.5e6, 4e6]],
  vp: [[1e8, 170e3, 280e3], [1e9, 250e3, 600e3], [1e10, 400e3, 1.2e6], [Infinity, 600e3, 2e6]],
  head: [[1e8, 150e3, 240e3], [1e9, 200e3, 400e3], [1e10, 280e3, 600e3], [Infinity, 350e3, 800e3]],
  director: [[1e8, 130e3, 200e3], [1e9, 170e3, 300e3], [1e10, 220e3, 420e3], [Infinity, 260e3, 500e3]],
  manager: [[1e8, 100e3, 160e3], [1e9, 120e3, 200e3], [1e10, 150e3, 260e3], [Infinity, 170e3, 300e3]],
  ic: [[1e8, 80e3, 140e3], [1e9, 100e3, 180e3], [1e10, 120e3, 220e3], [Infinity, 140e3, 260e3]],
};
// Share of company headcount and revenue a seat typically owns.
const SPAN = { "c-suite-ceo": 1, "c-suite": 0.35, evp: 0.3, svp: 0.15, vp: 0.08, head: 0.04, director: 0.02, manager: 0.006, ic: 0 };

const band = (lo, hi, f = money) => `${f(lo)}-${f(hi)}`;
const r2 = (n) => Math.round(n / (n >= 1000 ? 10 : 1)) * (n >= 1000 ? 10 : 1);

/**
 * The est.* rows: ranges only, each with its inputs and formula. Never a point value.
 * inputs: { title, revenue, revenueYoY, employees, proxyComp, jobs, jobsByDept, segments, filings, revenueSource, employeesSource }
 */
export function estimates(inp) {
  const out = [];
  const lvl = seniorityOf(inp.title);
  const span = SPAN[lvl];
  const rev = inp.revenue || null;
  const emp = inp.employees || (rev ? rev / 250e3 : null); // ~$250k revenue per employee when headcount is unknown
  const empNote = inp.employees ? `employees ${inp.employees} (${inp.employeesSource || "reported"})` : rev ? `employees ≈ revenue / $250k = ${Math.round(emp)}` : null;

  if (emp && span != null && inp.title) {
    const lo = Math.max(1, r2(emp * span * 0.6));
    const hi = Math.max(lo + 1, r2(emp * span * 1.4));
    out.push({ var: "est.team_size", value: span === 0 ? "Individual contributor: no team" : `${lo}-${hi} people`, detail: { inputs: { title: inp.title, seniority: lvl, employees: Math.round(emp), employeesNote: empNote }, formula: `employees × span(${lvl}=${span}) × 0.6-1.4` } });
  }
  if (rev && span) {
    const opex = rev * 0.75;
    const lo = opex * span * 0.5;
    const hi = opex * span * 1.2;
    out.push({ var: "est.budget", value: `${band(lo, hi)} a year`, detail: { inputs: { revenue: rev, seniority: lvl }, formula: `revenue × 75% cost base × span(${span}) × 0.5-1.2` } });
  }
  if (inp.proxyComp) {
    const t = inp.proxyComp.total;
    out.push({ var: "est.comp", value: `${band(t * 0.9, t * 1.15)} (FY${inp.proxyComp.year} proxy total ${money(t)}, ±)`, detail: { inputs: { proxy: inp.proxyComp }, formula: "latest Summary Compensation Table total, −10% / +15% for the current year" } });
  } else {
    const rows = COMP[lvl] || COMP.ic;
    const [, lo, hi] = rows.find(([cap]) => (rev || 5e7) < cap);
    out.push({ var: "est.comp", value: `${band(lo, hi)} total pay${inp.title ? "" : " (title unknown: individual-contributor band)"}`, detail: { inputs: { title: inp.title, seniority: lvl, revenue: rev }, formula: `band for ${lvl} at revenue ${rev ? money(rev) : "unknown (assumed <$100M)"} from public proxy medians` } });
  }
  if (inp.revenueYoY != null) {
    const g = inp.revenueYoY;
    const hires = inp.jobs || 0;
    const tilt = emp && hires ? Math.min(0.05, hires / emp / 4) : 0;
    out.push({ var: "est.seg_growth", value: `${pct(g - 0.03 + tilt)} to ${pct(g + 0.03 + tilt)} next 12 months`, detail: { inputs: { revenueYoY: g, openRoles: hires, employees: emp && Math.round(emp) }, formula: "company revenue YoY ± 3 pts, tilted up by open roles / headcount ÷ 4 (max +5 pts)" } });
  } else if (inp.jobs != null && emp) {
    const hr = inp.jobs / emp;
    out.push({ var: "est.seg_growth", value: hr > 0.08 ? "Growing: hiring > 8% of headcount" : hr > 0.03 ? "Steady: hiring 3-8% of headcount" : "Flat or shrinking: hiring < 3% of headcount", detail: { inputs: { openRoles: inp.jobs, employees: Math.round(emp) }, formula: "open roles / headcount" } });
  }
  if (rev || emp) {
    const base = rev ? rev * 0.0004 : emp * 300;
    const mult = { "c-suite-ceo": 2, "c-suite": 1.5, evp: 1.3, svp: 1, vp: 0.8, head: 0.5, director: 0.35, manager: 0.15, ic: 0.05 }[lvl];
    const lo = Math.max(10e3, base * mult * 0.5);
    const hi = Math.max(25e3, base * mult * 2.5);
    out.push({ var: "est.deal_size", value: `${band(lo, hi)} first-year contract`, detail: { inputs: { revenue: rev, employees: emp && Math.round(emp), seniority: lvl }, formula: rev ? `revenue × 0.04% × seat multiplier(${mult}) × 0.5-2.5` : `employees × $300 × seat multiplier(${mult}) × 0.5-2.5` } });
  }
  {
    const fyEnd = inp.fiscalYearEnd; // "1130"
    let txt = "60-120 days from first meeting (typical mid-market cycle)";
    const det = { inputs: { fiscalYearEnd: fyEnd || null, seniority: lvl }, formula: "budget set in the quarter before fiscal year end; seat authority shortens the cycle" };
    if (fyEnd && /^\d{4}$/.test(fyEnd)) {
      const mo = Number(fyEnd.slice(0, 2));
      const plan = ((mo + 9) % 12) + 1; // planning runs the last 3 months of the fiscal year
      const name = (m) => new Date(2000, m - 1, 1).toLocaleString("en-US", { month: "short" });
      txt = `Budget planning ${name(plan)}-${name(mo)} (FY ends ${name(mo)}); ${/c-suite|evp/.test(lvl) ? "30-90" : "60-150"} days to sign`;
    }
    out.push({ var: "est.decision_window", value: txt, detail: det });
  }
  return out;
}
