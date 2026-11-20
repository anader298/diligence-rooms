// Entries: agents hand in {bucket, value, url, note}; code grades them with the two-source rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { submitEntry, regrade } from "../scripts/lib/entries.mjs";
import { makeLedger } from "../scripts/osint/core.mjs";
import { isPrimary } from "../scripts/osint/weights.mjs";
import { roomForm, formGate } from "../scripts/lib/form.mjs";
import { fixtureRoom } from "./fixtures/form-room.mjs";

const REPO = join(import.meta.dirname, "..");
const MV = { "sec-person": ["role.title", "money.trades"], accounts: ["social.accounts"] };
const ledgerRows = (dir, name) => readFileSync(join(dir, "work", "osint", name, "ledger.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const scriptTitle = { var: "role.title", module: "sec-person", value: "Chief Operating Officer", url: "https://www.sec.gov/Archives/edgar/data/1/form4.xml", grade: "p", graded_from: "v", grade_basis: "one source (sec); Verified needs two independent sources or a primary record" };

test("entries: an agent cannot write Verified alone; a second independent source makes it Verified", () => {
  const base = mkdtempSync(join(tmpdir(), "entries-"));
  try {
    const dir = fixtureRoom(base, { rows: [scriptTitle], modules: [{ id: "sec-person", status: "ok" }] });
    // one source, no agreement: Partly verified, whatever the agent wanted
    const a = submitEntry(dir, { bucket: "seat.budget", person: "jane-doe", value: "Runs a $40m network budget", url: "https://news.example/jane-doe-profile" });
    assert.equal(a.row.grade, "p");
    assert.equal(a.row.claim, "v");
    assert.match(a.row.grade_basis, /one source/);
    assert.equal(a.row.module, "agent");
    assert.equal(a.row.bucket, "seat.budget");
    // agrees with the SEC row from another source family (the company's own site): both Verified
    const b = submitEntry(dir, { bucket: "seat.title", person: "jane-doe", value: "Jane Doe, Chief Operating Officer", url: "https://acme-freight.example/team" });
    assert.equal(b.row.grade, "v");
    assert.match(b.row.grade_basis, /2 independent sources/);
    const rows = ledgerRows(dir, "jane-doe");
    assert.equal(rows.find((r) => r.module === "sec-person").grade, "v", "the script row is lifted by the new, independent source");
    // --weak stays weak
    const c = submitEntry(dir, { bucket: "socials.x", person: "jane-doe", value: "@janedoe_ops", url: "https://x.com/janedoe_ops", weak: true });
    assert.equal(c.row.grade, "w");
    // the form now shows the states from those rows
    const form = roomForm(dir, { moduleVars: MV });
    const get = (k) => form.buckets.find((x) => x.key === k);
    assert.equal(get("jane-doe/seat.title").state, "filled");
    assert.equal(get("jane-doe/seat.title").grade, "v");
    assert.equal(get("jane-doe/seat.budget").grade, "p");
    assert.equal(get("jane-doe/socials.x").grade, "w");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("entries: every line is cited, buckets must exist and be selected, none-found says what was searched", () => {
  const base = mkdtempSync(join(tmpdir(), "entries2-"));
  try {
    const dir = fixtureRoom(base, { rows: [scriptTitle] });
    assert.throws(() => submitEntry(dir, { bucket: "seat.title", person: "jane-doe", value: "COO" }), /every line is cited/);
    assert.throws(() => submitEntry(dir, { bucket: "seat.nope", person: "jane-doe", value: "x", url: "https://a.example" }), /no bucket "seat.nope".*near: seat\.title/);
    assert.throws(() => submitEntry(dir, { bucket: "seat.title", value: "x", url: "https://a.example" }), /per person: pass --person/);
    assert.throws(() => submitEntry(dir, { bucket: "deal.history", value: "x", url: "https://a.example" }), /modes\/deal, which this room did not select/);
    assert.throws(() => submitEntry(dir, { bucket: "life.weekends", person: "jane-doe", none: " " }), /says what was searched/);
    const n = submitEntry(dir, { bucket: "life.weekends", person: "jane-doe", none: 'DDG "Jane Doe" sailing; yacht club rosters' });
    assert.equal(n.row.grade, "n");
    const company = submitEntry(dir, { bucket: "st.rounds", value: "Seed, $4m, 2024 (press release)", url: "https://acme-freight.example/news/seed" });
    assert.equal(company.ledger, "_company");
    const form = roomForm(dir, { moduleVars: MV });
    const w = form.buckets.find((x) => x.key === "jane-doe/life.weekends");
    assert.equal(w.state, "empty");
    assert.match(w.why, /yacht club/);
    assert.equal(form.buckets.find((x) => x.key === "st.rounds").state, "filled");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("AI slots: must cite ledger ids that exist; graded inference; the gate catches a cite that vanished", () => {
  const base = mkdtempSync(join(tmpdir(), "ai-"));
  try {
    const dir = fixtureRoom(base, { rows: [scriptTitle, { var: "career.timeline", value: "VP Operations at Contoso 2018-2024", url: "https://news.example/a", grade: "p" }] });
    assert.throws(() => submitEntry(dir, { bucket: "persona.verdict", person: "jane-doe", value: "Proven: ..." }), /must cite the ledger ids/);
    assert.throws(() => submitEntry(dir, { bucket: "persona.verdict", person: "jane-doe", value: "Proven", cites: "L-0001,L-0099" }), /not in any ledger: L-0099/);
    const v = submitEntry(dir, { bucket: "persona.verdict", person: "jane-doe", value: "Mixed: the seat is on file, the claimed scale is not", cites: "L-0001, L-0002" });
    assert.equal(v.row.grade, "i");
    assert.deepEqual(v.row.cites, ["jane-doe/L-0001", "jane-doe/L-0002"]);
    const s = submitEntry(dir, { bucket: "start.summary", value: "Meeting the COO about routing.", cites: "jane-doe/L-0001" });
    assert.deepEqual(s.row.cites, ["jane-doe/L-0001"]);
    assert.throws(() => submitEntry(dir, { bucket: "start.line", value: "x", cites: "L-0002" }), /not in any ledger/, "bare ids in a company slot mean _company");
    assert.throws(() => submitEntry(dir, { bucket: "start.line", value: "x", cites: "_company/L-0001" }), /AI entries, not evidence/, "an AI slot cannot rest on another AI slot");
    let form = roomForm(dir, { moduleVars: MV });
    const verdict = form.buckets.find((b) => b.key === "jane-doe/persona.verdict");
    assert.equal(verdict.state, "filled");
    assert.equal(verdict.kind, "ai");
    // the ledger is re-run and the cited row is gone: the gate fails on the stale cite
    const f = join(dir, "work", "osint", "jane-doe", "ledger.jsonl");
    writeFileSync(f, readFileSync(f, "utf8").split("\n").filter((l) => !l.includes('"L-0002"')).join("\n"));
    form = roomForm(dir, { moduleVars: MV });
    assert.equal(form.buckets.find((b) => b.key === "jane-doe/persona.verdict").state, "empty");
    const gate = formGate(form);
    assert.ok(gate.errors.some((e) => /cites jane-doe\/L-0002, which is not an evidence row in any ledger/.test(e)), gate.errors.join("\n"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("add.mjs: --grade v from an agent is a claim; one source is shown as Partly verified", () => {
  const base = mkdtempSync(join(tmpdir(), "add-"));
  try {
    const d = join(base, "jane-doe");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "osint.json"), JSON.stringify({ subject: { name: "Jane Doe", company: "Acme Freight" }, rows: [], misses: [], modules: [], tabs: [], variables: [] }));
    const out = execFileSync(process.execPath, [join(REPO, "scripts", "osint", "add.mjs"), d, "--var", "hobby.sports", "--value", "Coaches a youth soccer team", "--url", "https://league.example/coaches", "--grade", "v"], { encoding: "utf8" });
    assert.match(out, /^L-0001\s+grade p/);
    const rows = readFileSync(join(d, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].grade, "p");
    assert.equal(rows[0].claim, "v");
    assert.equal(JSON.parse(readFileSync(join(d, "osint.json"), "utf8")).rows[0].grade, "p");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("add.mjs: an agent row claiming module sec with a sec.gov URL is not a primary record; it is regraded to Partly", () => {
  const base = mkdtempSync(join(tmpdir(), "add-sec-"));
  try {
    const url = "https://www.sec.gov/Archives/edgar/data/1234/000123456726000001/form10k.htm";
    // the same row from the SEC module itself is a primary record (the exemption is real)
    assert.equal(isPrimary({ module: "sec", var: "co.segments", value: "two segments", url }, {}), true);
    assert.equal(isPrimary({ module: "sec", origin: "agent", var: "co.segments", value: "two segments", url }, {}), false);

    const d = join(base, "_company");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "osint.json"), JSON.stringify({ subject: { name: null, company: "Acme Freight" }, rows: [], misses: [], modules: [], tabs: [], variables: [] }));
    const out = execFileSync(process.execPath, [join(REPO, "scripts", "osint", "add.mjs"), d, "--var", "co.segments", "--value", "Two reportable segments", "--url", url, "--grade", "v", "--module", "sec"], { encoding: "utf8" });
    assert.match(out, /^L-0001\s+grade p/);
    const [row] = readFileSync(join(d, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(row.module, "sec", "the label is kept");
    assert.equal(row.origin, "agent", "code marks where the row came from");
    assert.equal(row.grade, "p");
    assert.match(row.grade_basis, /one source/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("regrade: every agent-origin row goes back to its claim and through the two-source rule, not only module agent", () => {
  const base = mkdtempSync(join(tmpdir(), "regrade-"));
  try {
    const d = join(base, "_company");
    mkdirSync(d, { recursive: true });
    const url = "https://www.sec.gov/Archives/edgar/data/1234/x/10k.htm";
    // written before the fix: an agent row labelled sec that kept Verified as a "primary record",
    // and one already marked origin agent under another module name
    const old = [
      { id: "L-0001", module: "sec", var: "co.segments", value: "Two reportable segments", url, grade: "v", claim: "v", grade_basis: "primary record", key: "a" },
      { id: "L-0002", module: "dns", origin: "agent", var: "co.domains", value: "Email on Google Workspace", url: "https://dns.google/resolve?name=acme.example&type=TXT", grade: "v", claim: "v", grade_basis: "primary record", key: "b" },
      { id: "L-0003", module: "sec", var: "co.filings", value: "10-K filed 2026-02-01", url, grade: "v", key: "c" },
    ];
    writeFileSync(join(d, "ledger.jsonl"), old.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const ledger = makeLedger(d, []);
    regrade(ledger, { subject: { company: "Acme Freight", domain: "acme.example" } });
    const byId = Object.fromEntries(readFileSync(join(d, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((r) => [r.id, r]));
    assert.equal(byId["L-0001"].grade, "p", "an agent row labelled sec is regraded to Partly");
    assert.equal(byId["L-0001"].origin, "agent", "older agent rows are marked");
    assert.equal(byId["L-0002"].grade, "p", "origin agent under any module name is regraded");
    assert.equal(byId["L-0003"].grade, "v", "the SEC module's own row is still a primary record");
    assert.equal(byId["L-0003"].origin, undefined);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("AI slots: a none-found entry is refused at submit time and does not clear the slot in the check", () => {
  const base = mkdtempSync(join(tmpdir(), "ai-none-"));
  try {
    const dir = fixtureRoom(base, { rows: [scriptTitle] });
    assert.throws(() => submitEntry(dir, { bucket: "persona.verdict", person: "jane-doe", none: "nothing public on how she judges vendors" }), /cannot take a "none found" entry/);
    assert.throws(() => submitEntry(dir, { bucket: "start.summary", none: "not enough to summarise" }), /cannot take a "none found" entry/);
    // a fact bucket still takes one
    assert.equal(submitEntry(dir, { bucket: "life.weekends", person: "jane-doe", none: "DDG weekend sailing" }).row.grade, "n");

    // a none-found row on an AI slot written before the refusal (or by hand) is not counted
    const f = join(dir, "work", "osint", "jane-doe", "ledger.jsonl");
    writeFileSync(f, readFileSync(f, "utf8") + JSON.stringify({ id: "L-0099", module: "agent", origin: "agent", bucket: "persona.verdict", var: "persona.verdict", entry: "ai", value: "None found", grade: "n", note: "nothing public" }) + "\n");
    let form = roomForm(dir, { moduleVars: MV });
    const verdict = form.buckets.find((b) => b.key === "jane-doe/persona.verdict");
    assert.equal(verdict.state, "empty");
    assert.equal(verdict.aiOpen, true, "the slot still reads Not written yet");
    let gate = formGate(form);
    assert.ok(gate.errors.some((e) => /required AI slot "Verdict: Proven, Mixed or Unproven" \(Jane Doe\) \[persona.verdict\] is not written/.test(e)), gate.errors.join("\n"));

    // a real judgement with citations clears it
    submitEntry(dir, { bucket: "persona.verdict", person: "jane-doe", value: "Mixed: the seat is on file, the scale claim is not", cites: "L-0001" });
    form = roomForm(dir, { moduleVars: MV });
    assert.equal(form.buckets.find((b) => b.key === "jane-doe/persona.verdict").state, "filled");
    gate = formGate(form);
    assert.ok(!gate.errors.some((e) => /persona.verdict/.test(e)), gate.errors.join("\n"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
