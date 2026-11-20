// The OSINT core: one HTTP helper (timeouts, per-host spacing, disk cache), the tie-back
// ledger, and the context every module receives. Node built-in fetch only, no dependencies.
//
// A module is a plain object:
//   { id, label, vars: ["co.facts", ...], lane: "fast" | "sweep" | "slow",
//     needs: ["name" | "company" | "domain" | ...], env: ["OPTIONAL_KEY"], async run(ctx) }
// `vars` lists the ledger variables it can fill; the form uses it to tell "searched, nothing
// found" from "no tool yet" for each bucket.
// It reports what it finds with ctx.add({ var, value, url, grade, ... }) and what it searched
// but did not find with ctx.miss(var, what), or ctx.miss(var, what, { blocked: true }) when the
// source could not be checked (a failed call, no key). Every add becomes one ledger row; nothing a module
// says reaches the dossier without a row.

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
/** SEC asks for a contact in the User-Agent; set SEC_USER_AGENT="Your Name you@example.com". */
export const SEC_UA = () => process.env.SEC_USER_AGENT || "diligence-rooms research contact@example.com";

const GRADES = ["v", "p", "w", "i", "n", "np", "u"];
const sha = (s) => createHash("sha1").update(String(s)).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimum gap between calls to one host (ms). Measured limits; see docs/osint.md. */
const HOST_GAP = {
  "html.duckduckgo.com": 3000,
  "duckduckgo.com": 3000,
  "efts.sec.gov": 150,
  "data.sec.gov": 150,
  "www.sec.gov": 150,
  "api.open.fec.gov": 1000,
  "www.threads.net": 2000,
  "www.threads.com": 2000,
  "yandex.com": 1500,
  "api.gdeltproject.org": 5500,
  "crt.sh": 1000,
  // Part 2 sources (limits from their docs or measured 19 Nov 2026)
  "lda.gov": 4000, // 15 a minute without a key
  "api.discogs.com": 2500, // 25 a minute
  "lichess.org": 1000,
  "api.semanticscholar.org": 1100, // shared anonymous pool, about 1 a second
  "openlibrary.org": 1000,
  "api.stackexchange.com": 400,
  "api.gravatar.com": 300,
  "api.brokercheck.finra.org": 400,
  "api.adviserinfo.sec.gov": 400,
  "echodata.epa.gov": 500,
  "api.uspto.gov": 600,
  default: 250,
};

export function makeHttp({ cacheDir = null, fetchImpl = globalThis.fetch, log = () => {}, ttlMs = 24 * 3600e3 } = {}) {
  const last = new Map();
  const stats = [];
  if (cacheDir) mkdirSync(cacheDir, { recursive: true });

  async function space(host) {
    const gap = HOST_GAP[host] ?? HOST_GAP.default;
    const prev = last.get(host) || 0;
    const wait = prev + gap - Date.now();
    last.set(host, Math.max(Date.now(), prev + gap));
    if (wait > 0) await sleep(wait);
  }

  /**
   * GET (or POST) a URL. Returns { ok, status, text, url, ms, cached, headers }.
   * Never throws for HTTP or network errors: a failed call is a result with ok:false.
   */
  async function get(url, { headers = {}, timeout = 12000, method = "GET", body, cache = true, redirect = "follow" } = {}) {
    const key = cacheDir && cache && method === "GET" ? join(cacheDir, sha(url + JSON.stringify(headers)) + ".json") : null;
    if (key && existsSync(key)) {
      try {
        const c = JSON.parse(readFileSync(key, "utf8"));
        if (Date.now() - c.at < ttlMs) return { ...c.res, cached: true };
      } catch (e) {
        log(`  cache file unreadable, refetching: ${key} (${e.message})`);
      }
    }
    const host = new URL(url).host;
    await space(host);
    const t0 = Date.now();
    let res;
    try {
      const r = await fetchImpl(url, {
        method,
        body,
        redirect,
        headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9", ...headers },
        signal: AbortSignal.timeout(timeout),
      });
      const text = await r.text();
      res = { ok: r.ok, status: r.status, text, url: r.url || url, ms: Date.now() - t0, headers: Object.fromEntries(r.headers || []) };
    } catch (e) {
      res = { ok: false, status: 0, text: "", url, ms: Date.now() - t0, error: String(e.name === "TimeoutError" ? "timeout" : e.message || e) };
    }
    stats.push({ host, status: res.status, ms: res.ms });
    log(`  ${res.status || res.error} ${res.ms}ms ${url.slice(0, 120)}`);
    if (key && res.ok) writeFileSync(key, JSON.stringify({ at: Date.now(), res }));
    return { ...res, cached: false };
  }

  async function json(url, opts = {}) {
    const r = await get(url, { ...opts, headers: { accept: "application/json", ...(opts.headers || {}) } });
    if (!r.ok) return { ...r, data: null };
    try {
      return { ...r, data: JSON.parse(r.text) };
    } catch {
      return { ...r, ok: false, data: null, error: "not json" };
    }
  }
  return { get, json, stats };
}

/** Lower-case, strip accents and punctuation: for comparing names. */
export function normName(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Common English first-name nicknames: formal name -> short forms. Shared by the SEC, proxy,
 * search and handle code so "Dan Holloway" finds the filings of "Daniel Holloway" and back.
 */
export const NICKNAMES = {
  richard: ["rick", "rich", "dick", "ricky"], robert: ["rob", "bob", "bobby", "bert"], william: ["will", "bill", "billy", "liam"],
  james: ["jim", "jimmy", "jamie"], john: ["jack", "johnny", "jon"], joseph: ["joe", "joey"], michael: ["mike", "mick", "mikey"],
  thomas: ["tom", "tommy"], christopher: ["chris", "topher"], daniel: ["dan", "danny"], matthew: ["matt"], anthony: ["tony"],
  david: ["dave", "davey"], steven: ["steve"], stephen: ["steve"], andrew: ["andy", "drew"], edward: ["ed", "eddie", "ted", "ned"],
  gabriel: ["gabe"], benjamin: ["ben", "benji"], samuel: ["sam", "sammy"], alexander: ["alex", "xander", "sandy"], nicholas: ["nick", "nicky"],
  jonathan: ["jon", "jonny"], timothy: ["tim", "timmy"], gregory: ["greg"], patrick: ["pat", "paddy"], kenneth: ["ken", "kenny"],
  ronald: ["ron", "ronnie"], donald: ["don", "donnie"], charles: ["charlie", "chuck", "chas"], frederick: ["fred", "freddie"],
  lawrence: ["larry"], leonard: ["leo", "len", "lenny"], raymond: ["ray"], gerald: ["gerry", "jerry"], jeffrey: ["jeff"], geoffrey: ["geoff", "jeff"],
  joshua: ["josh"], zachary: ["zach", "zack"], nathaniel: ["nate", "nat"], nathan: ["nate"], phillip: ["phil"], philip: ["phil"],
  douglas: ["doug"], bradley: ["brad"], frank: ["frankie"], francis: ["frank"], franklin: ["frank"], henry: ["hank", "harry"],
  harold: ["harry", "hal"], walter: ["walt"], albert: ["al", "bert"], alfred: ["al", "alfie"], peter: ["pete"], vincent: ["vince", "vinny"],
  terrence: ["terry"], terence: ["terry"], eugene: ["gene"], theodore: ["ted", "teddy", "theo"], stanley: ["stan"], russell: ["russ"],
  mitchell: ["mitch"], randall: ["randy"], gary: ["gar"], jacob: ["jake"], kevin: ["kev"], abraham: ["abe"], isaac: ["ike"],
  elizabeth: ["liz", "beth", "betsy", "lisa", "eliza", "betty"], katherine: ["kate", "katie", "kathy", "kat"], kathryn: ["kate", "kathy", "katie"],
  catherine: ["kate", "cathy", "cat"], jennifer: ["jen", "jenny", "jenn"], margaret: ["maggie", "peggy", "meg", "marge"], rebecca: ["becky", "becca"],
  susan: ["sue", "susie"], deborah: ["deb", "debbie"], patricia: ["pat", "trish", "patty", "tricia"], victoria: ["vicky", "tori"],
  christine: ["chris", "chrissy"], christina: ["chris", "tina"], alexandra: ["alex", "lexi", "sandra"], samantha: ["sam"], kimberly: ["kim"],
  jessica: ["jess", "jessie"], cynthia: ["cindy"], pamela: ["pam"], barbara: ["barb", "barbie"], dorothy: ["dot", "dottie"], judith: ["judy"],
  abigail: ["abby"], amanda: ["mandy"], melissa: ["missy", "mel"], stephanie: ["steph"], theresa: ["terry", "tess"], teresa: ["terry", "tess"],
  valerie: ["val"], virginia: ["ginny"], ferrante: ["ally", "allie"], madeline: ["maddie"], josephine: ["jo", "josie"], suzanne: ["sue", "suzy"],
  nancy: ["nan"], sandra: ["sandy"], gwendolyn: ["gwen"], frances: ["fran"], jacqueline: ["jackie"], danielle: ["dani"], nicole: ["nikki"],
};
const SHORT_TO_FORMAL = {};
for (const [formal, shorts] of Object.entries(NICKNAMES)) for (const s of shorts) (SHORT_TO_FORMAL[s] ||= []).push(formal);

/** First names that refer to the same person: "dan" -> [dan, daniel, danny]; "daniel" -> [daniel, dan, danny]. */
export function firstNameForms(first) {
  const f = normName(first);
  const out = new Set([f]);
  for (const n of NICKNAMES[f] || []) out.add(n);
  for (const formal of SHORT_TO_FORMAL[f] || []) {
    out.add(formal);
    for (const n of NICKNAMES[formal] || []) out.add(n);
  }
  return [...out].filter(Boolean);
}

/**
 * Every "First Last" the subject may be filed under: the given name, --aliases, and the formal
 * and short forms of the first name ("Dan Holloway" -> "Daniel Holloway", "Danny Holloway").
 * Ordered: given name first, aliases next, then the formal forms, then other short forms.
 */
export function nameForms(subject) {
  const names = [subject?.name, ...(subject?.aliases || [])].filter(Boolean).map((s) => String(s).trim());
  const out = new Set(names);
  for (const n of names) {
    const parts = n.split(/\s+/).filter((p) => !/^(jr|sr|ii|iii|iv|phd|md|mba)\.?$/i.test(p));
    if (parts.length < 2) continue;
    const first = parts[0];
    const last = parts.at(-1);
    const forms = firstNameForms(first);
    const formal = forms.filter((x) => NICKNAMES[x]);
    for (const f of [...formal, ...forms]) out.add(`${f.charAt(0).toUpperCase()}${f.slice(1)} ${last}`);
  }
  // keep one spelling per normalised name
  const seen = new Set();
  return [...out].filter((n) => {
    const k = normName(n);
    return !seen.has(k) && seen.add(k);
  });
}

/** True when the text names the subject under any of its name forms. */
export function namesSubject(text, subject) {
  return nameForms(subject).some((n) => nameIn(text, n));
}

/** True when every part of the person's first and last name appears in the text, as words. */
export function nameIn(text, name) {
  const t = " " + normName(text) + " ";
  const parts = normName(name).split(" ").filter((p) => p.length > 1);
  if (!parts.length) return false;
  const first = parts[0];
  const lastPart = parts.at(-1);
  return t.includes(" " + first + " ") && t.includes(" " + lastPart + " ");
}

export function stripTags(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** og:/twitter: meta tags as an object. */
export function metaTags(html) {
  const out = {};
  for (const m of String(html || "").matchAll(/<meta\s+[^>]*?(?:property|name)=["']([^"']+)["'][^>]*?content=["']([^"']*)["'][^>]*>/gi)) out[m[1].toLowerCase()] = decode(m[2]);
  for (const m of String(html || "").matchAll(/<meta\s+[^>]*?content=["']([^"']*)["'][^>]*?(?:property|name)=["']([^"']+)["'][^>]*>/gi)) out[m[2].toLowerCase()] ??= decode(m[1]);
  const t = String(html || "").match(/<title[^>]*>([^<]*)<\/title>/i);
  if (t) out.title = decode(t[1]).trim();
  return out;
}
function decode(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/**
 * The ledger: one JSON line per finding in <dir>/ledger.jsonl, ids L-0001 upward.
 * Rows are { id, at, module, var, tab, label, value, url, grade, tier, ms, anchors, detail, key }.
 * `key` dedupes: the same module adding the same var/value/url twice keeps one row.
 */
export function makeLedger(dir, variables = []) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "ledger.jsonl");
  const byVar = Object.fromEntries(variables.map((v) => [v.id, v]));
  const rows = [];
  const keys = new Set();
  const misses = [];
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        rows.push(r);
        keys.add(r.key);
      } catch {
        console.warn(`ledger: skipped an unreadable line in ${file}`);
      }
    }
  }
  let n = rows.reduce((m, r) => Math.max(m, Number(String(r.id).slice(2)) || 0), 0);

  function add(module, f) {
    const v = byVar[f.var];
    const value = typeof f.value === "string" ? f.value.trim() : f.value;
    if (value == null || value === "") return null;
    const key = sha([module, f.var, JSON.stringify(value), f.url || ""].join("|"));
    if (keys.has(key)) return rows.find((r) => r.key === key);
    keys.add(key);
    const row = {
      id: "L-" + String(++n).padStart(4, "0"),
      at: new Date().toISOString(),
      module,
      var: f.var,
      tab: f.tab || v?.tab || "personal",
      label: f.label || v?.label || f.var,
      group: f.group || v?.group || "",
      value,
      url: f.url || null,
      grade: GRADES.includes(f.grade) ? f.grade : "w",
      tier: f.tier || "A",
      ms: f.ms ?? null,
      anchors: f.anchors || [],
      detail: f.detail || null,
      date: f.date || null,
      image: f.image || null,
      key,
    };
    // entries handed in by agents (scripts/lib/entries.mjs) carry their bucket, the grade they
    // claimed (code decides the grade), a note, and for AI judgement the ledger ids they cite
    for (const k of ["bucket", "claim", "note", "cites", "entry"]) if (f[k] != null) row[k] = f[k];
    rows.push(row);
    appendFileSync(file, JSON.stringify(row) + "\n");
    return row;
  }
  /**
   * A var that was looked for and not found. opts.blocked: the source could not be checked (a
   * failed or refused call, no key, nothing to search with): the form shows "couldn't check",
   * never "searched, nothing found". Every miss records the flag, so the form reads it, not the text.
   */
  function miss(module, varId, searched, opts = {}) {
    const m = { module, var: varId, label: byVar[varId]?.label || varId, tab: byVar[varId]?.tab || "personal", searched, blocked: opts?.blocked === true };
    if (m.blocked && opts.status != null) m.status = opts.status;
    misses.push(m);
  }
  return { add, miss, rows, misses, file };
}
