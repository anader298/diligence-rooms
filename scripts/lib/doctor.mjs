// The setup checklist, shared by `npm run doctor` and the studio's banner.
// Each check: { id, label, ok, required, fix }.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { detect, loadEngineConfig, notReady, ENGINES } from "./engines.mjs";

export async function checks(repo, env = process.env) {
  const out = [];
  const add = (id, label, ok, required, fix) => out.push({ id, label, ok: !!ok, required, fix: ok ? null : fix });

  const [maj, min] = process.versions.node.split(".").map(Number);
  add("node", `Node ${process.versions.node}`, maj > 23 || (maj === 23 && min >= 6), true, "Install Node 23.6 or later from https://nodejs.org");
  add("deps", "npm install has been run", existsSync(join(repo, "node_modules", "@anthropic-ai", "sdk")), true, "Run: npm install");

  const found = await detect(env);
  const usable = Object.values(found).filter((e) => e.installed && (e.loggedIn || e.keySet));
  for (const e of Object.values(found)) {
    const state = !e.installed ? "not installed" : e.loggedIn ? `signed in (${e.loginMethod})` : e.keySet ? `API key set (${e.keyMask})` : "installed, not signed in";
    add(`engine-${e.id}`, `${e.name}: ${state}`, e.installed && (e.loggedIn || e.keySet), false, !e.installed ? `Install it: ${e.install}` : `${e.login}, or paste an API key in the studio's Connect AI panel`);
  }
  add("engine-any", "At least one AI engine (Claude Code or Codex) is ready", usable.length > 0, true, "Install Claude Code or Codex and sign in (see the two lines above)");

  const cfg = loadEngineConfig(join(repo, "config", "engine.json"));
  const why = notReady(cfg, env);
  add("connected", cfg.engine ? `Studio connected to ${ENGINES[cfg.engine].name} (${cfg.auth === "key" ? "API key" : "signed-in account"}), stops above ${cfg.usageLimit}% plan usage` : "Studio connected to an engine", !why, true, `In the studio: Connect AI, then Test (${why})`);

  let ours = null;
  try {
    ours = JSON.parse(readFileSync(join(repo, "config", "our-side.json"), "utf8"));
  } catch {}
  add("ourside", "Your side is set up (config/our-side.json)", ours && ours.name && ours.name !== "Your Name", true, "In the studio: About you");

  const envText = existsSync(join(repo, ".env")) ? readFileSync(join(repo, ".env"), "utf8") : "";
  add("cookie", "ROOM_COOKIE_SECRET set (only for npm run serve and deploying)", /^\s*ROOM_COOKIE_SECRET\s*=\s*\S{16,}/m.test(envText) || (env.ROOM_COOKIE_SECRET || "").length >= 16, false, "cp .env.example .env, then set ROOM_COOKIE_SECRET to a long random string");
  return { ok: out.every((c) => c.ok || !c.required), checks: out };
}

/** What each optional OSINT key unlocks, for the doctor's fix line. */
export const OSINT_KEYS = {
  FEC_API_KEY: "free at https://api.data.gov/signup (DEMO_KEY allows about 30 calls an hour)",
  GITHUB_TOKEN: "a fine-grained token with no scopes, https://github.com/settings/tokens (60 to 5,000 calls an hour)",
  COURTLISTENER_TOKEN: "free at https://www.courtlistener.com/sign-in/",
  OPENSANCTIONS_API_KEY: "https://www.opensanctions.org/api/ (business use needs a licence)",
  BRAVE_API_KEY: "https://api-dashboard.search.brave.com (metered)",
  USPTO_API_KEY: "free at https://data.uspto.gov/myodp (USPTO Open Data Portal; PatentsView moved there 20 Mar 2026)",
  PATENTSVIEW_API_KEY: "retired with PatentsView; use USPTO_API_KEY",
  COMPANIES_HOUSE_API_KEY: "free at https://developer.company-information.service.gov.uk",
  STACKEXCHANGE_KEY: "free at https://stackapps.com/apps/oauth/register (300 to 10,000 calls a day)",
  PODCASTINDEX_API_KEY: "free at https://api.podcastindex.org (also set PODCASTINDEX_API_SECRET)",
  PODCASTINDEX_API_SECRET: "free at https://api.podcastindex.org",
  GOOGLE_BOOKS_API_KEY: "free in Google Cloud console (Books API)",
  LDA_API_KEY: "free at https://lda.gov/api/register/ (15 to 120 calls a minute)",
  OPENALEX_API_KEY: "free at https://openalex.org/settings/api",
  GRAVATAR_API_KEY: "free at https://gravatar.com/developers (100 to 1,000 calls an hour)",
  ABN_GUID: "free at https://abr.business.gov.au/Tools/WebServices",
};

/**
 * OSINT checks for `npm run doctor`: every optional key a module reads (from its `env`), and for
 * the opt-in heavy lane, every Python package and binary a module lists in `deps`. All optional:
 * without them the module records "not checked" or an error row with the fix, never a stall.
 */
export async function osintChecks(env = process.env) {
  const { loadModules } = await import("../osint/run.mjs");
  const { pythonHas, which, pipLine, pythonBin } = await import("../osint/sidecar.mjs");
  const mods = await loadModules();
  const out = [];
  const add = (id, label, ok, fix) => out.push({ id, label, ok: !!ok, required: false, fix: ok ? null : fix });
  const keys = new Map();
  for (const m of mods) for (const k of m.env || []) (keys.get(k) || keys.set(k, []).get(k)).push(m.id);
  for (const [k, ids] of [...keys].sort()) add(`osint-key-${k}`, `OSINT key ${k} ${env[k] ? "set" : "not set"} (${ids.join(", ")})`, !!env[k], `optional: ${OSINT_KEYS[k] || "see docs/osint.md"}`);
  const heavy = mods.filter((m) => m.deps);
  const pyMods = [...new Set(heavy.flatMap((m) => [...(m.deps.python || []), ...Object.keys(m.deps.extra || {})]))];
  const has = pyMods.length ? await pythonHas(pyMods, { env }) : {};
  if (pyMods.length) add("osint-python", `Python 3 for the heavy lane (${pythonBin(env)})`, has != null, "optional: install Python 3, or set OSINT_PYTHON to its path");
  for (const m of heavy) {
    const missPy = (m.deps.python || []).filter((p) => !has?.[p]);
    const missBin = (m.deps.bin || []).filter((b) => !which(env[`OSINT_${b.toUpperCase().replace(/-/g, "_")}`] || b, env)); // OSINT_EXIFTOOL etc. point at a binary off PATH
    const fix = [missPy.length && pipLine(missPy), ...missBin.map((b) => (b === "exiftool" ? "brew install exiftool (or apt install libimage-exiftool-perl)" : `install ${b}`))].filter(Boolean).join("; ");
    add(`osint-heavy-${m.id}`, `OSINT heavy module ${m.id} (opt-in --heavy ${m.id})${missPy.length || missBin.length ? `: missing ${[...missPy, ...missBin].join(", ")}` : ": ready"}`, !missPy.length && !missBin.length, `optional: ${fix}`);
    // extras: a package only one option of the module needs (faster_whisper for --transcribe audio)
    for (const [p, why] of Object.entries(m.deps.extra || {})) add(`osint-heavy-${m.id}-${p}`, `OSINT heavy module ${m.id}, ${why}: ${has?.[p] ? "ready" : `missing ${p}`}`, !!has?.[p], `optional: ${pipLine([p])}`);
  }
  return out;
}
