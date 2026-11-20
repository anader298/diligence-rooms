// The build renders the form by code: every bucket on its page with its state, plus a form page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { composeRoom } from "../scripts/lib/compose.mjs";
import { submitEntry } from "../scripts/lib/entries.mjs";
import { formPage } from "../scripts/lib/form-render.mjs";
import { stagePlan } from "../scripts/lib/stages.mjs";

const REPO = join(import.meta.dirname, "..");

test("build: buckets render on their pages with states; a form page; rooms without ledgers build as before", () => {
  const base = mkdtempSync(join(tmpdir(), "form-build-"));
  try {
    const rooms = join(base, "rooms");
    mkdirSync(rooms);
    const paths = { skeletonDir: join(REPO, "templates", "skeleton"), roomsDir: rooms, configDir: join(base, "config") };
    const r = composeRoom({ company: "Acme Freight", domain: "acme-freight.example", people: "Jane Doe", goal: "pitch a routing contract", modes: ["pitch"], orgType: "startup", date: "2026-12-01", now: "2026-11-12T10:00:00Z" }, paths);
    composeRoom({ company: "Old Room Co", people: "Raj Rao", goal: "pitch", orgType: "other", date: "2026-12-01", now: "2026-11-12T10:00:00Z" }, paths);
    const d = join(r.dir, "work", "osint", "jane-doe");
    mkdirSync(d, { recursive: true });
    const rows = [
      { id: "L-0001", module: "accounts", var: "social.accounts", value: "LinkedIn /in/janedoe", url: "https://www.linkedin.com/in/janedoe", grade: "p" },
      { id: "L-0002", module: "search", var: "role.status", value: "a var no bucket knows", url: "https://news.example/x", grade: "w" },
    ];
    writeFileSync(join(d, "ledger.jsonl"), rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
    writeFileSync(join(d, "osint.json"), JSON.stringify({ subject: { name: "Jane Doe", company: "Acme Freight", domain: "acme-freight.example" }, misses: [], modules: [{ id: "accounts", status: "ok" }, { id: "records", status: "blocked", why: "HTTP 429" }], rows }));
    submitEntry(r.dir, { bucket: "persona.verdict", person: "jane-doe", value: "Mixed: the seat checks out, the scale claim does not", cites: "L-0001" });
    submitEntry(r.dir, { bucket: "start.summary", value: "Meeting Jane Doe at Acme Freight about a routing contract.", cites: "jane-doe/L-0001" });

    const out = join(base, "site");
    // this room's form check fails (most required buckets have no entry yet): a draft build
    execFileSync(process.execPath, [join(REPO, "scripts", "build.mjs"), "--draft"], { env: { ...process.env, DR_OUT: out, DR_ROOMS: rooms }, stdio: "pipe" });
    const socials = readFileSync(join(out, r.slug, "socials-jane-doe.html"), "utf8");
    assert.match(socials, /<section class="form-block"><h2 id="[^"]+">On the form<\/h2>/);
    assert.match(socials, /data-bucket="jane-doe\/socials.linkedin"[\s\S]*?<span class="grade partly">Partly verified<\/span>/);
    assert.match(socials, /data-bucket="jane-doe\/socials.x"[\s\S]*?Searched, nothing found/);
    assert.match(socials, /<a class="src" href="https:\/\/www.linkedin.com\/in\/janedoe"><span class="vh">Source: <\/span>linkedin.com<\/a>/);
    const record = readFileSync(join(out, r.slug, "public-record-jane-doe.html"), "utf8");
    assert.match(record, /data-bucket="jane-doe\/record.courts"[\s\S]*?Couldn&#39;t check|data-bucket="jane-doe\/record.courts"[\s\S]*?Couldn't check/);
    assert.match(record, /data-bucket="jane-doe\/record.liens"[\s\S]*?No tool yet/);
    const persona = readFileSync(join(out, r.slug, "persona-jane-doe.html"), "utf8");
    assert.match(persona, /Verdict: Proven, Mixed or Unproven <span class="ai-tag">AI judgement<\/span>/);
    assert.match(persona, /Rests on jane-doe\/L-0001/);
    const form = readFileSync(join(out, r.slug, "form.html"), "utf8");
    assert.match(form, /<h2 id="[^"]*">Other findings<\/h2>/);
    assert.match(form, /role.status/);
    assert.match(form, /Form check/);
    assert.match(form, /Failed \(\d+\)\. This is a draft: the build was run with --draft/, "the draft notice shows on a real draft build");
    const index = readFileSync(join(out, r.slug, "index.html"), "utf8");
    assert.match(index, /Meeting Jane Doe at Acme Freight about a routing contract\./, "an empty summary is filled from the Start here bucket");
    assert.match(index, /href="form.html"/);
    // the room with no ledger: no form page, no blocks
    assert.ok(!existsSync(join(out, "old-room-co", "form.html")));
    assert.doesNotMatch(readFileSync(join(out, "old-room-co", "socials-raj-rao.html"), "utf8"), /form-block/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("build: refuses a room whose form check fails unless --draft; leaves site/ alone; rooms without form data build", () => {
  const base = mkdtempSync(join(tmpdir(), "form-refuse-"));
  try {
    const rooms = join(base, "rooms");
    mkdirSync(rooms);
    const paths = { skeletonDir: join(REPO, "templates", "skeleton"), roomsDir: rooms, configDir: join(base, "config") };
    const r = composeRoom({ company: "Acme Freight", domain: "acme-freight.example", people: "Jane Doe", goal: "pitch a routing contract", modes: ["pitch"], orgType: "startup", date: "2026-12-01", now: "2026-11-12T10:00:00Z" }, paths);
    const plain = composeRoom({ company: "Old Room Co", people: "Raj Rao", goal: "pitch", orgType: "other", date: "2026-12-01", now: "2026-11-12T10:00:00Z" }, paths);
    const d = join(r.dir, "work", "osint", "jane-doe");
    mkdirSync(d, { recursive: true });
    const rows = [{ id: "L-0001", module: "accounts", var: "social.accounts", value: "LinkedIn /in/janedoe", url: "https://www.linkedin.com/in/janedoe", grade: "p" }];
    writeFileSync(join(d, "ledger.jsonl"), rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
    writeFileSync(join(d, "osint.json"), JSON.stringify({ subject: { name: "Jane Doe", company: "Acme Freight" }, misses: [], modules: [{ id: "accounts", status: "ok" }], rows }));

    const out = join(base, "site");
    mkdirSync(out);
    writeFileSync(join(out, "keep.txt"), "an earlier build");
    const env = { ...process.env, DR_OUT: out, DR_ROOMS: rooms };
    const run = (args) => spawnSync(process.execPath, [join(REPO, "scripts", "build.mjs"), ...args], { env, encoding: "utf8" });

    // no --draft: refused, with the reasons, and nothing built or removed
    const no = run([r.slug]);
    assert.equal(no.status, 1, no.stdout + no.stderr);
    assert.match(no.stderr, /form check FAILED/);
    assert.match(no.stderr, /not building: the form check failed for acme-freight/);
    assert.match(no.stderr, /Start here/);
    assert.ok(!existsSync(join(out, r.slug)), "the failing room is not built");
    assert.ok(existsSync(join(out, "keep.txt")), "site/ is left as it was");
    // building every room is refused too when one fails
    assert.equal(run([]).status, 1);

    // a room with no form data builds exactly as before, without --draft
    const ok = run([plain.slug]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(existsSync(join(out, plain.slug, "index.html")));
    assert.ok(!existsSync(join(out, plain.slug, "form.html")));

    // --draft builds it, and says so
    const dr = run([r.slug, "--draft"]);
    assert.equal(dr.status, 0, dr.stderr);
    assert.match(dr.stdout, /\[DRAFT: form check failed\]/);
    assert.match(readFileSync(join(out, r.slug, "form.html"), "utf8"), /This is a draft: the build was run with --draft/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("form page: the draft notice shows only on a draft build", () => {
  const form = { counts: { filled: 0, empty: 0, blocked: 0, "no-tool": 0 }, packs: [], buckets: [], other: [] };
  const failed = { ok: false, errors: ["Start here: x is not filled"], warnings: [] };
  assert.doesNotMatch(formPage(form, failed), /draft/i, "a failed check without --draft never claims a draft");
  assert.match(formPage(form, failed, { draft: true }), /This is a draft: the build was run with --draft/);
  assert.match(formPage(form, { ok: true, errors: [], warnings: [] }, { draft: true }), /Passed/);
});

test("render stage: agents run the form check, not the build", () => {
  const md = readFileSync(join(REPO, "pipeline", "PROMPTS.md"), "utf8");
  const intake = { company: "Acme Freight", people: [{ name: "Jane Doe", slug: "jane-doe" }], goal: "pitch", modes: ["pitch"], orgType: "other", meetingDate: "2026-12-01", tier: "light", meetings: [], deadlines: [] };
  const waves = stagePlan(md, intake, "acme-freight", {});
  for (const id of ["render", "one-card"]) {
    const p = waves.find((w) => w.wave === id).stages[0].prompt;
    assert.match(p, /npm run form -- acme-freight\s+--check/, id);
    assert.doesNotMatch(p, /Run lint and the build|\bRebuild\b/, id);
  }
  assert.match(waves.find((w) => w.wave === "render").stages[0].prompt, /Do not run the build/);
});
