// Run the OSINT modules for one subject and write the ledger, osint.json and dossier.html.
// Modules run in lanes: fast (APIs, all at once), sweep (many small checks), slow (big reads),
// heavy (opt-in Python sidecars and binaries: --heavy), late (identity, estimates). Each module
// gets a time budget; a module that fails or times out is recorded, never fatal. A module whose key calls were refused sets ctx.status("blocked", why),
// so the run report never says "ok, found 0" for something it could not check.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, renameSync, copyFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeHttp, makeLedger, normName, namesSubject } from "./core.mjs";
import { departureFrom, normCompany } from "./colib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, "..", "..");

export function loadVariables() {
  return JSON.parse(readFileSync(join(REPO, "config", "osint-variables.json"), "utf8"));
}

/** Every module in scripts/osint/modules/*.mjs (default export), in file order. */
export async function loadModules(only = null) {
  const dir = join(HERE, "modules");
  const out = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort()) {
    const mod = (await import(pathToFileURL(join(dir, f)).href)).default;
    const list = Array.isArray(mod) ? mod : [mod];
    for (const m of list) if (m?.id && (!only || only.includes(m.id))) out.push(m);
  }
  return out;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

/**
 * An output folder holds one subject. If it already holds a different subject, move it aside
 * (renamed with a timestamp, never deleted) so two people's ledgers never mix. If it holds the
 * same subject, keep a copy of the old ledger and start a fresh one with only the hand-added
 * (agent) rows, so rows a fixed module no longer produces do not linger.
 * Returns a note for the log, or null.
 */
export function prepareOutDir(outDir, subject) {
  const file = join(outDir, "osint.json");
  const ledgerFile = join(outDir, "ledger.jsonl");
  if (!existsSync(file) && !existsSync(ledgerFile)) return null;
  let prev = null;
  try {
    prev = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).subject : null;
  } catch {
    prev = null; // unreadable osint.json: treat as a different subject, move it aside
  }
  const same = prev && normName(prev.name) === normName(subject.name) && normCompany(prev.company || "") === normCompany(subject.company || "");
  if (!same) {
    const to = `${outDir.replace(/\/+$/, "")}.prev-${stamp()}`;
    renameSync(outDir, to);
    mkdirSync(outDir, { recursive: true });
    return `output folder held ${prev?.name ? `"${prev.name}"` : "an unknown subject"}; moved it to ${to}`;
  }
  if (existsSync(ledgerFile)) {
    const keep = [];
    for (const line of readFileSync(ledgerFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r.module === "agent") keep.push(line);
      } catch {
        // an unreadable line stays in the backup copy below
      }
    }
    const backup = join(outDir, `ledger.${stamp()}.jsonl`);
    copyFileSync(ledgerFile, backup);
    writeFileSync(ledgerFile, keep.length ? keep.join("\n") + "\n" : "");
    return `re-run for the same subject: previous ledger kept as ${basename(backup)}${keep.length ? `, ${keep.length} hand-added rows carried over` : ""}`;
  }
  return null;
}

// rows that can carry news of a move: filings, press, news and search titles; never bios
const DEPARTURE_VARS = new Set(["news.articles", "news.company", "co.exec_changes", "voice.quotes", "social.work_posts", "role.title"]);

/**
 * Departure check across everything the run found. Adds a role.title row "Left <company>
 * (date) → <new>" graded p, sets shared.departed, and returns alerts for the dossier banner.
 */
export function departureCheck(subject, rows, shared = {}) {
  const found = [...(shared.departures || [])];
  const co = normCompany(subject.company || "");
  const mentionsCo = (t) => !co || normCompany(t).includes(co);
  for (const r of rows) {
    if (!DEPARTURE_VARS.has(r.var) || r.module === "departure") continue;
    const text = typeof r.value === "string" ? r.value : "";
    // a news line about a namesake must not retire the subject: need the company, an anchor, or a filing
    if (!(mentionsCo(text) || (r.anchors || []).includes("company") || r.grade === "v")) continue;
    const d = departureFrom(text, subject);
    if (d) found.push({ ...d, date: r.date || null, url: r.url || null, text: text.slice(0, 300), source: `${r.module} ${r.id}`, ref: r.id });
  }
  for (const x of shared.searchResults || []) {
    const text = [x.title, x.snippet || x.description || ""].filter(Boolean).join(". ");
    if (!text || !namesSubject(text, subject) || !mentionsCo(text)) continue;
    const d = departureFrom(x.title || "", subject) || departureFrom(text, subject);
    if (d) found.push({ ...d, date: x.date || null, url: x.url || null, text: text.slice(0, 300), source: `search ${x.engine || ""}`.trim() });
  }
  if (!found.length) return { departures: [], alerts: [] };
  // newest dated evidence first; a named new employer beats an unnamed one
  found.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) || (b.newCompany ? 1 : 0) - (a.newCompany ? 1 : 0));
  const best = found.find((x) => x.newCompany) || found[0];
  const when = best.date ? String(best.date).slice(0, 10) : "date unknown";
  shared.departed = { company: subject.company, date: best.date || null, newCompany: best.newCompany || null, evidence: found.slice(0, 5) };
  return {
    departures: found,
    best,
    alerts: [{ level: "warn", text: `${subject.name} may have left ${subject.company || "the company"} (${when})${best.newCompany ? ` and joined ${best.newCompany}` : ""}: ${found.length} source${found.length === 1 ? "" : "s"}, e.g. "${best.text.slice(0, 140)}"`, url: best.url || null }],
  };
}

/**
 * subject: { name, company, domain, title, city, state, handles[], aliases[], ticker, cik, photo }
 * Returns { subject, rows, misses, alerts, modules: [{ id, status, ms, found, error, why }] }.
 */
export async function runOsint(subject, { outDir, only = null, log = console.log, fetchImpl, budgetMs = 90000, modules = null, heavy = null, opts = {} } = {}) {
  mkdirSync(outDir, { recursive: true });
  const moved = prepareOutDir(outDir, subject);
  if (moved) log(`note: ${moved}`);
  const schema = loadVariables();
  const ledger = makeLedger(outDir, schema.variables);
  const http = makeHttp({ cacheDir: join(outDir, "cache"), fetchImpl, log: process.env.OSINT_VERBOSE ? log : () => {} });
  const mods = modules || (await loadModules(only));
  const shared = {}; // modules publish facts for later lanes (e.g. sec -> cik, search -> urls)
  const report = [];
  const alerts = [];

  // Heavy modules are opt-in: --heavy <ids|all>, or named in --only.
  const heavyOn = (m) => heavy === "all" || (Array.isArray(heavy) && (heavy.includes("all") || heavy.includes(m.id))) || (only || []).includes(m.id);
  const runOne = async (m) => {
    if (m.lane === "heavy" && !heavyOn(m)) {
      report.push({ id: m.id, label: m.label, lane: m.lane, status: "skipped", why: `opt-in: add --heavy ${m.id}${m.flag ? ` (or ${m.flag})` : ""}`, ms: 0, found: 0 });
      return;
    }
    const missing = (m.needs || []).filter((k) => !(subject[k] || shared[k]));
    if (missing.length) {
      report.push({ id: m.id, label: m.label, status: "skipped", why: `needs ${missing.join(", ")}`, ms: 0, found: 0 });
      return;
    }
    const before = ledger.rows.length;
    const t0 = Date.now();
    let set = null; // { status, why } from ctx.status
    const ctx = {
      subject,
      shared,
      http,
      env: process.env,
      opts,
      outDir,
      rows: ledger.rows, // read-only view of the ledger so far (heavy and late modules build on it)
      log: (s) => log(`[${m.id}] ${s}`),
      add: (f) => ledger.add(m.id, { ms: f.ms ?? Date.now() - t0, ...f }),
      miss: (v, searched) => ledger.miss(m.id, v, searched),
      /** "blocked" when the module's key calls were refused (403/429/999); "partial" when some were. */
      status: (s, why) => {
        if (!set || s === "blocked") set = { status: s, why: why || null };
      },
      alert: (a) => alerts.push({ level: a.level || "warn", text: a.text, url: a.url || null, module: m.id }),
    };
    let status = "ok";
    let error = null;
    try {
      let timer;
      await Promise.race([m.run(ctx), new Promise((_, rej) => (timer = setTimeout(() => rej(new Error("time budget")), m.budgetMs || budgetMs)))]).finally(() => clearTimeout(timer));
    } catch (e) {
      status = e.message === "time budget" ? "timeout" : "error";
      error = String(e.message || e).slice(0, 200);
    }
    if (status === "ok" && set) status = set.status;
    // modules in a lane run at once, so count this module's own rows, not the ledger's growth
    const found = ledger.rows.slice(before).filter((r) => r.module === m.id).length;
    report.push({ id: m.id, label: m.label, lane: m.lane, status, ms: Date.now() - t0, found, error, why: set?.why || null, env: (m.env || []).filter((k) => !process.env[k]) });
    log(`${status === "ok" ? "✓" : status === "blocked" || status === "partial" ? "!" : "✗"} ${m.id.padEnd(18)} ${String(found).padStart(3)} rows  ${((Date.now() - t0) / 1000).toFixed(1)}s${error ? "  " + error : set?.why ? "  " + set.status + ": " + set.why : ""}`);
  };

  const t0 = Date.now();
  for (const lane of ["fast", "sweep", "slow", "heavy", "late"]) {
    // before the estimates: did anything say the subject has left?
    if (lane === "late" && subject.name) {
      const dep = departureCheck(subject, ledger.rows, shared);
      if (dep.best) {
        const b = dep.best;
        ledger.add("departure", {
          var: "role.title",
          value: `Left ${subject.company || "the company"} (${b.date ? String(b.date).slice(0, 10) : "date unknown"})${b.newCompany ? ` → ${b.newCompany}` : ""}`,
          url: b.url,
          grade: "p",
          tier: "B",
          date: b.date ? String(b.date).slice(0, 10) : null,
          anchors: dep.departures.map((x) => x.ref).filter(Boolean),
          detail: { evidence: dep.departures.slice(0, 5).map((x) => ({ source: x.source, text: x.text, url: x.url, date: x.date, newCompany: x.newCompany })) },
        });
        alerts.push(...dep.alerts.map((a) => ({ ...a, module: "departure" })));
      }
    }
    const ms = mods.filter((m) => (m.lane || "fast") === lane);
    if (ms.length) await Promise.all(ms.map(runOne));
  }

  const result = {
    subject,
    ranAt: new Date().toISOString(),
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    tabs: schema.tabs,
    variables: schema.variables,
    rows: ledger.rows,
    misses: ledger.misses,
    alerts,
    departed: shared.departed || null,
    modules: report,
    http: { calls: http.stats.length, blocked: http.stats.filter((s) => [403, 429, 202, 999].includes(s.status)).length },
  };
  writeFileSync(join(outDir, "osint.json"), JSON.stringify(result, null, 1));
  return result;
}
