// Intake: the domain field reaches the OSINT pass; the practice pages are an opt-in pack.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { composeRoom, normDomain, availableOptions } from "../scripts/lib/compose.mjs";
import { lintRoom, TARGETS } from "../scripts/lib/lint.mjs";

const REPO = join(import.meta.dirname, "..");
const SK = join(REPO, "templates", "skeleton");
const compose = (base, opts) => composeRoom({ company: "Acme Freight", people: "Jane Doe", goal: "pitch a contract", orgType: "other", date: "2026-12-01", now: "2026-11-12T10:00:00Z", ...opts }, { skeletonDir: SK, roomsDir: join(base, "rooms"), configDir: join(base, "config") });

test("intake: domain is normalised, written to intake.json and room.json; run-room passes it to osint", () => {
  assert.equal(normDomain("https://www.Acme-Freight.example/about?x=1"), "acme-freight.example");
  assert.equal(normDomain("not a domain"), "");
  const base = mkdtempSync(join(tmpdir(), "intake-"));
  try {
    mkdirSync(join(base, "rooms"));
    const r = compose(base, { domain: "https://acme-freight.example/" });
    assert.equal(r.intake.domain, "acme-freight.example");
    assert.equal(r.room.domain, "acme-freight.example");
    const bad = compose(base, { slug: "acme-2", domain: "nope" });
    assert.equal(bad.intake.domain, null);
    assert.ok(bad.warnings.some((w) => /does not look like a domain/.test(w)));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  const run = readFileSync(join(REPO, "scripts", "run-room.mjs"), "utf8");
  assert.match(run, /intakeEarly\.domain \|\| roomJson\(\)\.domain/);
  assert.match(readFileSync(join(REPO, "templates", "studio.html"), "utf8"), /id="domain"/);
});

test("practice pages are an optional pack, off by default; lint does not demand the old minimums", () => {
  assert.ok(availableOptions(SK).extras.includes("practice"));
  assert.ok(TARGETS.full.glossary <= 40 && TARGETS.full.answers <= 20, "targets cut from 250 / 150");
  const base = mkdtempSync(join(tmpdir(), "practice-"));
  try {
    mkdirSync(join(base, "rooms"));
    const off = compose(base, {});
    const ids = off.room.sections.flatMap((s) => s.pages.map((p) => p.id));
    for (const id of ["answer-bank", "practice-bank", "push-back-gym", "mock-transcripts"]) assert.ok(!ids.includes(id), id);
    assert.ok(ids.includes("glossary"), "the glossary stays in core");
    assert.ok(!off.room.heroes.some((h) => h.page === "practice-bank"), "no hero for a page that is not there");
    assert.equal(off.intake.practice, false);
    const rep = lintRoom(off.dir, { skeletonDir: SK });
    assert.ok(!rep.checks.some((c) => c.name === "answer bank items"), "no answer-bank target without the pack");

    const on = compose(base, { slug: "acme-practice", practice: true });
    const ids2 = on.room.sections.flatMap((s) => s.pages.map((p) => p.id));
    for (const id of ["answer-bank", "practice-bank", "push-back-gym", "mock-transcripts", "glossary"]) assert.ok(ids2.includes(id), id);
    assert.equal(on.room.sections.find((s) => s.id === "drills").group, "role");
    const rep2 = lintRoom(on.dir, { skeletonDir: SK });
    assert.equal(rep2.checks.find((c) => c.name === "answer bank items").target, TARGETS[on.room.tier].answers);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
