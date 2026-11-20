// How far along a room build is, from what is on disk: pages filled, the verification files,
// the summary, and (for Codex runs) the wave markers in run.log. No guessing from the clock.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const WAVES = ["inventory", "harvest", "research", "people-osint", "personas", "mirror", "synthesis", "verification", "corrections", "ai-slots", "render", "one-card"];
const WAVE_LABEL = { inventory: "Inventory", harvest: "Collecting sources", research: "Company research", "people-osint": "People research", personas: "Personas", mirror: "How they see us", synthesis: "Writing banks and pages", verification: "Checking the facts", corrections: "Applying fixes", "ai-slots": "AI judgement slots", render: "Rendering pages", "one-card": "One card and summary" };

const has = (files, re) => files.some((f) => re.test(f));

/**
 * lint: lintRoom() result (pages, skeleton[]). logTail: run.log text (read from disk when null).
 * Returns { pct, label, pagesDone, pages, stage, stageIndex, stageCount, startedAt, done }.
 */
export function roomProgress(roomDir, lint, logTail = null, { running = false } = {}) {
  const log = join(roomDir, "run.log");
  if (logTail == null) logTail = existsSync(log) && statSync(log).size < 40e6 ? readFileSync(log, "utf8") : "";
  const pages = lint?.pages || 0;
  const pagesDone = pages ? pages - (lint.skeleton?.length || 0) : 0;
  const work = join(roomDir, "work");
  const files = existsSync(work) ? readdirSync(work) : [];
  let room = {};
  try {
    room = JSON.parse(readFileSync(join(roomDir, "room.json"), "utf8"));
  } catch {}
  let lastRun = null;
  try {
    lastRun = JSON.parse(readFileSync(join(work, "last-run.json"), "utf8"));
  } catch {}

  const verified = (has(files, /^ACCURACY REVIEW/i) ? 0.5 : 0) + (has(files, /^GAP REVIEW/i) ? 0.5 : 0);
  const corrected = has(files, /^CORRECTIONS LOG/i) ? 1 : 0;
  const summary = String(room.summary || "").trim() ? 1 : 0;
  // Pages carry most of the work; the last three steps happen after the pages are written.
  let pct = (pages ? 85 * (pagesDone / pages) : 0) + 5 * verified + 5 * corrected + 5 * summary;

  // Codex runs log their waves: use them for the stage name, and as a floor for the bar.
  const waves = [...String(logTail).matchAll(/^\[run [^\]]*\] == wave: ([a-z-]+)/gm)].map((m) => m[1]);
  let stage = null;
  let stageIndex = null;
  if (waves.length) {
    stage = waves.at(-1);
    stageIndex = WAVES.indexOf(stage);
    if (stageIndex >= 0) pct = Math.max(pct, (100 * stageIndex) / WAVES.length);
  }

  const logTime = existsSync(log) ? statSync(log).mtimeMs : 0;
  // Finished only if the last run ended cleanly after the current log was last written.
  const done = !running && lastRun?.code === 0 && Date.parse(lastRun.endedAt) >= logTime - 60000;
  pct = done ? 100 : Math.min(running ? 99 : 100, Math.round(pct));

  let label;
  if (done) label = "Finished";
  else if (stage) label = `Stage ${stageIndex + 1} of ${WAVES.length}: ${WAVE_LABEL[stage] || stage}`;
  else if (summary) label = "Writing the summary";
  else if (corrected) label = "Applying fixes";
  else if (verified) label = "Checking the facts";
  else if (pagesDone) label = "Researching and writing pages";
  else if (has(files, /^corpus$/) || has(files, /^INVENTORY/i)) label = "Collecting sources";
  else label = "Starting";

  const startedAt = existsSync(log) ? statSync(log).birthtime.toISOString() : null;
  return { pct, label, pagesDone, pages, stage, stageIndex, stageCount: WAVES.length, startedAt, done: !!done };
}
