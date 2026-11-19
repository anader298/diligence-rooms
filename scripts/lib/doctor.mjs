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
