#!/usr/bin/env node
// Run a room's research with the engine chosen in the studio (config/engine.json).
//
//   node --env-file-if-exists=.env scripts/run-room.mjs <slug>
//
// rooms/<slug>/RUN.sh calls this, and the studio's Run button runs RUN.sh.
// Claude Code: one call with the P0 orchestrator prompt (rooms/<slug>/work/P0.md); it spawns
// its own subagents. Codex: one fresh call per stage (scripts/lib/stages.mjs), at most three
// web-searching calls at once. Then lint and build. Never deploys.
// Exit codes: 0 done, 1 failed, 2 not set up, 3 stopped by the usage guard, 130 stopped by the user.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { REPO, SLUG_RE } from "./lib/compose.mjs";
import { ENGINES, loadEngineConfig, notReady, runEngine, modelFor } from "./lib/engines.mjs";
import { stagePlan, pool } from "./lib/stages.mjs";

const slug = process.argv[2];
if (!SLUG_RE.test(slug || "")) {
  console.error("usage: node scripts/run-room.mjs <slug>");
  process.exit(2);
}
const roomDir = join(REPO, "rooms", slug);
const workDir = join(roomDir, "work");
if (!existsSync(join(roomDir, "intake.json"))) {
  console.error(`rooms/${slug}/intake.json not found; start the room in the studio first`);
  process.exit(2);
}
mkdirSync(workDir, { recursive: true });

const cfg = loadEngineConfig(join(REPO, "config", "engine.json"));
const why = notReady(cfg);
if (why) {
  console.error(`Not ready to run: ${why}. Open the studio (npm run studio) and use Connect AI.`);
  process.exit(2);
}

const stamp = () => new Date().toISOString().slice(11, 19);
const say = (msg) => console.log(`[run ${stamp()}] ${msg}`);
const usage = { pct: cfg.test?.usagePct ?? null, window: cfg.test?.usageWindow ?? null };
let stopped = null; // "usage" | "user"

process.on("SIGTERM", () => {
  stopped ||= "user";
  say("stop requested");
});
process.on("SIGINT", () => {
  stopped ||= "user";
});

function finish(code, extra = {}) {
  const status = { slug, engine: cfg.engine, auth: cfg.auth, model: modelFor(cfg), endedAt: new Date().toISOString(), code, stopped, usagePct: usage.pct, usageWindow: usage.window, usageLimit: cfg.usageLimit, ...extra };
  writeFileSync(join(workDir, "last-run.json"), JSON.stringify(status, null, 2) + "\n");
  if (stopped === "usage") say(`STOPPED: plan usage reached ${usage.pct}% (${usage.window}), above your ${cfg.usageLimit}% limit. Pages written so far are kept; press Run again after the window resets.`);
  process.exit(code);
}

say(`engine ${ENGINES[cfg.engine].name} (${cfg.auth === "key" ? "API key" : "signed-in account"}), model ${modelFor(cfg) || "default"}, usage limit ${cfg.usageLimit}%`);

if (cfg.engine === "claude") {
  const promptFile = join(workDir, "P0.md");
  if (!existsSync(promptFile)) {
    console.error(`rooms/${slug}/work/P0.md not found; press Start for this room in the studio again`);
    process.exit(2);
  }
  const r = await runEngine({ engineId: "claude", cfg, prompt: readFileSync(promptFile, "utf8"), cwd: REPO, log: (l) => console.log(l), usageState: usage });
  if (r.stoppedForUsage) stopped = "usage";
  if (r.error && !stopped) say(`error: ${r.error}`);
  finish(stopped === "usage" ? 3 : stopped === "user" ? 130 : r.error ? 1 : 0);
}

// ---------------------------------------------------------------- Codex: stage by stage

const intake = JSON.parse(readFileSync(join(roomDir, "intake.json"), "utf8"));
let ours = {};
try {
  ours = JSON.parse(readFileSync(join(REPO, "config", "our-side.json"), "utf8"));
} catch {}
const waves = stagePlan(readFileSync(join(REPO, "pipeline", "PROMPTS.md"), "utf8"), intake, slug, ours);
const failed = [];

for (const w of waves) {
  if (stopped) break;
  say(`== wave: ${w.wave} (${w.stages.map((s) => s.id).join(", ")})`);
  const limit = w.stages.some((s) => s.online) ? 3 : 5;
  await pool(w.stages, limit, async (s) => {
    if (stopped) return;
    say(`-> ${s.id} started`);
    const tag = `[${s.id}] `;
    const r = await runEngine({ engineId: "codex", cfg, prompt: s.prompt, cwd: REPO, log: (l) => console.log(tag + l), usageState: usage, lastMessageFile: join(workDir, `stage-${s.id.replace(/\s+/g, "-")}.md`) });
    if (r.stoppedForUsage) stopped = "usage";
    if (r.error && !stopped) {
      failed.push(s.id);
      say(`!! ${s.id} failed: ${r.error}`);
    } else if (!stopped) say(`<- ${s.id} done${usage.pct != null ? ` (plan usage ${usage.pct}%)` : ""}`);
  });
}

if (!stopped) {
  say("lint and build");
  for (const script of ["lint.mjs", "build.mjs"]) {
    const r = spawnSync(process.execPath, [join(REPO, "scripts", script), slug], { cwd: REPO, encoding: "utf8" });
    console.log((r.stdout + r.stderr).trim());
  }
}
finish(stopped === "usage" ? 3 : stopped === "user" ? 130 : failed.length ? 1 : 0, { failedStages: failed });
