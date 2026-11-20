// The form: packs load and validate, states are computed from the ledgers, unknowns never break.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixtureRoom } from "./fixtures/form-room.mjs";
import { loadPacks, validatePack, selectPacks, instances, computeStates, roomForm, formGate, otherFindings, loadLedgers, resolveRef, bucketTable, STATES } from "../scripts/lib/form.mjs";

const REPO = join(import.meta.dirname, "..");
const SK = join(REPO, "templates", "skeleton");
const VARS = JSON.parse(readFileSync(join(REPO, "config", "osint-variables.json"), "utf8")).variables.map((v) => v.id);

const MV = { accounts: ["social.accounts"], sec: ["co.filings", "co.facts"], "sec-person": ["money.trades"], dns: ["co.domains", "fit.problem"], records: ["rec.courts", "rec.sanctions"] };

test("packs: every pack loads and validates; bucket ids unique; core covers all 111 OSINT variables", () => {
  const { packs, errors, warnings } = loadPacks();
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  for (const id of ["core-person", "core-company", "modes/deal", "modes/pitch", "modes/audit", "modes/interviewing", "orgtypes/public-company", "orgtypes/startup", "orgtypes/private-equity", "orgtypes/other", "extras/practice"]) assert.ok(packs[id], id);
  assert.ok(packs["core-person"].buckets.length >= 80 && packs["core-company"].buckets.length >= 40);
  const core = new Set([...packs["core-person"].buckets, ...packs["core-company"].buckets].flatMap((b) => b.vars || []));
  assert.equal(VARS.length, 111);
  assert.deepEqual(VARS.filter((v) => !core.has(v)), [], "every variable has a core bucket");
  // every bucket's page is a page its pack can have (core, or the pack's own skeleton pages)
  const pages = (sub) => (existsSync(join(SK, sub, "pack.json")) ? new Set(JSON.parse(readFileSync(join(SK, sub, "pack.json"), "utf8")).sections.flatMap((s) => s.pages.map((p) => p.id))) : new Set());
  const corePages = JSON.parse(readFileSync(join(SK, "core", "room.json"), "utf8")).sections.flatMap((s) => s.pages.map((p) => p.id.replace("-__PERSON_SLUG__", "")));
  for (const [id, p] of Object.entries(packs)) {
    const own = id.includes("/") ? pages(id) : new Set();
    for (const b of p.buckets) assert.ok(corePages.includes(b.page) || own.has(b.page), `${id} ${b.id}: page ${b.page}`);
  }
  // start-here fields and AI slots exist
  assert.ok(packs["core-company"].buckets.some((b) => b.start && b.kind === "ai"));
  assert.ok(packs["core-person"].buckets.some((b) => b.id === "persona.verdict" && b.kind === "ai" && b.required));
});

test("packs: a broken pack is reported, never thrown; unknown keys are warnings", () => {
  const base = mkdtempSync(join(tmpdir(), "packs-"));
  try {
    mkdirSync(join(base, "modes"));
    writeFileSync(join(base, "core-x.json"), JSON.stringify({ id: "core-x", scope: "company", buckets: [{ id: "a.one", label: "One", page: "p", group: "G", kind: "fact", vars: ["co.facts"], colour: "red" }] }));
    writeFileSync(join(base, "modes", "bad.json"), "{ not json");
    writeFileSync(join(base, "modes", "worse.json"), JSON.stringify({ id: "modes/worse", buckets: [{ id: "Bad Id", kind: "maybe" }, { id: "a.one", label: "x", page: "p", group: "g", kind: "list", match: "(" }] }));
    const r = loadPacks(base);
    assert.ok(r.packs["core-x"]);
    assert.ok(!r.packs["modes/bad"] && !r.packs["modes/worse"]);
    assert.ok(r.errors.some((e) => /modes\/bad/.test(e)));
    assert.ok(r.errors.some((e) => /kind must be/.test(e)) && r.errors.some((e) => /match is not a valid/.test(e)));
    assert.ok(r.warnings.some((w) => /unknown key "colour"/.test(w)));
    assert.deepEqual(validatePack(null).errors.length, 1);
    const sel = selectPacks(r.packs, { modes: ["deal"], orgType: "startup" });
    assert.deepEqual(sel.missing, ["modes/deal", "orgtypes/startup"], "a selection with no pack file is reported");
    assert.deepEqual(sel.packs.map((p) => p.id), ["core-x"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("states: filled (best grade), searched-and-empty, couldn't check, no tool yet; never more than one", () => {
  const base = mkdtempSync(join(tmpdir(), "states-"));
  try {
    const dir = fixtureRoom(base, {
      rows: [
        { var: "social.accounts", value: "linkedin.com/in/janedoe", url: "https://www.linkedin.com/in/janedoe", grade: "p" },
        { var: "co.filings", value: "10-K 2025", url: "https://www.sec.gov/x", grade: "v" },
        { var: "co.filings", value: "8-K", url: "https://www.sec.gov/y", grade: "w" },
        { var: "role.status", value: "current", grade: "p" }, // a var no bucket knows
      ],
      misses: [{ module: "records", var: "rec.courts", searched: "CourtListener: no case naming Jane Doe" }, { module: "sec-person", var: "money.trades", searched: "SEC lookup blocked (HTTP 403): not checked" }],
      modules: [{ id: "accounts", status: "ok" }, { id: "sec", status: "ok" }, { id: "sec-person", status: "blocked", why: "403" }, { id: "dns", status: "skipped", why: "needs domain" }, { id: "records", status: "ok" }],
    });
    const form = roomForm(dir, { moduleVars: MV });
    const get = (k) => form.buckets.find((b) => b.key === k);
    assert.equal(get("jane-doe/socials.linkedin").state, "filled");
    assert.equal(get("jane-doe/socials.linkedin").grade, "p");
    assert.equal(get("jane-doe/socials.x").state, "empty", "accounts ran: X searched, none found");
    assert.equal(get("filings.recent").state, "filled");
    assert.equal(get("filings.recent").grade, "v", "best grade first");
    assert.deepEqual(get("filings.recent").refs, ["jane-doe/L-0002", "jane-doe/L-0003"]);
    assert.equal(get("jane-doe/record.courts").state, "empty");
    assert.match(get("jane-doe/record.courts").why, /CourtListener/);
    assert.equal(get("jane-doe/money.trades").state, "blocked");
    assert.equal(get("outside.domains").state, "blocked");
    assert.match(get("outside.domains").why, /needs domain/);
    assert.equal(get("jane-doe/names.namesakes").state, "no-tool");
    assert.equal(get("co.name").state, "filled");
    assert.equal(get("co.name").grade, "intake");
    assert.equal(get("start.ask").value, "pitch a routing contract");
    for (const b of form.buckets) assert.ok(STATES.includes(b.state), b.key);
    // unknown var: shown under Other findings, nothing breaks
    assert.deepEqual(form.other.map((r) => r.var), ["role.status"]);
    // packs: core + pitch + startup selected from the intake
    assert.deepEqual(form.packs.map((p) => p.id), ["core-company", "core-person", "modes/pitch", "orgtypes/startup"]);
    // no ledger at all: today's behaviour (no form)
    rmSync(join(dir, "work"), { recursive: true });
    assert.equal(roomForm(dir, { moduleVars: MV }), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("states: before the scripted pass a bucket is couldn't-check, not empty", () => {
  const base = mkdtempSync(join(tmpdir(), "notrun-"));
  try {
    const dir = fixtureRoom(base, { ran: false, rows: [{ var: "co.facts", value: "x", url: "https://a.example", grade: "p" }] });
    const form = roomForm(dir, { moduleVars: MV });
    const b = form.buckets.find((x) => x.key === "jane-doe/record.courts");
    assert.equal(b.state, "blocked");
    assert.match(b.why, /has not run/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("unknowns: an entry naming a bucket no pack has goes to Other findings; a missing page is a warning", () => {
  const base = mkdtempSync(join(tmpdir(), "unknown-"));
  try {
    const dir = fixtureRoom(base, { company: [{ id: "L-0001", module: "agent", bucket: "no.such.bucket", var: "no.such.bucket", value: "something", url: "https://a.example", grade: "p" }] });
    const form = roomForm(dir, { moduleVars: MV, pageIds: new Set(["one-card"]) });
    assert.equal(form.other.length, 1);
    assert.ok(form.other[0].unknownBucket);
    const gate = formGate(form);
    assert.ok(gate.warnings.some((w) => /no\.such\.bucket/.test(w)));
    assert.ok(gate.warnings.some((w) => /page "socials-jane-doe" is not in this room/.test(w)));
    // a selected mode with no pack file: warned on the form, failed by the gate
    writeFileSync(join(dir, "intake.json"), JSON.stringify({ company: "Acme Freight", modes: ["ceo-to-ceo"], orgType: "startup", people: [{ name: "Jane Doe", slug: "jane-doe" }] }));
    const f2 = roomForm(dir, { moduleVars: MV });
    assert.deepEqual(f2.missingPacks, ["modes/ceo-to-ceo"]);
    assert.ok(formGate(f2).errors.some((e) => /modes\/ceo-to-ceo/.test(e)));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("refs: bare ids resolve in the home ledger, qualified ids anywhere; Other findings dedupe", () => {
  const ledgers = { a: { name: "a", rows: [{ id: "L-0001", var: "x.y", value: 1, ref: "a/L-0001" }], misses: [], modules: [] }, b: { name: "b", rows: [{ id: "L-0001", var: "x.y", value: 1, ref: "b/L-0001" }], misses: [], modules: [] } };
  assert.equal(resolveRef(ledgers, "L-0001", "a").ref, "a/L-0001");
  assert.equal(resolveRef(ledgers, "b/L-0001", "a").ref, "b/L-0001");
  assert.equal(resolveRef(ledgers, "L-0009", "a"), null);
  assert.equal(resolveRef(ledgers, "nonsense", "a"), null);
  assert.equal(otherFindings([], ledgers).length, 1, "the same row in two ledgers is one finding");
  assert.deepEqual(loadLedgers("/no/such/room"), {});
});

test("instances: person buckets repeat per person with the page suffix; bucketTable lists every pack", () => {
  const { packs } = loadPacks();
  const insts = instances([packs["core-person"], packs["core-company"]], [{ name: "Jane Doe", slug: "jane-doe" }, { name: "Raj Rao", slug: "raj-rao" }]);
  assert.equal(insts.filter((i) => i.scope === "person").length, 2 * packs["core-person"].buckets.length);
  assert.ok(insts.some((i) => i.key === "raj-rao/socials.github" && i.pageId === "socials-raj-rao"));
  const md = bucketTable(packs);
  for (const id of Object.keys(packs)) assert.match(md, new RegExp(`## ${id.replace("/", "\\/")} \\(`));
  const st = computeStates(insts.slice(0, 3), {}, {});
  assert.ok(st.every((b) => b.state === "blocked" || b.state === "no-tool"));
});
