// Pure helpers for the company-side OSINT modules (modules 50-79): SEC parsing, job-board
// parsing, table extraction and the estimate math. No network here, so the tests can feed
// fixtures straight in.

import { normName, nameIn, nameForms, firstNameForms } from "./core.mjs";

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
    .replace(ZW, "")
    .replace(/[\u2009\u202f\u00a0]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
/** Zero-width and BOM characters: some filing agents pad every table cell with them. */
const ZW = /[\u200b\u200c\u200d\u2060\ufeff]/g;

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
    .split(/(?<=[.!?]["\u201d']?)\s+(?=[A-Z"'(\u201c])/)
    .map((s) => s.replace(/\u2024/g, ".").trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------- company names

const SUFFIX = /\b(incorporated|inc|corp|corporation|co|company|companies|ltd|limited|llc|l l c|plc|lp|l p|holdings?|group|the|sa|ag|nv|se|gmbh|technologies|technology)\b/g;
export function normCompany(s) {
  return normName(String(s || "").replace(/['’]/g, "").replace(/\/[a-z]{2}\/?$/i, ""))
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

/** Revenue concepts, most specific first. Filers move between them over the years, and some
 * tag the quarter under one concept and the year under another, so each period is picked alone. */
export const REV = [
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "Revenues",
  "SalesRevenueNet",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
  "SalesRevenueGoodsNet",
  "SalesRevenueServicesNet",
  "RevenuesNetOfInterestExpense",
  "RevenueNet",
  "OperatingRevenue",
  "RegulatedAndUnregulatedOperatingRevenue",
  "ElectricUtilityRevenue",
  "RevenuesExcludingInterestAndDividends",
  "InterestAndDividendIncomeOperating",
];
const days = (a, b) => (new Date(b) - new Date(a)) / 864e5;
const isQuarter = (r) => r.start && days(r.start, r.end) > 80 && days(r.start, r.end) < 100;
const isYear = (r) => r.start && days(r.start, r.end) > 350 && days(r.start, r.end) < 380;

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

/** Newest period of one length (quarter or year) across the revenue concepts, with the same period a year earlier. */
function newestPeriod(facts, test) {
  let pick = null;
  for (const c of REV) {
    const rows = dedupe(series(facts, c).filter(test));
    if (!rows.length) continue;
    const last = rows.at(-1);
    // newest period wins; on a tie the earlier (more specific) concept in REV wins
    if (!pick || last.end > pick.last.end) pick = { concept: c, rows, last };
  }
  if (!pick) return null;
  const prior = pick.rows.find((r) => Math.abs(days(r.end, pick.last.end) - 364) < 20) ||
    // the year-ago figure can sit under another concept when the filer switched tags
    REV.flatMap((c) => dedupe(series(facts, c).filter(test))).find((r) => Math.abs(days(r.end, pick.last.end) - 364) < 20) ||
    null;
  return { concept: pick.concept, cur: pick.last, prior, yoy: prior ? pick.last.val / prior.val - 1 : null };
}

/**
 * Latest annual and quarterly revenue from companyfacts, each with the same period a year
 * earlier. The annual and the quarterly figure are chosen independently: the newest period
 * across all revenue concepts wins.
 */
export function pickRevenue(facts) {
  const y = newestPeriod(facts, isYear);
  const q = newestPeriod(facts, isQuarter);
  if (!y && !q) return null;
  return {
    concept: (y || q).concept,
    annualConcept: y?.concept || null,
    quarterConcept: q?.concept || null,
    quarter: q?.cur || null,
    priorQuarter: q?.prior || null,
    quarterYoY: q?.yoy ?? null,
    annual: y?.cur || null,
    priorAnnual: y?.prior || null,
    annualYoY: y?.yoy ?? null,
  };
}

/**
 * Newest value among concepts (instant or duration), e.g. cash or debt. Every concept is read
 * to its latest period and the newest period wins, so a concept the filer stopped using years
 * ago never stands in for this quarter. `asOf` drops values older than that date minus
 * `toleranceDays` (default: any age).
 */
export function latestFact(facts, concepts, { unit = "USD", ns = "us-gaap", duration = null, asOf = null, toleranceDays = 0 } = {}) {
  let best = null;
  for (const c of concepts) {
    for (const r of series(facts, c, unit, ns)) {
      if (duration === "quarter" && !isQuarter(r)) continue;
      if (duration === "annual" && !(r.start && days(r.start, r.end) > 350)) continue;
      if (asOf && days(r.end, asOf) > toleranceDays) continue;
      if (!best || r.end > best.end || (r.end === best.end && r.filed > best.filed)) best = { ...r, concept: c };
    }
  }
  return best;
}

/** Debt concepts, broadest first. Same-date values are not summed: the first concept in this list wins a tie. */
export const DEBT = [
  "LongTermDebt",
  "DebtLongtermAndShorttermCombinedAmount",
  "LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities",
  "LongTermDebtAndCapitalLeaseObligations",
  "LongTermDebtNoncurrent",
  "SeniorLongTermNotes",
  "SeniorNotes",
  "ConvertibleNotesPayable",
  "ConvertibleDebtNoncurrent",
  "ConvertibleNotesPayableNoncurrent",
  "ConvertibleDebt",
  "LongTermNotesPayable",
  "NotesPayable",
  "DebtInstrumentCarryingAmount",
  "LongTermLineOfCredit",
];
export const CASH = ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", "Cash", "CashAndDueFromBanks"];

/** Newest debt figure, preferring the broadest concept reported on the newest date. */
export function latestDebt(facts, opts = {}) {
  const newest = latestFact(facts, DEBT, opts);
  if (!newest) return null;
  for (const c of DEBT) {
    const r = series(facts, c).filter((x) => x.end === newest.end).sort((a, b) => (a.filed < b.filed ? 1 : -1))[0];
    if (r) return { ...r, concept: c };
  }
  return newest;
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
    title: null,
    officerTitle: tag(s, "officerTitle"),
    remarks: tag(s, "remarks"),
    trades: [],
    holdings: [],
  };
  const blocks = [
    ...[...s.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g)].map((m) => [m[1], false, true]),
    ...[...s.matchAll(/<derivativeTransaction>([\s\S]*?)<\/derivativeTransaction>/g)].map((m) => [m[1], true, true]),
    ...[...s.matchAll(/<nonDerivativeHolding>([\s\S]*?)<\/nonDerivativeHolding>/g)].map((m) => [m[1], false, false]),
    ...[...s.matchAll(/<derivativeHolding>([\s\S]*?)<\/derivativeHolding>/g)].map((m) => [m[1], true, false]),
  ];
  // "See Remarks" (or "See Remarks below") means the title is in the remarks text
  out.title = /^see remarks?\b/i.test(out.officerTitle || "") ? titleFromRemarks(out.remarks) : out.officerTitle || null;
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

/** The officer title inside a Form 4 remarks field, or null when the remarks hold something else. */
export function titleFromRemarks(remarks) {
  const r = String(remarks || "").replace(/\s+/g, " ").trim();
  if (!r) return null;
  const m = r.match(/(?:officer title|title|position)\s*:\s*([^.;]{3,100})/i);
  const t = (m ? m[1] : r.split(/(?<=[a-z]{2})\.\s|;\s|\bExhibit\b/)[0]).trim().replace(/\.$/, "");
  return t.length <= 100 && looksLikeTitle(t) && !/power of attorney|exhibit|footnote/i.test(t) ? t : null;
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
        .map((c) => htmlText(c[1]).replace(/[\u200b\u200c\u200d\ufeff\u2009]/g, "").trim())
        .filter((c) => c !== "" && c !== "$" && c !== ")" && c !== "%" && c !== "(" && c !== "-"),
    )
    .filter((r) => r.length);
}

/**
 * Summary Compensation Table row for a person in a proxy (DEF 14A).
 * Returns { found, isNeo, header, years: [{ year, cells: {col: value}, total }], neos: [names] }.
 */
export function parseSCT(html, who0) {
  const subject = typeof who0 === "string" ? { name: who0 } : who0;
  const forms = nameForms(subject);
  const last = normName(subject.name).split(" ").at(-1);
  const firsts = new Set(forms.map((n) => normName(n).split(" ")[0]));
  const marks = [...String(html).matchAll(/summary compensation table/gi)].map((m) => m.index);
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
    // full name (any first-name form) first; else the surname with a matching first initial ("J. M. Calder")
    const who =
      people.find((p) => forms.some((n) => nameIn(p.label, n))) ||
      people.find((p) => {
        const w = normName(p.label).split(" ");
        const i = w.indexOf(last);
        return last && i > 0 && [...firsts].some((f) => w[0] === f || w[0] === f[0]);
      });
    const cols = header.slice(yearIdx >= 0 ? yearIdx + 1 : 2);
    const map = (yr) => {
      const vals = yr.slice(1);
      const cells = {};
      // align from the right: Total is always last, missing columns are blank on the left
      const off = cols.length - vals.length;
      vals.forEach((v, i) => (cells[cols[off > 0 && i === 0 && /salary/i.test(cols[0]) ? 0 : i + Math.max(0, off)] || `col${i}`] = num(v)));
      return { year: Number(yr[0]), cells, total: num(vals.at(-1)) };
    };
    if (!who) return { found: true, isNeo: false, header, neos, years: [] };
    return { found: true, isNeo: true, label: who.label, title: titleFromLabel(who.label), header, neos, years: who.years.map(map).sort((a, b) => b.year - a.year) };
  }
  return { found: false, isNeo: false, years: [], neos: [] };
}

/** "J. M. Calder Vice President and President, Power Systems" -> "Vice President and President, Power Systems". */
export function titleFromLabel(label) {
  const t = String(label || "").replace(/\(\d+\)/g, " ").replace(/\s+/g, " ").trim();
  let i = t.search(TITLE_WORDS);
  if (i <= 0) return null;
  // keep the qualifiers in front: "Executive Vice President", "Senior Vice President", "Group President"
  const pre = t.slice(0, i).match(/((?:(?:Executive|Senior|Sr\.?|Group|Corporate|Deputy|Assistant|Associate|Interim|Acting|Regional|Global|Former)\s+)+)$/);
  if (pre) i -= pre[1].length;
  const out = t.slice(i).replace(/^[,\s-]+|[,\s-]+$/g, "");
  return looksLikeTitle(out) ? out : null;
}

/** Sentences that read as a career bio, not a pay discussion that happens to name the person. */
export const BIO_RE = /(,\s*age\s+\d{2}\b|has served as|serves as|has been (?:our|the)|joined (?:us|the company|[A-Z])|is (?:our|the) [A-Z]|was (?:appointed|named|promoted))/;
export const isBio = (text) => BIO_RE.test(String(text || ""));

/**
 * A person's bio paragraph from a filing or web page. A run starts at a prose sentence naming
 * the person (full name in any first-name form, or "Ms./Mr. Last") and continues through
 * sentences that name them again or carry on with a pronoun. It stops at the next sentence that
 * introduces someone else ("Daniel Ramos, age 57, has served..." or "Mr. Bradley joined..."),
 * so a proxy's officer list never mixes two people's careers.
 * `who` is a name or a subject { name, aliases }.
 */
export function bioFrom(text, who, { max = 2200 } = {}) {
  const subject = typeof who === "string" ? { name: who } : who;
  const forms = nameForms(subject);
  const parts = normName(subject.name).split(" ");
  const last = parts.at(-1);
  const firsts = [...new Set(forms.map((n) => normName(n).split(" ")[0]))];
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const F = firsts.map((f) => esc(cap(f))).join("|");
  const L = esc(cap(last));
  const reFull = new RegExp(`\\b(?:(?:${F})\\s+(?:[A-Z]\\.?\\s+|[A-Z][a-z]+\\s+)?${L}|(?:Mr|Ms|Mrs|Dr)\\.?\\s+${L})\\b`);
  const reFirst = new RegExp(`\\b(?:${F})\\b`);
  const prose = (x) => {
    if (x.length < 20 || x.length > 450) return false;
    if ((x.match(/\d[\d,.]*/g) || []).length > 6 || (x.match(/\d/g) || []).length / x.length >= 0.12) return false;
    // a table squeezed into one "sentence" is mostly capitalised words
    const words = x.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w));
    return words.length < 6 || words.filter((w) => /^[a-z]/.test(w)).length / words.length >= 0.25;
  };
  // a sentence that opens on another person: "Kevin Bradley, age 41, ..." / "Mr. Bradley holds ..."
  const OTHER_FULL = /^(?:(?:Mr|Ms|Mrs|Dr)\.?\s+)?([A-Z][a-z]+(?:\s+[A-Z]\.)?(?:\s+[A-Z][a-z]+\.?)?\s+[A-Z][A-Za-z'-]+)\s*,\s*(?:age\s+)?\d{2}\b/;
  const OTHER_HON = /^(?:Mr|Ms|Mrs|Dr|Messrs)\.?\s+([A-Z][A-Za-z'-]+)/;
  const startsOther = (x) => {
    const m = x.match(OTHER_FULL);
    if (m && !forms.some((n) => nameIn(m[1], n))) return true;
    const h = x.match(OTHER_HON);
    return !!(h && normName(h[1]) !== last);
  };
  const ss = sentences(text);
  const PRON = /^(She|He|They|Her|His|Their|Prior|Before|Previously|Earlier|Since|From|In \d{4}|Additionally|Most recently|Under (?:her|his|their))\b/;
  const runs = [];
  for (let i = 0; i < ss.length; i++) {
    if (!prose(ss[i]) || !reFull.test(ss[i]) || startsOther(ss[i])) continue;
    let j = i + 1;
    while (j < ss.length && j < i + 16 && prose(ss[j]) && !startsOther(ss[j]) && (reFull.test(ss[j]) || reFirst.test(ss[j]) || PRON.test(ss[j]))) j++;
    const prev = runs.at(-1);
    if (prev && i - prev.end <= 3 && ss.slice(prev.end, i).every((x) => prose(x) && !startsOther(x))) prev.end = j;
    else runs.push({ start: i, end: j });
    i = j - 1;
  }
  // a real bio ("age 50, has served as", "joined us in") beats a longer run of footnotes that name them
  const BIO = BIO_RE;
  const NOISE = /^\(\d+\)|\bSee "|per share|vest(?:s|ing)? (?:in|on)|installments/;
  let best = [];
  let bestScore = -1;
  for (const r of runs) {
    const cand = ss.slice(r.start, r.end);
    const len = cand.join(" ").length;
    const score = len + (BIO.test(cand.join(" ")) ? 5000 : 0) - cand.filter((x) => NOISE.test(x)).length * 400;
    if (score > bestScore) (best = cand), (bestScore = score);
  }
  const out = best.join(" ");
  return out.length > max ? out.slice(0, max) + "..." : out;
}

const DEGREE = /\b(Ph\.?\s?D|M\.?B\.?A|J\.?D|M\.?D|B\.?S\.?(?:M\.?E\.?T)?|B\.?A|M\.?S|M\.?A|B\.?Eng|M\.?Eng|BSc|MSc|Bachelor(?:'s)?(?: of [A-Z][A-Za-z ]+| degree)?|Master(?:'s)?(?: of [A-Z][A-Za-z ]+| degree)?|doctorate|LL\.?M|CPA)\b/;
const SCHOOL = /((?:the\s+)?(?:University of [A-Z][A-Za-z.&' -]+|[A-Z][A-Za-z.&' -]+ (?:University|College|Institute of Technology|Institute|School of [A-Z][A-Za-z]+|Business School|Law School)|[A-Z]{3,6}(?= with| in|,| and)|Harvard|Yale|Stanford|MIT|Wharton|INSEAD|Princeton|Columbia|Dartmouth|Cornell))/;
/**
 * Degree + school sentences in a bio. A sentence counts when it names a degree, or a real
 * institution together with a study verb; "earned" alone (as in "earned the 2025 grant") does not.
 */
export function educationFrom(bio) {
  const out = [];
  const INSTITUTION = /\b(University|College|Institute|School|Academy|Polytechnic|Conservatory|Harvard|Yale|Stanford|MIT|Wharton|INSEAD|Princeton|Columbia|Dartmouth|Cornell|Oxford|Cambridge|NJIT|UCLA|USC|NYU|LSE)\b/;
  for (const s of sentences(bio)) {
    if (/\b(grant|award|bonus|vest|incentive|shares|stock|payout|compensation)\b/i.test(s)) continue;
    const degree = s.match(DEGREE)?.[0];
    const studied = /(graduat|degree|alumn|studied|attended|diploma)/i.test(s);
    const school = INSTITUTION.test(s) ? s.match(SCHOOL)?.[1] : null;
    if ((degree && (school || studied || /\b(holds|earned|received|completed)\b/i.test(s))) || (school && studied)) out.push(s.length > 260 ? s.slice(0, 260) + "..." : s);
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
  // capitalised words, joined by "of" / "and" / "for" / "&" / a comma: "Senior Director of Human Resources",
  // "Senior Vice President, Global Commercial"
  const W = "[A-Z][\\w&'-]*";
  const m =
    bio.match(new RegExp(`(?:holds the position of|position of|(?:has served|serves|serving) as (?:our |the )?|currently (?:serves|is) (?:as )?(?:our |the )?)\\s*(${W}(?:(?:,\\s|\\s(?:(?:of|and|for|&)\\s)?)${W}){0,8})`)) ||
    bio.match(/\bis (?:the |our )?((?:[A-Z][\w&'-]*\s?){1,7}?) (?:of|at) [A-Z]/) ||
    bio.match(/\bas (?:the |our )?((?:Chief|Senior|Executive|Vice|VP|SVP|EVP|Director|Head|General|President|Global|Managing)[\w&,' -]{2,80}?)(?=[.;]|,(?!\s(?:[A-Z][\w&-]*\s?){1,4}(?:[.;]|\s(?:and|at|where)\b))| of the| for| and| at| in| where|\s[a-z])/);
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
    let titleFrom = "element";
    for (const x of next) {
      if (x.length > 100 || /[.!?]\s|\b(is|was|has|joined|leads)\b/.test(x)) break;
      if (looksLikeName(x)) break;
      if (looksLikeTitle(x)) {
        title = x;
        break;
      }
    }
    const bio = next.find((x) => x.length > 60 && (x.includes(b.split(" ").at(-1)) || x.includes(b.split(" ")[0]))) || "";
    if (!title && bio) (title = titleFromBio(bio)), (titleFrom = "prose");
    if (!title) continue;
    if (/\s(at|@)\s+\S/.test(title)) continue; // "VP Product at OtherCo": a customer quote or testimonial, not this company's team
    seen.add(b);
    const img = blocks[i].img && (normName(blocks[i].img.alt).includes(normName(b).split(" ").at(-1)) || normName(blocks[i].img.src).includes(normName(b).split(" ").at(-1))) ? blocks[i].img.src : null;
    people.push({ name: b, title, titleFrom, bio, img });
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
  } catch (e) {
    console.warn(`parseJobs(${kind}): unexpected payload shape (${e.message}); treated as no jobs`);
  }
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
    // a customer count only in KPI phrasing ("ended the quarter with 12,400 customers", "customers grew to 5,100"),
    // never a sentence like "more than 500 customers and dealers attended"
    ["Customers", /\b(?:(?:ended|closed|finished) (?:the )?(?:quarter|year|period) with|(?:total|number of) (?:paying |active )?customers (?:grew |increased )?(?:to|of|was)|now (?:serves|serve|has|have)|serv(?:es|ing) (?:over |more than |approximately )?|(?:paying|active|enterprise|total) customers(?: of)?:?)\s*(?:over |more than |approximately |about )?([\d,]{3,})(?:\s+(?:paying |active |enterprise |total )?customers)?(?=[\s.,;)]|$)(?![^.]{0,25}\b(?:and dealers|attended|the opportunity|partners and))/i],
    ["Free cash flow", /\bfree cash flow\b[^.]{0,60}?(\$\s?[\d.,]+\s?(?:million|billion|[MB])\b)/i],
    ["Operating margin", /\b(?:non-GAAP )?operating margin\b[^.]{0,40}?(\d+(?:\.\d+)?%)/i],
    ["Gross margin", /\bgross margin\b[^.]{0,40}?(\d+(?:\.\d+)?%)/i],
    ["Guidance", /\b(?:guidance|outlook|expects?)\b[^.]{0,60}?revenue[^.]{0,40}?(\$\s?[\d.,]+\s?(?:million|billion|[MB])?\s?(?:to|-)\s?\$\s?[\d.,]+\s?(?:million|billion|[MB]))/i],
  ];
  const out = [];
  // the period a flow figure covers, read from the same sentence: "for the nine months ended September 30"
  const PERIOD = /\b(?:for the |in the |during the )?((?:three|six|nine|twelve)[- ]months?(?: ended [A-Z][a-z]+ \d{1,2}(?:, \d{4})?)?|(?:third|second|first|fourth) quarter(?: of (?:fiscal )?\d{4})?|(?:fiscal )?(?:year|full[- ]year)(?: \d{4})?(?: ended [A-Z][a-z]+ \d{1,2}(?:, \d{4})?)?|trailing twelve months|year[- ]to[- ]date|Q[1-4](?: \d{4})?)\b/i;
  for (const [k, re] of pats) {
    const m = t.match(re);
    if (m) {
      const i = m.index;
      const sStart = Math.max(t.lastIndexOf(". ", i) + 2, i - 300, 0);
      const sEnd = t.indexOf(". ", i + m[0].length);
      const sentence = t.slice(sStart, sEnd < 0 ? i + m[0].length + 200 : sEnd + 1);
      const period = /Free cash flow|Operating margin|Gross margin|Customers >\$100k/.test(k) ? sentence.match(PERIOD)?.[1] || null : null;
      out.push({ kpi: k, value: m[1].replace(/\s+/g, " ").replace(/,$/, "") + (period ? ` (${period})` : ""), period, context: t.slice(Math.max(0, i - 40), i + m[0].length + 40).trim() });
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

// Order matters: a CEO first, then a segment or business-unit president ("President, Power
// Systems", "Vice President and President, Power Systems", "President of Platforms Business"),
// which runs a P&L and sits at EVP level whatever else the title says, then the VP ladder.
const SENIORITY = [
  [/\b(chief executive|ceo|co-?founder|founder|managing director)\b|^president$|^president and (?:ceo|chief executive)/i, "c-suite-ceo"],
  [/(?<!vice[- ])\bpresident\b\s*(?:,|of\b|-|\u2013|\u2014|\bfor\b)|(?<!vice[- ])\b(?:segment|group|division|business unit) president\b/i, "evp"],
  [/\b(evp|executive vice president)\b/i, "evp"],
  [/\b(svp|senior vice president|senior vp)\b/i, "svp"],
  [/\b(vp|vice president)\b/i, "vp"],
  [/^president\b/i, "c-suite-ceo"],
  [/\b(chief|cfo|cto|coo|cio|cmo|cro|cpo|chro)\b/i, "c-suite"],
  [/\bgeneral manager\b/i, "evp"],
  [/\b(head of|senior director)\b/i, "head"],
  [/\bdirector\b/i, "director"],
  [/\b(manager|lead)\b/i, "manager"],
];
const expandTitle = (t) =>
  String(t || "")
    .replace(/\bPres\b\.?/gi, "President")
    .replace(/\bSr\b\.?/gi, "Senior")
    .replace(/\bExec\b\.?/gi, "Executive")
    .replace(/\bV\.?P\b\.?/g, "VP")
    .replace(/\s+/g, " ")
    .trim();
export const seniorityOf = (title) => SENIORITY.find(([re]) => re.test(expandTitle(title)))?.[1] || "ic";

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
// For VP and above, the function decides the share of headcount: operations at a manufacturer is
// most of the company, finance is a small team. Applied instead of SPAN when the title names one.
const FUNC_SPAN = [
  [/operations|manufactur|supply chain|production|plant|logistics/i, 0.45],
  [/engineering|product development|r&d|research/i, 0.3],
  [/sales|commercial|revenue|go[- ]to[- ]market/i, 0.2],
  [/customer (?:success|support|experience)|services/i, 0.15],
  [/marketing/i, 0.06],
  [/finance|legal|people|\bhr\b|human resources|talent|counsel/i, 0.04],
];
export function spanOf(title) {
  const lvl = seniorityOf(title);
  const base = SPAN[lvl];
  if (!/^(vp|svp|evp|c-suite)$/.test(lvl)) return { lvl, span: base, how: `span(${lvl}=${base})` };
  const f = FUNC_SPAN.find(([re]) => re.test(expandTitle(title)));
  if (!f) return { lvl, span: base, how: `span(${lvl}=${base})` };
  // a function span never shrinks a seat below its seniority span
  const span = Math.max(base, f[1]);
  return { lvl, span, how: `function span(${f[0].source.split("|")[0]}=${f[1]}) for ${lvl}` };
}

/**
 * Title evidence, strongest first: the proxy pay table or the company's own leadership page,
 * then the Form 4 officer title, then the --title the user gave, then search results.
 */
export const TITLE_RANK = { proxy: 1, leadership: 1, form4: 2, given: 3, search: 4 };
export function bestTitle(cands = []) {
  return [...cands].filter((c) => c && c.title && !/^see remarks?\b/i.test(c.title)).sort((a, b) => (TITLE_RANK[a.source] ?? 9) - (TITLE_RANK[b.source] ?? 9))[0] || null;
}

const band = (lo, hi, f = money) => `${f(lo)}-${f(hi)}`;
const r2 = (n) => Math.round(n / (n >= 1000 ? 10 : 1)) * (n >= 1000 ? 10 : 1);
const withRef = (v, ref) => (v == null ? null : ref ? `${v} (${ref})` : String(v));

/**
 * The est.* rows: ranges only, each with its inputs (and the ledger id each input came from)
 * and its formula. Never a point value. A missing input means a missing estimate, not a guess.
 * inputs: { title, titleSource, revenue, revenueYoY, employees, employeesSource, proxyComp, jobs,
 *           fiscalYearEnd, refs: { title, revenue, revenueYoY, employees, proxyComp, jobs, fiscalYearEnd } }
 */
export function estimates(inp) {
  const out = [];
  const refs = inp.refs || {};
  const { lvl, span, how } = spanOf(inp.title);
  const rev = inp.revenue || null;
  const stale = /stale|\b(19|20)\d\d\b/.test(inp.employeesSource || "") && staleYear(inp.employeesSource);
  const emp = inp.employees || (rev ? rev / 250e3 : null); // ~$250k revenue per employee when headcount is unknown
  const empNote = inp.employees ? `employees ${inp.employees} (${inp.employeesSource || "reported"})` : rev ? `employees ≈ revenue / $250k = ${Math.round(emp)}` : null;
  const ids = (...k) => [...new Set(k.map((x) => refs[x]).filter(Boolean))];
  const titleIn = inp.title ? `${inp.title}${inp.titleSource ? ` [${inp.titleSource}]` : ""}` : null;
  const push = (var_, value, inputs, formula, keys) => out.push({ var: var_, value, detail: { inputs, formula, ledgerIds: ids(...keys) } });

  if (emp && span != null && inp.title) {
    const lo = Math.max(1, r2(emp * span * 0.6));
    const hi = Math.max(lo + 1, r2(emp * span * 1.4));
    push("est.team_size", span === 0 ? "Individual contributor: no team" : `${lo}-${hi} people`, { title: withRef(titleIn, refs.title), seniority: lvl, employees: withRef(Math.round(emp), refs.employees), employeesNote: empNote }, `employees × ${how} × 0.6-1.4`, ["title", "employees", "revenue"]);
  }
  if (rev && span && inp.title) {
    const opex = rev * 0.75;
    const lo = opex * span * 0.5;
    const hi = opex * span * 1.2;
    push("est.budget", `${band(lo, hi)} a year`, { revenue: withRef(money(rev), refs.revenue), title: withRef(titleIn, refs.title), seniority: lvl }, `revenue × 75% cost base × ${how} × 0.5-1.2`, ["revenue", "title"]);
  }
  if (inp.proxyComp) {
    const t = inp.proxyComp.total;
    push("est.comp", `${band(t * 0.9, t * 1.15)} (FY${inp.proxyComp.year} proxy total ${money(t)}, ±)`, { proxy: withRef(`FY${inp.proxyComp.year} total ${money(t)}`, refs.proxyComp) }, "latest Summary Compensation Table total, −10% / +15% for the current year", ["proxyComp"]);
  } else if (inp.title) {
    const rows = COMP[lvl] || COMP.ic;
    const [, lo, hi] = rows.find(([cap]) => (rev || 5e7) < cap);
    push("est.comp", `${band(lo, hi)} total pay`, { title: withRef(titleIn, refs.title), seniority: lvl, revenue: withRef(rev ? money(rev) : "unknown (assumed <$100M)", refs.revenue) }, `band for ${lvl} at revenue ${rev ? money(rev) : "unknown (assumed <$100M)"} from public proxy medians`, ["title", "revenue"]);
  }
  if (inp.revenueYoY != null) {
    const g = inp.revenueYoY;
    const hires = inp.jobs || 0;
    const tilt = emp && hires && !stale ? Math.min(0.05, hires / emp / 4) : 0;
    push("est.seg_growth", `${pct(g - 0.03 + tilt)} to ${pct(g + 0.03 + tilt)} next 12 months`, { revenueYoY: withRef(pct(g), refs.revenueYoY), openRoles: withRef(hires, refs.jobs), employees: withRef(emp && Math.round(emp), refs.employees) }, `company revenue YoY ± 3 pts${tilt ? ", tilted up by open roles / headcount ÷ 4 (max +5 pts)" : ""}`, ["revenueYoY", "jobs", "employees"]);
  } else if (inp.jobs != null && inp.employees && !stale) {
    const hr = inp.jobs / emp;
    push("est.seg_growth", hr > 0.08 ? "Growing: hiring > 8% of headcount" : hr > 0.03 ? "Steady: hiring 3-8% of headcount" : "Flat or shrinking: hiring < 3% of headcount", { openRoles: withRef(inp.jobs, refs.jobs), employees: withRef(Math.round(emp), refs.employees), employeesNote: empNote }, "open roles / headcount", ["jobs", "employees"]);
  }
  if ((rev || (emp && !stale)) && inp.title) {
    const base = rev ? rev * 0.0004 : emp * 300;
    const mult = { "c-suite-ceo": 2, "c-suite": 1.5, evp: 1.3, svp: 1, vp: 0.8, head: 0.5, director: 0.35, manager: 0.15, ic: 0.05 }[lvl];
    const lo = Math.max(10e3, base * mult * 0.5);
    const hi = Math.max(25e3, base * mult * 2.5);
    push("est.deal_size", `${band(lo, hi)} first-year contract`, { revenue: withRef(rev && money(rev), refs.revenue), employees: withRef(emp && Math.round(emp), refs.employees), title: withRef(titleIn, refs.title), seniority: lvl }, rev ? `revenue × 0.04% × seat multiplier(${mult}) × 0.5-2.5` : `employees × $300 × seat multiplier(${mult}) × 0.5-2.5`, ["revenue", "employees", "title"]);
  }
  {
    const fyEnd = inp.fiscalYearEnd; // "1130"
    let txt = "60-120 days from first meeting (typical mid-market cycle)";
    const inputs = { fiscalYearEnd: withRef(fyEnd || null, refs.fiscalYearEnd), seniority: lvl };
    if (fyEnd && /^\d{4}$/.test(fyEnd)) {
      const mo = Number(fyEnd.slice(0, 2));
      const plan = ((mo + 9) % 12) + 1; // planning runs the last 3 months of the fiscal year
      const name = (m) => new Date(2000, m - 1, 1).toLocaleString("en-US", { month: "short" });
      txt = `Budget planning ${name(plan)}-${name(mo)} (FY ends ${name(mo)}); ${/c-suite|evp/.test(lvl) ? "30-90" : "60-150"} days to sign`;
    }
    push("est.decision_window", txt, inputs, "budget set in the quarter before fiscal year end; seat authority shortens the cycle", ["fiscalYearEnd", "title"]);
  }
  return out;
}

/** A headcount source more than two years old (or marked stale) cannot carry a growth or deal-size estimate. */
function staleYear(src) {
  if (/stale/i.test(src)) return true;
  const y = Number(String(src).match(/\b(19|20)\d\d\b/g)?.at(-1));
  return Number.isFinite(y) && y < new Date().getFullYear() - 2;
}

// ---------------------------------------------------------------- departures

const LEFT_VERB = "(?:(?:decision|intention|intent|plans?) to (?:step down|resign|retire|leave|depart)|(?:planned |upcoming |pending )?retirement|has left|left|leaves|is leaving|quits|quit|departs|departed|is departing|will depart|resigned|resigns|has resigned|will resign|stepped down|steps down|will step down|is stepping down|retired|retires|will retire|exits|exited|was terminated|separated from)";
const JOIN_VERB = "(?:joins|joined|has joined|to join|will join|named|appointed|hired|taps|tapped|appoints|names|hires|lands at|moves to|heads to)";
const JOIN_DIRECT = "(?:joins|joined|has joined|is joining|to join|will join|lands at|moves to|heads to|jumps to|defects to)";
const APPOINTED = "(?:named|appointed|hired|tapped|promoted|elected)";
const ORG = "((?:[A-Z][\\w&.'-]*)(?:\\s+(?:[A-Z][\\w&.'-]*|&|of|and|de))*)";

/**
 * Does a headline, news line or filing sentence say the subject left the company (or now works
 * somewhere else)? Returns { left: true, newCompany, why } or null. Pure: the run step feeds it
 * every ledger row that could carry the news (8-Ks, company press, news and search titles).
 * Guards: the text must name the subject; "X appoints <subject>" where X is the subject's own
 * company is an appointment, not a departure; "succeeds Jane Doe, who retired" is about Jane.
 */
export function departureFrom(text, subject) {
  const t = String(text || "").replace(/\s+/g, " ");
  if (!t) return null;
  const forms = nameForms(subject);
  const last = normName(subject.name).split(" ").at(-1);
  const hit = forms.map((n) => ({ n, i: findName(t, n) })).find((x) => x.i >= 0) || (findHonorific(t, last) >= 0 ? { n: last, i: findHonorific(t, last) } : null);
  if (!hit) return null;
  const co = normCompany(subject.company || "");
  const isOwn = (org) => {
    const o = normCompany(org);
    return !!co && !!o && (o === co || o.split(" ").every((w) => co.split(" ").includes(w)) || co.split(" ").every((w) => o.split(" ").includes(w)));
  };
  const coWords = co ? new RegExp(`\\b${co.split(" ").map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s.,-]*")}\\b`, "i") : null;
  // a bio line about an earlier job ("Prior to joining us, he joined MicroStrategy in 2010") is history, not news
  if (/\b(prior to|previously|before joining|earlier in (?:his|her|their) career|from (?:19|20)\d\d to|until (?:19|20)\d\d|began (?:his|her|their) career)\b/i.test(t)) return null;
  const after = t.slice(hit.i).replace(/^(Mr|Ms|Mrs|Dr)\./, "$1").replace(/^(\w+\s+[A-Z])\./, "$1");
  const before = t.slice(Math.max(0, hit.i - 120), hit.i);
  // 1. "Former Lumen Arcade VP Steve Ferrante ..." / "ex-Acme CFO Jane Doe"
  if (coWords && new RegExp(`\\b(?:former|ex-|onetime|one-time)\\s*${coWords.source}`, "i").test(before)) {
    const j = after.match(new RegExp(`\\b${JOIN_VERB}\\b[^.]{0,80}?\\b(?:at|to|by|as [^.]{0,60}? (?:at|of))\\s+${ORG}`));
    return { left: true, newCompany: j && !isOwn(j[2] || j[1]) ? clean(j.at(-1)) : null, why: "described as former" };
  }
  // 2. "<subject> quits / leaves / resigns" within the same clause, not after "succeed(s) ... who"
  const lv = after.match(new RegExp(`^[^.;]{0,90}?\\b${LEFT_VERB}\\b`, "i"));
  if (lv && !/\b(succeed|replac|follow|after|who|whose)\w*\b/i.test(lv[0].slice(hit.n.length))) {
    const j = after.match(new RegExp(`\\b(?:to (?:join|take up [^.]{0,40}? at|become [^.]{0,60}? (?:at|of))|for|joins|joining)\\s+${ORG}`));
    const nc = j && !isOwn(j[1]) && !/^(the|a|an|personal|family|other)\b/i.test(j[1]) ? clean(j[1]) : null;
    return { left: true, newCompany: nc, why: "says they left" };
  }
  // 3. "<subject> joins Kestrel Studios" / "Kestrel Studios appoints <subject>" / "<subject> appointed CBO at Kestrel"
  const jn = after.match(new RegExp(`^[^.;]{0,40}?\\b${JOIN_DIRECT}\\s+(?:the\\s+)?${ORG}`)) || after.match(new RegExp(`^[^.;]{0,40}?\\b${APPOINTED}\\b[^.;]{0,80}?\\s(?:at|by|to join)\\s+${ORG}`));
  if (jn && !isOwn(jn[1]) && !/^(the|a|an|as|our|its|their|chief|president|vice|senior|executive|head|director|ceo|cfo|cto|coo|board)\b/i.test(jn[1])) return { left: true, newCompany: clean(jn[1]), why: "joined another company" };
  const by = before.match(new RegExp(`${ORG}\\s+(?:appoints|names|hires|taps|welcomes|adds)\\s+(?:[^.]{0,40}\\s)?$`));
  if (by && !isOwn(by[1]) && coWords) return { left: true, newCompany: clean(by[1]), why: "hired by another company" };
  return null;
}
const clean = (s) => String(s || "").replace(/\s+(?:as|in|on|after|and|&)$/i, "").replace(/[.,;:]+$/, "").trim().slice(0, 60) || null;
function findName(t, n) {
  const p = n.split(/\s+/);
  const re = new RegExp(`\\b${p[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(?:[A-Z]\\.?\\s+)?${p.at(-1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  return t.search(re);
}
function findHonorific(t, last) {
  return t.search(new RegExp(`\\b(?:Mr|Ms|Mrs|Dr)\\.?\\s+${last}\\b`, "i"));
}

// ---------------------------------------------------------------- PACs and parked domains

const PAC_WORDS = /\b(political|action|committee|pac|employees?|federal|good|government|fund|for|the|of|and|inc|incorporated|corp|corporation|company|co|llc|ltd|plc|holdings?|group|voluntary|associates|people|citizens|responsible|better|nonpartisan|non partisan|separate|segregated|team|usa|us|america|american|north|international|state|national|com)\b/g;
/**
 * Is an FEC committee the company's own PAC? Candidate committees never are; a PAC is only when
 * its connected organisation (or, failing that, its name with the PAC words removed) is the
 * company itself. "Halvorsen Inc. Political Action Committee" yes; "Bud Halvorsen Campaign",
 * "Halvorsen for Congress" and "Halvorsen-Ferrante Corp Employees for Good Government" no.
 */
export function isCompanyPac(c, company) {
  if (!c || !company) return false;
  if (["H", "S", "P"].includes(c.committee_type) || (c.candidate_ids || c.sponsor_candidate_ids || []).length) return false;
  if (/\b(for (congress|senate|president|governor|house|america)|campaign|friends of|victory|re-?elect|elect)\b/i.test(c.name || "")) return false;
  const co = normCompany(company);
  if (!co) return false;
  const strip = (x) => normName(x).replace(PAC_WORDS, " ").replace(/\s+/g, " ").trim();
  const conn0 = c.connected_organization_name || c.affiliated_committee_name || "";
  const conn = /^(none|n\/?a|null|unknown|)$/i.test(String(conn0).trim()) ? "" : conn0;
  if (conn && normCompany(conn) === co) return true;
  if (conn && strip(conn) && strip(conn) !== strip(co)) return false;
  return strip(c.name || "") === strip(co) && !!strip(co);
}

/** A parked or for-sale page (the domain belonged to someone else, or to no one, at that date). */
export function isParkedPage(html) {
  const t = htmlText(String(html || "").slice(0, 60000)).toLowerCase();
  if (t.length < 40) return true;
  return /(this domain (?:name )?(?:is|may be) for sale|domain (?:is )?for sale|buy this domain|make an offer on this domain|hugedomains|sedo(?:parking)?\b|dan\.com|afternic|parked (?:free|by|domain)|domain parking|this web page is parked|godaddy\.com.{0,40}parked|is available for purchase|future home of something quite cool|website coming soon|under construction)/i.test(t);
}

/** The subject's title from the best evidence any module has published, else --title. */
export function titleFor(shared = {}, subject = {}) {
  const c = [...(shared.titles || [])];
  if (subject.title) c.push({ title: subject.title, source: "given", ref: null });
  if (shared.roleTitle && !c.some((x) => x.title === shared.roleTitle)) c.push({ title: shared.roleTitle, source: "search", ref: null });
  return bestTitle(c);
}
