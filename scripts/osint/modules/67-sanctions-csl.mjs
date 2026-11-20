// sanctions-csl: the US Consolidated Screening List (trade.gov, public domain): OFAC SDN and
// non-SDN lists, BIS Entity List, Denied Persons, Unverified and Military End User lists, State's
// ITAR debarred and nonproliferation lists, about 26,000 entries in one 34 MB file. Downloaded
// at most once a day into ~/.cache/diligence-rooms/ (OSINT_CACHE_DIR overrides; never the repo),
// kept in a compact form, and matched locally against the person's name forms and the company.
// A clean screen is a "checked, none" row; a match is graded p (a name is not an identity).

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { normCompany } from "../colib.mjs";
import { nameParts, firstForms, normName, blockedMiss } from "../person-lib.mjs";

export const CSL_URL = "https://data.trade.gov/downloadable_consolidated_screening_list/v1/consolidated.json";
const SEARCH_UI = "https://www.trade.gov/data-visualization/csl-search";
export const cacheDir = (env = process.env) => env.OSINT_CACHE_DIR || join(homedir(), ".cache", "diligence-rooms");

/** The compact list: [{ n: name, a: [alt names], t: type, s: source, p: programs, c: countries, id, u: info url }]. */
export function compact(json) {
  return (json?.results || []).map((x) => ({
    n: x.name,
    a: x.alt_names || [],
    t: x.type || null,
    s: x.source,
    p: x.programs || [],
    c: [...new Set((x.addresses || []).map((a) => a.country).filter(Boolean))],
    id: x.id || x.entity_number || null,
    u: x.source_information_url || null,
    r: x.remarks ? String(x.remarks).slice(0, 300) : null,
  }));
}

/** Entries naming the person: surname and a first-name form both appear as words in the name or an alias. */
export function screenPerson(list, subject) {
  const { first, last } = nameParts(subject.name);
  if (!first || !last) return [];
  const forms = firstForms(first);
  const hits = [];
  for (const e of list) {
    if (e.t && e.t !== "Individual") continue;
    for (const n of [e.n, ...e.a]) {
      const toks = normName(n).split(" ");
      if (toks.includes(last) && forms.some((f) => toks.includes(f))) {
        hits.push({ ...e, matched: n });
        break;
      }
    }
  }
  return hits;
}

/** Entries naming the company: normalised name or alias equal to the company's. */
export function screenCompany(list, names) {
  const want = new Set(names.filter(Boolean).map(normCompany).filter((w) => w.length > 2));
  if (!want.size) return [];
  const hits = [];
  for (const e of list) {
    if (e.t === "Individual") continue;
    const m = [e.n, ...e.a].find((n) => want.has(normCompany(n)));
    if (m) hits.push({ ...e, matched: m });
  }
  return hits;
}

async function loadCsl(http, env, log) {
  const dir = cacheDir(env);
  const file = join(dir, "csl.compact.json");
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < 24 * 3600e3) {
    try {
      return { list: JSON.parse(readFileSync(file, "utf8")), cached: true, at: statSync(file).mtime.toISOString() };
    } catch {
      // unreadable cache: download again
    }
  }
  const r = await http.get(CSL_URL, { timeout: 30000, cache: false, headers: { accept: "application/json" } });
  let list = null;
  try {
    list = r.ok ? compact(JSON.parse(r.text)) : null;
  } catch {
    list = null;
  }
  if (!list?.length) {
    // a stale copy beats nothing; say how old it is
    if (existsSync(file)) {
      try {
        return { list: JSON.parse(readFileSync(file, "utf8")), cached: true, stale: true, at: statSync(file).mtime.toISOString(), res: r };
      } catch {}
    }
    return { error: true, res: r };
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(list));
  log?.(`CSL: downloaded ${(r.text.length / 1e6).toFixed(1)} MB, ${list.length} entries`);
  return { list, cached: false, at: new Date().toISOString() };
}

const short = (s) => String(s || "").replace(/\s*-\s*(Treasury|State|Commerce) Department$|\s*-\s*Bureau of Industry and Security$/i, "");

export default {
  id: "sanctions-csl",
  label: "US Consolidated Screening List (OFAC, BIS Entity List, ITAR and more; trade.gov)",
  lane: "fast",
  needs: ["name"],
  budgetMs: 40000, // the daily 34 MB download takes 1.4-8 s; warm runs take milliseconds
  async run(ctx) {
    const { subject, http, env, log } = ctx;
    const csl = await loadCsl(http, env, log);
    if (csl.error) return blockedMiss(ctx, "rec.sanctions_detail", "trade.gov Consolidated Screening List download", csl.res, "retry later; once downloaded it is cached for a day");
    const list = csl.list;
    const sources = [...new Set(list.map((e) => short(e.s)))];
    const people = screenPerson(list, subject);
    const cos = subject.company ? screenCompany(list, [subject.company, ctx.shared.secName]) : [];
    const when = `${csl.stale ? "stale copy from " : ""}${String(csl.at).slice(0, 10)}`;
    for (const h of people.slice(0, 10)) {
      ctx.add({ var: "rec.sanctions_detail", value: `CSL possible match: "${h.matched}" on ${short(h.s)}${h.p.length ? ` (${h.p.slice(0, 3).join(", ")})` : ""}${h.c.length ? `, ${h.c.slice(0, 3).join(", ")}` : ""} — a name match only; check identity before relying on it`, url: h.u || SEARCH_UI, grade: "p", tier: "A", anchors: ["name"], detail: { list: h.s, programs: h.p, countries: h.c, id: h.id, names: [h.n, ...h.a].slice(0, 8), remarks: h.r, listDate: when } });
    }
    for (const h of cos.slice(0, 10)) {
      ctx.add({ var: "rec.sanctions_detail", value: `CSL: the company name "${h.matched}" is on ${short(h.s)}${h.p.length ? ` (${h.p.slice(0, 3).join(", ")})` : ""}${h.c.length ? `, ${h.c.slice(0, 3).join(", ")}` : ""}`, url: h.u || SEARCH_UI, grade: "p", tier: "A", anchors: ["company"], detail: { list: h.s, programs: h.p, countries: h.c, id: h.id, names: [h.n, ...h.a].slice(0, 8), remarks: h.r, listDate: when } });
    }
    if (!people.length && !cos.length) {
      ctx.add({ var: "rec.sanctions_detail", value: `Clear: no match for ${subject.name}${subject.company ? ` or ${subject.company}` : ""} on the US Consolidated Screening List (${list.length.toLocaleString("en-US")} entries across ${sources.length} lists, including OFAC SDN, BIS Entity List and ITAR debarred; list of ${when})`, url: SEARCH_UI, grade: "v", tier: "A", detail: { entries: list.length, lists: sources, listDate: when } });
    }
  },
};
