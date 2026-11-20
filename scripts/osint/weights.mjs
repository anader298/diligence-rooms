// Identity weights and the independent-signal rule, read from config/osint-weights.json.
//
// Identity: every candidate account gets binary features (scoreCandidate in 30-identity.mjs).
// Each feature carries a weight in bits (log2 of a likelihood ratio, fitted on labelled
// candidates by scripts/osint/fit-weights.mjs); p = 1 / (1 + 2^-(prior + sum of bits)).
// The verdict needs the probability AND independent evidence: verified needs two signal
// families from two different sources (the account page itself is one source).
//
// Rows: a row stays Verified only when two independent signals agree (sourceFamily below:
// different source families, not two pages from one site), or when it is a primary record
// (a registry or the company's own system of record, tied to the subject by a key, not a name).
// Everything else is shown as Partly verified. The weights version is written on every row.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const WEIGHTS_FILE = join(HERE, "..", "..", "config", "osint-weights.json");

/** Built-in fallback (the hand values of version 1) so a missing config never stops a run. */
export const DEFAULT_WEIGHTS = {
  version: 1,
  id: "osint-weights@1",
  fitted: null,
  identity: {
    prior: -4,
    features: {
      name: 2, employer_on_profile: 5, company_text: 4, career: 4, link: 4, place: 2, title: 2, image: 3, handle_peer: 2,
      employer_contra: -3, place_contra: -3, derived_handle: 0, empty_profile: 0, name_partial: 0,
    },
    thresholds: { verified: 0.99, likely: 0.9, namesake: 0.05 },
  },
};

let cached = null;
/** The weights in force: config/osint-weights.json, else the built-in version 1. */
export function loadWeights(file = WEIGHTS_FILE) {
  if (cached && cached.file === file) return cached.w;
  let w = DEFAULT_WEIGHTS;
  if (existsSync(file)) {
    try {
      w = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      console.warn(`osint weights: ${file} unreadable (${e.message}); using built-in version 1`);
    }
  }
  w.id ||= `osint-weights@${w.version}`;
  cached = { file, w };
  return w;
}

/** Log-odds (bits) and probability for one candidate's features under the given weights. */
export function identityProb(features, w = loadWeights()) {
  const W = w.identity.features;
  let bits = w.identity.prior;
  const parts = [];
  for (const [k, on] of Object.entries(features)) {
    if (!on || W[k] == null) continue;
    bits += W[k];
    parts.push(`${k} ${W[k] >= 0 ? "+" : ""}${round(W[k])}`);
  }
  return { bits: round(bits), p: 1 / (1 + 2 ** -bits), parts };
}
const round = (x) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------- source families

const FAMILIES = [
  [/(^|\.)sec\.gov$/, "sec"],
  [/(^|\.)fec\.gov$/, "fec"],
  [/(^|\.)usaspending\.gov$/, "usaspending"],
  [/(^|\.)lda\.gov$|(^|\.)senate\.gov$/, "lda"],
  [/(^|\.)dol\.gov$/, "dol"],
  [/(^|\.)treasury\.gov$|(^|\.)oig\.hhs\.gov$|(^|\.)opensanctions\.org$/, "sanctions"],
  [/(^|\.)courtlistener\.com$/, "courts"],
  [/(^|\.)uspto\.gov$|patents\.google\.com$|(^|\.)patentsview\.org$/, "patents"],
  [/(^|\.)irs\.gov$|projects\.propublica\.org$/, "irs"],
  [/(^|\.)wikidata\.org$|(^|\.)wikipedia\.org$/, "wiki"],
  [/(^|\.)linkedin\.com$/, "linkedin"],
  [/web\.archive\.org$/, "archive"],
  [/^crt\.sh$/, "ct-logs"],
  [/^dns\.google$/, "dns"],
  [/news\.google\.com$/, "news"],
  [/(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|gem\.com|workable\.com|myworkdayjobs\.com|smartrecruiters\.com|jobvite\.com|paylocity\.com|bamboohr\.com|icims\.com|recruitee\.com|breezy\.hr|rippling\.com)$/, "ats"],
];

export function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** Registrable part of a host: "investors.progress.com" -> "progress.com". */
function siteOf(host) {
  const p = host.split(".");
  if (p.length <= 2) return host;
  const two = p.slice(-2).join(".");
  return /^(co|com|org|net|gov|ac)\.[a-z]{2}$/.test(two) ? p.slice(-3).join(".") : two;
}

/**
 * The source family of a URL: one per registry, "company-site" for the subject's own domain,
 * otherwise the registrable site (two pages on one site are one family).
 */
export function sourceFamily(url, subject = {}) {
  const h = hostOf(url);
  if (!h) return null;
  const dom = String(subject.domain || "").toLowerCase().replace(/^www\./, "");
  if (dom && (h === dom || h.endsWith("." + dom))) return "company-site";
  for (const [re, fam] of FAMILIES) if (re.test(h)) return fam;
  return siteOf(h);
}

// ---------------------------------------------------------------- the two-signal rule

const STOP = new Set("the a an and or of to in for on at by with from as is was are be this that its it his her their per since llc inc corp".split(" "));
function tokens(v) {
  return new Set(
    String(typeof v === "string" ? v : JSON.stringify(v ?? ""))
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOP.has(t)),
  );
}
/** Share of the smaller value's words found in the other: 1 = one restates the other. */
export function overlap(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const t of A) if (B.has(t)) n++;
  return n / Math.min(A.size, B.size);
}

// vars that state the same kind of fact, so a title from the proxy can corroborate one from the site
const SAME_FACT = [
  ["role.title", "career.timeline"],
  ["career.timeline", "role.start", "role.title"],
  ["career.education"],
  ["co.facts", "co.quarter"],
  ["co.leadership", "role.title"],
];
const kin = (a, b) => a === b || SAME_FACT.some((g) => g.includes(a) && g.includes(b));

/**
 * A primary record: the row comes from the authority that keeps the fact and is tied to the
 * subject by a key (CIK, the company's own domain or careers board, a full-list screen),
 * not by a name match. Configured in osint-weights.json `rows.primary`.
 */
export function isPrimary(row, subject, w = loadWeights()) {
  const fam = sourceFamily(row.url, subject);
  const rules = w.rows?.primary || DEFAULT_PRIMARY;
  return rules.some((r) => (!r.module || r.module === row.module) && (!r.family || r.family === fam) && (!r.anchor || (row.anchors || []).includes(r.anchor)) && (!r.var || r.var === row.var) && (!r.notVar || r.notVar !== row.var) && (!r.valueRe || new RegExp(r.valueRe, "i").test(String(row.value))));
}
export const DEFAULT_PRIMARY = [
  { module: "sec", family: "sec" },
  { module: "sec-person", family: "sec", anchor: "sec-owner-cik" },
  { module: "sec-person", family: "sec", anchor: "proxy-neo" },
  { module: "records", family: "sanctions" },
  { module: "dns", family: "dns" },
];

/**
 * Apply the two-signal rule to every Verified row. Returns the rows (mutated in place) with
 * `signals` (the independent source families that agree) and, for a downgrade, `grade` "p",
 * `graded_from` "v" and `grade_basis`. Rows below Verified are left as they are.
 */
export function corroborate(rows, subject = {}, w = loadWeights()) {
  const fams = rows.map((r) => sourceFamily(r.url, subject));
  const minOverlap = w.rows?.minOverlap ?? 0.6;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.grade !== "v") continue;
    const signals = new Set([fams[i] || r.module]);
    const by = [];
    for (let j = 0; j < rows.length; j++) {
      if (j === i || !fams[j] || signals.has(fams[j]) || !kin(r.var, rows[j].var)) continue;
      if (!["v", "p"].includes(rows[j].grade)) continue;
      if (overlap(r.value, rows[j].value) >= minOverlap) {
        signals.add(fams[j]);
        by.push(rows[j].id);
      }
    }
    // identity rows carry their own evidence sources (scored in 30-identity.mjs)
    for (const s of r.detail?.signalSources || []) signals.add(s);
    const primary = isPrimary(r, subject, w);
    r.signals = [...signals];
    if (by.length) r.corroborated_by = by;
    if (primary || signals.size >= 2) {
      r.grade_basis = primary && signals.size < 2 ? "primary record" : `${signals.size} independent sources`;
      continue;
    }
    r.grade = "p";
    r.graded_from = "v";
    r.grade_basis = `one source (${r.signals[0]}); Verified needs two independent sources or a primary record`;
  }
  return rows;
}
