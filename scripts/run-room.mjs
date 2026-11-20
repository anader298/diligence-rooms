#!/usr/bin/env node
// Run a room's research with the engine chosen in the studio (config/engine.json).
//
//   node --env-file-if-exists=.env scripts/run-room.mjs <slug> [--draft]
//
// rooms/<slug>/RUN.sh calls this, and the studio's Run button runs RUN.sh. The order is fixed
// by code, for both engines (Claude Code and Codex):
//   1. the scripted OSINT pass per person (no AI): the ledgers
//   2. the stages of pipeline/PROMPTS.md (scripts/lib/stages.mjs), one fresh engine call each,
//      at most three web-searching calls at once: agents hand in entries (npm run entry)
//   3. the AI slots stage: judgement entries that cite ledger ids
//   4. the form check (scripts/lib/form.mjs): a failed check stops here; --draft builds anyway
//   5. lint (report) and build. Never deploys.
// Exit codes: 0 done, 1 failed (a stage, or the form check), 2 not set up, 3 stopped by the
// usage guard, 130 stopped by the user.
// Tests: DR_ROOMS and DR_ENGINE_CONFIG point at other folders.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { REPO, SLUG_RE } from "./lib/compose.mjs";
import { ENGINES, loadEngineConfig, notReady, runEngine, modelFor } from "./lib/engines.mjs";
import { stagePlan, pool } from "./lib/stages.mjs";
import { roomForm, formGate } from "./lib/form.mjs";
import { moduleVars } from "./osint/run.mjs";

const slug = process.argv[2];
const draft = process.argv.includes("--draft") || process.env.RUN_DRAFT === "1";
if (!SLUG_RE.test(slug || "")) {
  console.error("usage: node scripts/run-room.mjs <slug>");
  process.exit(2);
}
const roomsRoot = process.env.DR_ROOMS || join(REPO, "rooms");
const roomDir = join(roomsRoot, slug);
const workDir = join(roomDir, "work");
if (!existsSync(join(roomDir, "intake.json"))) {
  console.error(`rooms/${slug}/intake.json not found; start the room in the studio first`);
  process.exit(2);
}
mkdirSync(workDir, { recursive: true });

const cfg = loadEngineConfig(process.env.DR_ENGINE_CONFIG || join(REPO, "config", "engine.json"));
const why = notReady(cfg);
if (why) {
  console.error(`Not ready to run: ${why}. Open the studio (npm run studio) and use Connect AI.`);
  process.exit(2);
}

const roomJson = () => {
  try {
    return JSON.parse(readFileSync(join(roomDir, "room.json"), "utf8"));
  } catch {
    return {};
  }
};
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

// The scripted OSINT pass first (about a minute per person, no AI): its ledger is the research
// agents' starting point (P4a step 0). A failure here never stops the run.
{
  const intakeEarly = JSON.parse(readFileSync(join(roomDir, "intake.json"), "utf8"));
  for (const p of intakeEarly.people || []) {
    if (stopped || !p?.name) continue;
    const out = join(workDir, "osint", p.slug);
    if (existsSync(join(out, "osint.json")) && !process.env.OSINT_REFRESH) {
      say(`OSINT pass: ${p.name} already done (work/osint/${p.slug}); set OSINT_REFRESH=1 to redo`);
      continue;
    }
    say(`OSINT pass: ${p.name}`);
    const args = [join(REPO, "scripts", "osint.mjs"), "--name", p.name, "--out", out];
    const company = intakeEarly.company;
    if (company) args.push("--company", company);
    // The domain comes from the intake (studio Website field, new-room --domain); rooms made
    // before it existed may carry it in room.json. Without it the five domain modules skip.
    const domain = intakeEarly.domain || roomJson().domain;
    if (domain) args.push("--domain", domain);
    if (p.title) args.push("--title", p.title);
    const r = spawnSync(process.execPath, args, { cwd: REPO, encoding: "utf8", timeout: 240000 });
    console.log(((r.stdout || "") + (r.stderr || "")).trim().split("\n").map((l) => "[osint] " + l).join("\n"));
  }
}

say(`engine ${ENGINES[cfg.engine].name} (${cfg.auth === "key" ? "API key" : "signed-in account"}), model ${modelFor(cfg) || "default"}, usage limit ${cfg.usageLimit}%`);

// ---------------------------------------------------------------- stages, in a fixed order
// Both engines run the same plan, one fresh call per stage, so the cold stages never see our
// side and the order does not depend on a model following an orchestrator prompt.

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
    const r = await runEngine({ engineId: cfg.engine, cfg, prompt: s.prompt, cwd: REPO, log: (l) => console.log(tag + l), usageState: usage, lastMessageFile: join(workDir, `stage-${s.id.replace(/\s+/g, "-")}.md`) });
    if (r.stoppedForUsage) stopped = "usage";
    if (r.error && !stopped) {
      failed.push(s.id);
      say(`!! ${s.id} failed: ${r.error}`);
    } else if (!stopped) say(`<- ${s.id} done${usage.pct != null ? ` (plan usage ${usage.pct}%)` : ""}`);
  });
}

// The form check before the build: required buckets have a state, AI entries cite real ledger
// rows, Start here is filled, the selected packs exist. A failed check stops the build unless
// this is a draft (--draft or RUN_DRAFT=1).
let formFailed = false;
if (!stopped) {
  say("form check");
  const room = JSON.parse(readFileSync(join(roomDir, "room.json"), "utf8"));
  const form = roomForm(roomDir, { moduleVars: await moduleVars(), pageIds: new Set((room.sections || []).flatMap((s) => (s.pages || []).map((p) => p.id))) });
  const gate = formGate(form);
  if (form) writeFileSync(join(workDir, "form.json"), JSON.stringify({ ...form, gate }, null, 1));
  if (form) say(`form: ${form.buckets.length} buckets: ${form.counts.filled} filled, ${form.counts.empty} searched and empty, ${form.counts.blocked} couldn't check, ${form.counts["no-tool"]} no tool yet`);
  for (const e of gate.errors.slice(0, 40)) say(`form: ${e}`);
  if (!gate.ok) {
    formFailed = true;
    say(draft ? `form check FAILED (${gate.errors.length}); building anyway as a draft` : `form check FAILED (${gate.errors.length}): not building. Fix the entries, or run again with --draft to build a draft.`);
  } else say("form check passed");
}
if (!stopped && (!formFailed || draft)) {
  say("lint and build");
  for (const script of ["lint.mjs", "build.mjs"]) {
    const r = spawnSync(process.execPath, [join(REPO, "scripts", script), slug], { cwd: REPO, encoding: "utf8", env: process.env });
    console.log((r.stdout + r.stderr).trim());
  }
}
finish(stopped === "usage" ? 3 : stopped === "user" ? 130 : failed.length || (formFailed && !draft) ? 1 : 0, { failedStages: failed, formFailed, draft });
