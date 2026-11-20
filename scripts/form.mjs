#!/usr/bin/env node
// The form for a room: every bucket and its state, computed from the ledgers.
//
//   npm run form -- <slug>            print every bucket with its state; writes work/form.json
//   npm run form -- <slug> --check    the form check (gate); exits 1 when it fails
//   npm run form -- <slug> --json     the form as JSON
//   npm run form -- --table           the bucket list as markdown (docs/form-buckets.md)
//   npm run form -- --packs           check every pack file loads (schema check)
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, SLUG_RE } from "./lib/compose.mjs";
import { loadPacks, roomForm, formGate, bucketTable, STATE_LABEL, stateLabel, GRADE_LABEL } from "./lib/form.mjs";
import { moduleVars } from "./osint/run.mjs";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const slug = args.find((a) => !a.startsWith("--"));

if (flag("--table")) {
  const { packs, errors } = loadPacks();
  if (errors.length) console.error(errors.join("\n"));
  console.log(bucketTable(packs, await moduleVars()));
  process.exit(errors.length ? 1 : 0);
}
if (flag("--packs")) {
  const { packs, errors, warnings } = loadPacks();
  for (const [id, p] of Object.entries(packs)) console.log(`${id.padEnd(26)} ${String(p.buckets.length).padStart(4)} buckets`);
  for (const w of warnings) console.log(`warning: ${w}`);
  for (const e of errors) console.log(`ERROR: ${e}`);
  process.exit(errors.length ? 1 : 0);
}
if (!SLUG_RE.test(slug || "")) {
  console.error("usage: npm run form -- <slug> [--check] [--json] | --table | --packs");
  process.exit(2);
}
const roomDir = join(process.env.DR_ROOMS || join(REPO, "rooms"), slug);
if (!existsSync(join(roomDir, "room.json"))) {
  console.error(`rooms/${slug}/room.json not found`);
  process.exit(2);
}
const room = JSON.parse(readFileSync(join(roomDir, "room.json"), "utf8"));
const pageIds = new Set((room.sections || []).flatMap((s) => (s.pages || []).map((p) => p.id)));
const form = roomForm(roomDir, { moduleVars: await moduleVars(), pageIds });
const gate = formGate(form);
if (form) {
  mkdirSync(join(roomDir, "work"), { recursive: true });
  writeFileSync(join(roomDir, "work", "form.json"), JSON.stringify({ ...form, gate }, null, 1));
}
if (flag("--json")) console.log(JSON.stringify({ ...form, gate }, null, 1));
else if (form) {
  let last = null;
  for (const b of form.buckets) {
    const head = `${b.pack}${b.personName ? " · " + b.personName : ""}`;
    if (head !== last) console.log(`\n${head}`);
    last = head;
    const g = b.state === "filled" ? ` ${GRADE_LABEL[b.grade] || b.grade}` : "";
    const src = b.state === "filled" ? (b.refs.length ? `  ${b.refs.slice(0, 3).join(", ")}${b.refs.length > 3 ? ` +${b.refs.length - 3}` : ""}` : `  ${b.why || ""}`) : `  ${b.why || ""}`;
    console.log(`  ${b.required ? "*" : " "} ${b.id.padEnd(28)} ${(stateLabel(b) + g).padEnd(34)}${src.slice(0, 120)}`);
  }
  console.log(`\nOther findings (rows in no bucket): ${form.other.length}`);
  console.log(`States: ${Object.entries(form.counts).map(([k, v]) => `${STATE_LABEL[k]} ${v}`).join(" · ")}  (${form.buckets.length} buckets; packs ${form.packs.map((p) => p.id).join(", ")})`);
} else console.log("no form yet: the scripted pass has not run for this room (work/osint/ is empty)");
for (const w of gate.warnings) console.log(`warning: ${w}`);
if (flag("--check") || !gate.ok) {
  console.log(gate.ok ? "form check: PASS" : `form check: FAIL (${gate.errors.length})\n${gate.errors.map((e) => "  - " + e).join("\n")}`);
}
if (flag("--check") && !gate.ok) process.exit(1);
