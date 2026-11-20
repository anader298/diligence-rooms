// The form check (gate) and run-room: stages in a fixed order for both engines, no build on a failed check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { composeRoom } from "../scripts/lib/compose.mjs";
import { submitEntry } from "../scripts/lib/entries.mjs";
import { roomForm, formGate } from "../scripts/lib/form.mjs";
import { lintRoom } from "../scripts/lib/lint.mjs";
import { moduleVars } from "../scripts/osint/run.mjs";
import { ENGINES } from "../scripts/lib/engines.mjs";

const REPO = join(import.meta.dirname, "..");

/** A composed room (Jane Doe, Acme Freight; fictional) whose scripted pass ran every module with nothing found but one row. */
async function scriptedRoom(base, { modes = ["pitch"], orgType = "other" } = {}) {
  const rooms = join(base, "rooms");
  mkdirSync(rooms, { recursive: true });
  const r = composeRoom({ company: "Acme Freight", domain: "acme-freight.example", people: "Jane Doe", goal: "pitch a routing contract", modes, orgType, date: "2026-12-01", now: "2026-11-12T10:00:00Z" }, { skeletonDir: join(REPO, "templates", "skeleton"), roomsDir: rooms, configDir: join(base, "config") });
  const mv = await moduleVars();
  const d = join(r.dir, "work", "osint", "jane-doe");
  mkdirSync(d, { recursive: true });
  const rows = [{ id: "L-0001", module: "sec-person", var: "role.title", value: "Chief Operating Officer", url: "https://www.sec.gov/x", grade: "p" }];
  writeFileSync(join(d, "ledger.jsonl"), rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
  writeFileSync(join(d, "osint.json"), JSON.stringify({ subject: { name: "Jane Doe", company: "Acme Freight", domain: "acme-freight.example" }, misses: [], modules: Object.keys(mv).map((id) => ({ id, status: "ok", vars: mv[id] })), rows }));
  return { ...r, rooms, mv };
}

/** Answer every bucket the gate asks for: "none found" for required buckets with no tool, cited text for AI slots. */
function answerAll(dir, mv) {
  const form = roomForm(dir, { moduleVars: mv });
  for (const b of form.buckets) {
    const who = b.person || undefined;
    if (b.kind === "ai" && (b.required || b.start)) submitEntry(dir, { bucket: b.id, person: who, value: `${b.label}: rests on the filed title`, cites: "jane-doe/L-0001" });
    else if (b.required && b.state === "no-tool") submitEntry(dir, { bucket: b.id, person: who, none: `searched the web for "Jane Doe" ${b.label}` });
  }
}

test("gate: fails on an empty required bucket, an AI slot not written and an empty Start here; passes once all are answered", async () => {
  const base = mkdtempSync(join(tmpdir(), "gate-"));
  try {
    const { dir, mv } = await scriptedRoom(base);
    let gate = formGate(roomForm(dir, { moduleVars: mv }));
    assert.equal(gate.ok, false);
    assert.ok(gate.errors.some((e) => /Start here: "Who decides, and on what" is not filled/.test(e)));
    assert.ok(gate.errors.some((e) => /required AI slot "Verdict: Proven, Mixed or Unproven" \(Jane Doe\)/.test(e)));
    assert.ok(gate.errors.some((e) => /required bucket "Fit: Strong, Partial or Gap"|required AI slot "Fit: Strong, Partial or Gap"/.test(e)), "mode packs add required slots");
    answerAll(dir, mv);
    gate = formGate(roomForm(dir, { moduleVars: mv }));
    assert.deepEqual(gate.errors, []);
    assert.equal(gate.ok, true);
    // one required bucket emptied again (its entry removed): the gate names it
    const f = join(dir, "work", "osint", "_company", "ledger.jsonl");
    writeFileSync(f, readFileSync(f, "utf8").split("\n").filter((l) => !l.includes('"bucket":"start.line"')).join("\n"));
    gate = formGate(roomForm(dir, { moduleVars: mv }));
    assert.deepEqual(gate.errors, ['Start here: "The line" is not filled (Searched, nothing found: AI slot not written yet)']);
    // lint carries the form check into its score and verdict
    const rep = lintRoom(dir, { skeletonDir: join(REPO, "templates", "skeleton"), moduleVars: mv });
    const c = rep.checks.find((x) => x.name === "form check errors");
    assert.ok(c && !c.ok && c.actual === 1);
    assert.ok(!rep.checks.some((x) => x.name === "checklist rows with no grade"), "the form replaces the page checklists");
    assert.ok(!rep.startEmpty.includes("room.json summary"), "the Start here summary bucket counts");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("lint: an empty Start here fails even in a room without a form", () => {
  const base = mkdtempSync(join(tmpdir(), "start-"));
  try {
    mkdirSync(join(base, "rooms"));
    const r = composeRoom({ company: "Acme Freight", people: "Jane Doe", goal: "pitch", orgType: "other", date: "2026-12-01", now: "2026-11-12T10:00:00Z" }, { skeletonDir: join(REPO, "templates", "skeleton"), roomsDir: join(base, "rooms"), configDir: join(base, "config") });
    const rep = lintRoom(r.dir, { skeletonDir: join(REPO, "templates", "skeleton") });
    assert.deepEqual(rep.startEmpty, ["room.json summary", "one-card"]);
    assert.ok(!rep.checks.find((c) => c.name === "Start here fields empty").ok);
    assert.equal(rep.form, undefined);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("run-room: Claude Code runs stage by stage in the fixed order; a failed form check stops the build; --draft builds", async () => {
  const base = mkdtempSync(join(tmpdir(), "runroom-"));
  try {
    const { slug, rooms } = await scriptedRoom(base);
    const bin = join(base, "bin");
    mkdirSync(bin);
    const stagesLog = join(base, "stages.log");
    // A fake claude: records the stage it was given and finishes cleanly.
    writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const m = input.match(/Stage: ([^\\n(]+?) \\(/);
  require("node:fs").appendFileSync(${JSON.stringify(stagesLog)}, (m ? m[1] : "?") + "\\n");
  console.log(JSON.stringify({ type: "result", is_error: false }));
});
`);
    chmodSync(join(bin, "claude"), 0o755);
    const cfgFile = join(base, "engine.json");
    writeFileSync(cfgFile, JSON.stringify({ engine: "claude", auth: "login", model: "", usageLimit: 65, test: { ok: true, engine: "claude", auth: "login", model: ENGINES.claude.defaultModel } }));
    const out = join(base, "site");
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DR_ROOMS: rooms, DR_ENGINE_CONFIG: cfgFile, DR_OUT: out };
    const run1 = spawnSync(process.execPath, [join(REPO, "scripts", "run-room.mjs"), slug], { env, encoding: "utf8", timeout: 120000 });
    assert.equal(run1.status, 1, run1.stdout + run1.stderr);
    const stages = readFileSync(stagesLog, "utf8").trim().split("\n");
    const firstOf = (re) => stages.findIndex((s) => re.test(s));
    const order = [/^P1$/, /^P2$/, /^P3a$/, /^P4a jane-doe$/, /^P4b jane-doe$/, /^P6$/, /^P5a$/, /^P7a$/, /^P7-fix$/, /^P8a jane-doe$/, /^P8$/, /^P9$/].map(firstOf);
    assert.ok(order.every((x, i) => x > -1 && (i === 0 || x > order[i - 1])), `stage order: ${stages.join(", ")}`);
    assert.ok(stages.includes("P8a company"));
    assert.match(run1.stdout, /OSINT pass: Jane Doe already done/);
    assert.match(run1.stdout, /form check FAILED \(\d+\): not building/);
    assert.ok(!existsSync(join(out, slug, "index.html")), "no build on a failed check");
    const last = JSON.parse(readFileSync(join(rooms, slug, "work", "last-run.json"), "utf8"));
    assert.equal(last.formFailed, true);
    assert.ok(existsSync(join(rooms, slug, "work", "form.json")));

    writeFileSync(stagesLog, "");
    const run2 = spawnSync(process.execPath, [join(REPO, "scripts", "run-room.mjs"), slug, "--draft"], { env, encoding: "utf8", timeout: 120000 });
    assert.equal(run2.status, 0, run2.stdout + run2.stderr);
    assert.match(run2.stdout, /building anyway as a draft/);
    assert.ok(existsSync(join(out, slug, "form.html")), "the draft is built, with its form page");
    assert.match(readFileSync(join(out, slug, "form.html"), "utf8"), /The build was allowed as a draft/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
