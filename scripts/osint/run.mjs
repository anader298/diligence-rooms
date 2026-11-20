// Run the OSINT modules for one subject and write the ledger, osint.json and dossier.html.
// Modules run in lanes: fast (APIs, all at once), sweep (many small checks), slow (big reads).
// Each module gets a time budget; a module that fails or times out is recorded, never fatal.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeHttp, makeLedger } from "./core.mjs";

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

/**
 * subject: { name, company, domain, title, city, state, handles[], aliases[], ticker, cik, photo }
 * Returns { subject, rows, misses, modules: [{ id, status, ms, found, error }] }.
 */
export async function runOsint(subject, { outDir, only = null, log = console.log, fetchImpl, budgetMs = 90000, modules = null } = {}) {
  mkdirSync(outDir, { recursive: true });
  const schema = loadVariables();
  const ledger = makeLedger(outDir, schema.variables);
  const http = makeHttp({ cacheDir: join(outDir, "cache"), fetchImpl, log: process.env.OSINT_VERBOSE ? log : () => {} });
  const mods = modules || (await loadModules(only));
  const shared = {}; // modules publish facts for later lanes (e.g. sec -> cik, search -> urls)
  const report = [];

  const runOne = async (m) => {
    const missing = (m.needs || []).filter((k) => !(subject[k] || shared[k]));
    if (missing.length) {
      report.push({ id: m.id, label: m.label, status: "skipped", why: `needs ${missing.join(", ")}`, ms: 0, found: 0 });
      return;
    }
    const before = ledger.rows.length;
    const t0 = Date.now();
    const ctx = {
      subject,
      shared,
      http,
      env: process.env,
      log: (s) => log(`[${m.id}] ${s}`),
      add: (f) => ledger.add(m.id, { ms: f.ms ?? Date.now() - t0, ...f }),
      miss: (v, searched) => ledger.miss(m.id, v, searched),
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
    // modules in a lane run at once, so count this module's own rows, not the ledger's growth
    const found = ledger.rows.slice(before).filter((r) => r.module === m.id).length;
    report.push({ id: m.id, label: m.label, lane: m.lane, status, ms: Date.now() - t0, found, error, env: (m.env || []).filter((k) => !process.env[k]) });
    log(`${status === "ok" ? "✓" : "✗"} ${m.id.padEnd(18)} ${String(found).padStart(3)} rows  ${((Date.now() - t0) / 1000).toFixed(1)}s${error ? "  " + error : ""}`);
  };

  const t0 = Date.now();
  for (const lane of ["fast", "sweep", "slow", "late"]) {
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
    modules: report,
    http: { calls: http.stats.length, blocked: http.stats.filter((s) => [403, 429, 202, 999].includes(s.status)).length },
  };
  writeFileSync(join(outDir, "osint.json"), JSON.stringify(result, null, 1));
  return result;
}
