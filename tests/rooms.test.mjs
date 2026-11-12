// Composer, markdown and lint tests. Run with: npm test (no dependencies).
// Every room here is composed into a temporary folder from a small fixture skeleton.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slugify, inferModes, inferOrgType, parsePeople, composeRoom, extractSection, fillPrompt, writeRunScript } from "../scripts/lib/compose.mjs";
import { mdToHtml, expandGrades, inline } from "../scripts/lib/markdown.mjs";
import { lintRoom } from "../scripts/lib/lint.mjs";

// ---------------------------------------------------------------- slugs, modes

test("slugify folds case, accents, punctuation and length", () => {
  assert.equal(slugify("Acme Capital"), "acme-capital");
  assert.equal(slugify("  Société Générale, S.A. "), "societe-generale-s-a");
  assert.equal(slugify("Smith & Wesson"), "smith-and-wesson");
  assert.equal(slugify("O’Neil Partners"), "oneil-partners");
  assert.equal(slugify("!!!"), "");
  const long = slugify("The Extremely Long Name Of A Holding Company Incorporated In Delaware");
  assert.ok(long.length <= 41 && /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(long));
});

test("modes are read from the goal text", () => {
  assert.deepEqual(inferModes("final-round interview for the CFO role"), ["interviewing"]);
  assert.deepEqual(inferModes("negotiate a licence"), ["deal"]);
  assert.deepEqual(inferModes("they want to acquire our data business"), ["deal"]);
  assert.deepEqual(inferModes("raise a seed round"), ["deal"]);
  assert.deepEqual(inferModes("diligence on their carbon claims"), ["audit"]);
  assert.deepEqual(inferModes("verify the reserve report"), ["audit"]);
  assert.deepEqual(inferModes("pitch our product and ask them to sponsor the car"), ["pitch"]);
  assert.deepEqual(inferModes("investigate nothing in particular"), ["deal"], "investigate is not invest; falls to the default");
  assert.deepEqual(inferModes(""), ["deal"]);
  assert.deepEqual(inferModes("interview, then negotiate the package"), ["interviewing", "deal"]);
});

test("org type guessed from the name, else other", () => {
  assert.equal(inferOrgType("Acme Capital"), "private-equity");
  assert.equal(inferOrgType("Northshore Health"), "health-system");
  assert.equal(inferOrgType("Ontario Teachers' Pension Plan"), "asset-owner");
  assert.equal(inferOrgType("Blue Fin", "they run solar farms"), "energy");
  assert.equal(inferOrgType("Blue Fin"), "other");
});

test("people split on commas and semicolons", () => {
  assert.deepEqual(parsePeople("Jane Doe, John  Roe; Ann Lee"), ["Jane Doe", "John Roe", "Ann Lee"]);
  assert.deepEqual(parsePeople(["Jane Doe", "A, B"]), ["Jane Doe", "A", "B"]);
  assert.deepEqual(parsePeople(""), []);
});

// ---------------------------------------------------------------- composition

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "rooms-test-"));
  const sk = join(base, "skeleton");
  const w = (p, s) => {
    mkdirSync(join(sk, p, ".."), { recursive: true });
    writeFileSync(join(sk, p), typeof s === "string" ? s : JSON.stringify(s, null, 2));
  };
  w("core/room.json", {
    slug: "__SLUG__",
    title: "__TITLE__",
    subtitle: "Room for __COMPANY__",
    asOf: "__DATE__",
    accent: "#0f3d5a",
    counterparty: "__COMPANY__",
    people: [],
    modes: [],
    orgType: "",
    ourSide: "",
    notice: "",
    footer: "Built for __COMPANY__.",
    heroes: [
      { page: "one-card", title: "The one card", text: "Last read." },
      { page: "persona-__PERSON_SLUG__", title: "Persona: __PERSON__", text: "Drill." },
    ],
    process: [{ status: "next", title: "Meeting", detail: "with __PERSON__" }],
    sections: [
      { id: "start", title: "Start here", pages: [{ id: "one-card", title: "The one card", blurb: "For __COMPANY__." }] },
      { id: "people", title: "The people", pages: [{ id: "people-map", title: "People map", blurb: "Who decides." }] },
      { id: "person", title: "__PERSON__", perPerson: true, pages: [{ id: "persona-__PERSON_SLUG__", title: "Persona: __PERSON__", blurb: "__PERSON__ at __COMPANY__." }] },
      { id: "ask", title: "The ask", pages: [{ id: "duty-map", title: "Duty map", blurb: "" }] },
      { id: "record", title: "The record", pages: [{ id: "sent", title: "As sent", blurb: "[FILL: what was sent]" }] },
    ],
  });
  w("core/pages/duty-map.html", "<h2>Duties</h2>\n");
  w("core/pages/sent.html", "<h2>Sent</h2>\n");
  w("core/pages/one-card.html", "<h2>The line</h2><p>__COMPANY__ on __DATE__.</p>\n");
  w("core/pages/people-map.md", "## Map\n\n- __COMPANY__ decides {i}\n");
  w("core/person/persona-__PERSON_SLUG__.html", "<h2>1. Identity</h2><p>__PERSON__ (__PERSON_SLUG__) at __COMPANY__.</p>\n");
  w("modes/deal/pack.json", {
    sections: [
      { id: "terms", title: "Terms", note: "The deal.", brief: { level: "first pass", bullets: ["Price is set by the comps"], hold: "No exclusivity" }, pages: [{ id: "term-sheet", title: "Term sheet", blurb: "Clauses." }] },
      { id: "start", title: "ignored", pages: [{ id: "deal-card", title: "Deal card", blurb: "Numbers." }] },
    ],
  });
  w("modes/deal/pages/term-sheet.html", "<h2>Clauses</h2><p></p>\n");
  w("modes/deal/pages/deal-card.html", "<h2>Numbers</h2><p></p>\n");
  w("modes/audit/pack.json", { sections: [{ id: "checks", title: "Checks", pages: [{ id: "claims", title: "Claims to check", blurb: "" }, { id: "nofile", title: "No file yet", blurb: "" }] }] });
  w("modes/audit/pages/claims.html", "<h2>Claims</h2>\n");
  w("orgtypes/private-equity/pack.json", { sections: [{ id: "money", title: "The fund", pages: [{ id: "fund", title: "Fund __COMPANY__", blurb: "" }] }] });
  w("orgtypes/private-equity/pages/fund.html", "<h2>Fund</h2><p>__COMPANY__</p>\n");
  w("orgtypes/other/pack.json", { sections: [] });
  const rooms = join(base, "rooms");
  mkdirSync(rooms);
  return { base, sk, rooms, paths: { skeletonDir: sk, roomsDir: rooms, configDir: join(base, "config") } };
}

test("compose: core + modes + org type, per-person pages repeated, tokens filled", () => {
  const fx = fixture();
  try {
    const r = composeRoom(
      { company: "Acme & Sons Capital", people: ["Jane Doe", "John Roe, Jane Doe"], goal: "negotiate a licence", modes: ["deal", "audit"], orgType: "private-equity", date: "2026-12-01", now: "2026-11-12T10:00:00Z" },
      fx.paths,
    );
    assert.equal(r.slug, "acme-and-sons-capital");
    const dir = join(fx.rooms, r.slug);
    const room = JSON.parse(readFileSync(join(dir, "room.json"), "utf8"));
    assert.equal(room.title, "Acme & Sons Capital");
    assert.equal(room.counterparty, "Acme & Sons Capital");
    assert.equal(room.asOf, "2026-11-12");
    assert.deepEqual(room.modes, ["deal", "audit"]);
    assert.equal(room.orgType, "private-equity");
    assert.deepEqual(room.people.map((p) => p.slug), ["jane-doe", "john-roe", "jane-doe-2"]);

    const ids = room.sections.flatMap((s) => s.pages.map((p) => p.id));
    assert.deepEqual(ids, ["one-card", "deal-card", "people-map", "persona-jane-doe", "persona-john-roe", "persona-jane-doe-2", "duty-map", "term-sheet", "claims", "nofile", "fund", "sent"]);
    assert.deepEqual(room.sections.map((s) => s.id), ["start", "people", "person-jane-doe", "person-john-roe", "person-jane-doe-2", "ask", "terms", "checks", "money", "record"], "one section per person; packs right after ask");
    const john = room.sections.find((s) => s.id === "person-john-roe");
    assert.equal(john.title, "John Roe");
    assert.equal(john.person, "john-roe");
    assert.equal(john.pages[0].title, "Persona: John Roe");
    assert.equal(room.sections.find((s) => s.id === "terms").brief.hold, "No exclusivity");
    assert.equal(room.sections.find((s) => s.id === "money").pages[0].title, "Fund Acme & Sons Capital");
    assert.deepEqual(room.heroes.map((h) => h.page), ["one-card", "persona-jane-doe", "persona-john-roe", "persona-jane-doe-2"]);
    assert.ok(!JSON.stringify(room).includes("__"), "no tokens left in room.json");

    const persona = readFileSync(join(dir, "pages", "persona-john-roe.html"), "utf8");
    assert.equal(persona, "<h2>1. Identity</h2><p>John Roe (john-roe) at Acme &amp; Sons Capital.</p>\n");
    assert.ok(existsSync(join(dir, "pages", "people-map.md")), "markdown pages keep their extension");
    assert.match(readFileSync(join(dir, "pages", "nofile.html"), "utf8"), /No skeleton page/);
    assert.ok(r.warnings.some((w) => w.includes("nofile")));

    const intake = JSON.parse(readFileSync(join(dir, "intake.json"), "utf8"));
    assert.equal(intake.company, "Acme & Sons Capital");
    assert.equal(intake.goal, "negotiate a licence");
    assert.equal(intake.meetingDate, "2026-12-01");
    assert.equal(intake.createdAt, "2026-11-12T10:00:00.000Z");
    assert.equal(intake.people.length, 3);
    assert.equal(intake.modesInferred, false);

    assert.throws(() => composeRoom({ company: "Acme & Sons Capital", people: ["X"] }, fx.paths), /already exists/);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("compose: mode inferred from the goal, org auto, bad input refused", () => {
  const fx = fixture();
  try {
    const r = composeRoom({ company: "Blue Fin", people: "Ann Lee", goal: "verify their claims" }, fx.paths);
    assert.deepEqual(r.intake.modes, ["audit"]);
    assert.equal(r.intake.modesInferred, true);
    assert.equal(r.intake.orgType, "other");
    assert.throws(() => composeRoom({ company: "" }, fx.paths), /company is required/);
    assert.throws(() => composeRoom({ company: "Z", modes: ["dance"] }, fx.paths), /unknown mode/);
    assert.throws(() => composeRoom({ company: "Z", orgType: "bank" }, fx.paths), /unknown org type/);
    assert.throws(() => composeRoom({ company: "Z", date: "1 Dec" }, fx.paths), /YYYY-MM-DD/);
    assert.ok(!existsSync(join(fx.rooms, "z")), "nothing written on a refused intake");
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("compose: the flat skeleton still works, persona repeated per person", () => {
  const base = mkdtempSync(join(tmpdir(), "rooms-flat-"));
  try {
    const sk = join(base, "sk");
    mkdirSync(join(sk, "pages"), { recursive: true });
    writeFileSync(join(sk, "room.json"), JSON.stringify({ slug: "__SLUG__", title: "__TITLE__", asOf: "__DATE__", heroes: [{ page: "persona", title: "Persona" }], sections: [{ id: "people", title: "People", pages: [{ id: "persona", title: "Persona", blurb: "" }] }] }));
    writeFileSync(join(sk, "pages", "persona.html"), "<h2>Identity</h2>\n");
    mkdirSync(join(base, "rooms"));
    const r = composeRoom({ company: "Flat Co", people: "A One, B Two" }, { skeletonDir: sk, roomsDir: join(base, "rooms"), configDir: join(base, "c") });
    assert.deepEqual(r.room.sections[0].pages.map((p) => p.id), ["persona-a-one", "persona-b-two"]);
    assert.deepEqual(r.room.heroes.map((h) => h.page), ["persona-a-one", "persona-b-two"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("pipeline: P0 extracted from PROMPTS.md, filled, RUN.sh written executable", () => {
  const md = "# Prompts\n\n## P0 Orchestrator\n\nBuild {{company}} for {{people}}: {{goal}} ({{modes}}).\n\n### detail\nkeep\n\n## P1 Research\n\nnot this\n";
  const p0 = extractSection(md, "P0");
  assert.match(p0, /^Build \{\{company\}\}/);
  assert.match(p0, /keep/);
  assert.doesNotMatch(p0, /not this/);
  const intake = { company: "Acme", people: [{ name: "Jane" }], goal: "a deal", modes: ["deal"], orgType: "other", meetingDate: null, tier: "full" };
  assert.equal(fillPrompt("{{company}}/{{ people }}/__GOAL__/{{unknown}}", intake, "acme"), "Acme/Jane/a deal/{{unknown}}");

  const base = mkdtempSync(join(tmpdir(), "rooms-run-"));
  try {
    mkdirSync(join(base, "pipeline"));
    writeFileSync(join(base, "pipeline", "PROMPTS.md"), md);
    mkdirSync(join(base, "rooms", "acme"), { recursive: true });
    const run = writeRunScript("acme", intake, { repo: base });
    assert.equal(run.command, 'claude -p "$(cat rooms/acme/work/P0.md)" --model opus');
    const sh = readFileSync(join(base, "rooms", "acme", "RUN.sh"), "utf8");
    assert.ok(sh.startsWith("#!/usr/bin/env bash") && sh.includes(run.command));
    assert.ok(statSync(join(base, "rooms", "acme", "RUN.sh")).mode & 0o100, "RUN.sh is executable");
    const prompt = readFileSync(join(base, "rooms", "acme", "work", "P0.md"), "utf8");
    assert.match(prompt, /^Build Acme for Jane: a deal \(deal\)\./);
    assert.match(prompt, /"company": "Acme"/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- markdown

test("markdown: headings, paragraphs, lists, links, code", () => {
  const html = mdToHtml("# Title\n\n## Who they are\n\nOne line\nsecond line with **bold** and *it* and `a<b>`.\n\n- one\n- two [source](https://ex.example/a?b=1&c=2)\n  - nested\n\n1. first\n2. second\n\n```js\nif (a < b) {v}\n```\n");
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<h2>Who they are<\/h2>/);
  assert.match(html, /<p>One line\nsecond line with <strong>bold<\/strong> and <em>it<\/em> and <code>a&lt;b&gt;<\/code>\.<\/p>/);
  assert.match(html, /<ul>\n<li>one<\/li>\n<li>two <a class="src" href="https:\/\/ex.example\/a\?b=1&amp;c=2">source<\/a>\n<ul>\n<li>nested<\/li>\n<\/ul><\/li>\n<\/ul>/);
  assert.match(html, /<ol>\n<li>first<\/li>\n<li>second<\/li>\n<\/ol>/);
  assert.match(html, /<pre><code class="language-js">if \(a &lt; b\) \{v\}<\/code><\/pre>/, "no grade expansion inside code");
});

test("markdown: tables, blockquotes, relative links, raw HTML, unsafe links", () => {
  const html = mdToHtml("| Term | Meaning |\n|---|:-:|\n| ARR | annual {v} |\n| A \\| B | x |\n\n> Quoted *line*\n> second\n\nSee [glossary](glossary.html) and [x](javascript:alert(1)).\n\n<div class=\"note\">raw</div>\n\nAT&T 3 < 4 & 5 > 2\n");
  assert.match(html, /<table>\n<thead><tr><th>Term<\/th><th style="text-align:center">Meaning<\/th><\/tr><\/thead>/);
  assert.match(html, /<td>ARR<\/td><td style="text-align:center">annual <span class="grade verified">Verified<\/span><\/td>/);
  assert.match(html, /<td>A \| B<\/td>/);
  assert.match(html, /<blockquote>\n<p>Quoted <em>line<\/em>\nsecond<\/p>\n<\/blockquote>/);
  assert.match(html, /<a href="glossary.html">glossary<\/a>/, "relative links are not source chips");
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /<div class="note">raw<\/div>/);
  assert.match(html, /<p>AT&amp;T 3 &lt; 4 &amp; 5 &gt; 2<\/p>/);
  assert.equal(inline("&amp; stays"), "&amp; stays");
});

test("grade shorthands expand in HTML, not inside code", () => {
  assert.equal(
    expandGrades("<p>A {v} B {p} C {i} D {np} E {u} {x}</p><code>{v}</code>"),
    '<p>A <span class="grade verified">Verified</span> B <span class="grade partly">Partly verified</span> C <span class="grade inference">Inference</span> D <span class="grade not-public">Not public</span> E <span class="grade unknown">Unknown</span> {x}</p><code>{v}</code>',
  );
});

// ---------------------------------------------------------------- lint

test("lint: skeleton pages, sources, grades, ANTHONY items, h2 rules, tier", () => {
  const fx = fixture();
  try {
    const r = composeRoom({ company: "Lint Co", people: "Ann Lee", modes: ["deal"], orgType: "other" }, fx.paths);
    const dir = join(fx.rooms, r.slug);
    writeFileSync(join(dir, "pages", "one-card.md"), "ignored: the .html wins\n");
    writeFileSync(
      join(dir, "pages", "term-sheet.html"),
      '<h2>Clauses</h2><p>Price {v} <a class="src" href="https://a.example">a</a> {p} {i} {u}</p><h2 class="x">Bad</h2><h2>This heading is far longer than forty characters in total</h2><p>[ANTHONY: confirm the floor price]</p>',
    );
    writeFileSync(join(dir, "pages", "sent.html"), "<!-- example: {v} <a class=\"src\" href=\"x\">x</a> [FILL: in a comment] -->\n<p>[FILL: date it was sent]</p>\n");
    const rep = lintRoom(dir, { pageTemplate: '<p class="meta">As of</p>' });
    assert.equal(rep.tier, "full");
    assert.equal(rep.pages, 7);
    assert.ok(rep.skeleton.includes("one-card") && !rep.skeleton.includes("term-sheet"));
    assert.ok(!rep.noSource.includes("term-sheet") && rep.noSource.includes("one-card"));
    assert.deepEqual([rep.grades.verified, rep.grades.partly, rep.grades.inference, rep.grades.unknown], [1, 1, 2, 1], "people-map.md carries one {i} from the skeleton");
    assert.equal(rep.gradedShare, 0.4);
    assert.deepEqual(rep.anthony, [
      { page: "term-sheet", kind: "ANTHONY", text: "confirm the floor price" },
      { page: "sent", kind: "FILL", text: "date it was sent" },
    ], "both markers; nothing counted from inside comments");
    assert.ok(rep.noSource.includes("sent"), "a.src inside a comment does not count");
    assert.equal(rep.h2.length, 2);
    assert.equal(rep.noMeta.length, 0);
    assert.equal(rep.ok, false);
    assert.ok(rep.score > 0 && rep.score < 100);
    assert.equal(lintRoom(dir, { pageTemplate: "" }).noMeta.length, 7);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- v1.1: grades weak and none

import { PERSON_PAGES, RENAMED_PAGES, normaliseSchedule, scheduleText, REPO, GROUPS, groupOf, partOf } from "../scripts/lib/compose.mjs";
import { ungradedChecklistRows, GRADES, personaGaps } from "../scripts/lib/lint.mjs";
import { hideNoneRows, isPersonPage } from "../scripts/lib/pages.mjs";
import { nextMeeting, upcomingDeadlines, scheduleHtml, processBlock, summaryHtml, dayWords, countdownWords } from "../scripts/lib/schedule.mjs";

test("grades: seven labels, {w} and {n} expand, {np} still wins over {n}", () => {
  assert.deepEqual(GRADES, ["verified", "partly", "weak", "inference", "none", "not-public", "unknown"]);
  assert.equal(expandGrades("a {w} b {n} c {np}"), 'a <span class="grade weak">Weak</span> b <span class="grade none">None found</span> c <span class="grade not-public">Not public</span>');
  assert.match(mdToHtml("| Item | Grade |\n|---|---|\n| Dean's list | None found {n} |\n"), /<td>None found <span class="grade none">None found<\/span><\/td>/);
  assert.equal(expandGrades("<code>{w}{n}</code>"), "<code>{w}{n}</code>");
  const css = readFileSync(join(REPO, "templates", "room.css"), "utf8");
  assert.match(css, /\.grade\.weak\s*\{/);
  assert.match(css, /\.grade\.none\s*\{/);
  const build = readFileSync(join(REPO, "scripts", "lib", "render.mjs"), "utf8");
  assert.match(build, /\["weak", "Weak"\]/);
  assert.match(build, /\["none", "None found"\]/);
});

test("lint: weak and none counted, none left out of the share, ungraded checklist rows flagged", () => {
  assert.deepEqual(
    ungradedChecklistRows('<table class="checklist"><tr><th>Item</th></tr><tr class="ck"><td>LinkedIn</td><td>x</td><td>{v}</td></tr><tr class="ck"><td>TikTok</td><td></td><td></td></tr><tr class="ck"><td>X</td><td>None found</td><td><span class="grade none">None found</span></td></tr></table>'),
    ["LinkedIn", "TikTok"],
    "shorthands must be expanded before the check; a raw {v} does not count",
  );
  const fx = fixture();
  try {
    const r = composeRoom({ company: "Grade Co", people: "Ann Lee", modes: ["deal"], orgType: "other" }, fx.paths);
    const dir = join(fx.rooms, r.slug);
    writeFileSync(
      join(dir, "pages", "term-sheet.html"),
      '<p>Read: filings.</p><h2>Rows</h2><table class="checklist"><tr class="ck"><td>Revenue</td><td>$4m {v} <a class="src" href="https://a.example">a</a></td></tr><tr class="ck"><td>Debt</td><td>one blog {w}</td></tr><tr class="ck"><td>Credit</td><td>None found {n} (searched UCC, state)</td></tr><tr class="ck"><td>Ownership</td><td></td></tr></table>',
    );
    const rep = lintRoom(dir, { pageTemplate: '<p class="meta">As of</p>' });
    assert.equal(rep.grades.weak, 1);
    assert.equal(rep.grades.none, 1);
    // verified 1 of (1 verified + 1 weak + 1 inference from people-map.md); none is not in the denominator
    assert.equal(Math.round(rep.gradedShare * 100), 33);
    assert.deepEqual(rep.checklist, [{ page: "term-sheet", row: "Ownership" }]);
    assert.ok(rep.checks.some((c) => c.name === "checklist rows with no grade" && !c.ok));
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- v1.1: per-person pages (footprint -> socials)

test("person pages: fourteen, in order, footprint renamed to socials, every one a checklist", () => {
  assert.deepEqual(PERSON_PAGES, ["persona", "interests", "socials", "partner-socials", "linkedin", "education", "writing", "names", "own-words", "network", "public-record", "financials", "timeline", "relate"]);
  assert.equal(RENAMED_PAGES.footprint, "socials");
  const personDir = join(REPO, "templates", "skeleton", "core", "person");
  assert.ok(!existsSync(join(personDir, "footprint.html")), "footprint.html is gone");
  for (const id of PERSON_PAGES) {
    const html = readFileSync(join(personDir, id + ".html"), "utf8");
    assert.match(html, /<table class="checklist">/, `${id} has a checklist table`);
    assert.match(html, /<tr class="ck">/, `${id} has checklist rows`);
    assert.match(html, /grade weak/, `${id} lists the weak grade`);
  }
  const room = JSON.parse(readFileSync(join(REPO, "templates", "skeleton", "core", "room.json"), "utf8"));
  const person = room.sections.find((s) => s.id === "person");
  assert.deepEqual(person.pages.map((p) => p.id.replace("-__PERSON_SLUG__", "")), PERSON_PAGES);
  assert.ok(!JSON.stringify(room).includes("footprint-__PERSON_SLUG__"));
  assert.ok(room.sections.some((s) => s.pages.some((p) => p.id === "companion")), "the companion page is core");
  assert.deepEqual([room.summary, room.meetings, room.deadlines], ["", [], []]);
  const fin = readFileSync(join(REPO, "templates", "skeleton", "core", "pages", "public-financials.html"), "utf8");
  for (const row of ["Revenue", "Funding", "Assets", "Debt", "Filings", "Credit", "Ownership"]) assert.match(fin, new RegExp(`<tr class="ck"><td>${row}`), `company checklist row ${row}`);
});

test("compose with the real skeleton: two people, fourteen pages each, no footprint ids", () => {
  const base = mkdtempSync(join(tmpdir(), "rooms-real-"));
  try {
    mkdirSync(join(base, "rooms"));
    const r = composeRoom(
      { company: "Harbor Point Capital", people: "Jane Doe, John Roe", goal: "negotiate a licence", date: "2026-12-01", now: "2026-11-12T10:00:00Z" },
      { skeletonDir: join(REPO, "templates", "skeleton"), roomsDir: join(base, "rooms"), configDir: join(base, "config") },
    );
    for (const slug of ["jane-doe", "john-roe"]) {
      const sec = r.room.sections.find((s) => s.person === slug);
      assert.deepEqual(sec.pages.map((p) => p.id), PERSON_PAGES.map((id) => `${id}-${slug}`));
      for (const id of PERSON_PAGES) assert.ok(existsSync(join(r.dir, "pages", `${id}-${slug}.html`)), `${id}-${slug}.html written`);
    }
    assert.ok(!readdirSync(join(r.dir, "pages")).some((f) => f.startsWith("footprint")));
    assert.ok(!r.warnings.some((w) => /No skeleton page|no skeleton page/.test(w)), r.warnings.join("; "));
    assert.match(readFileSync(join(r.dir, "pages", "socials-jane-doe.html"), "utf8"), /Every platform checked for Jane Doe/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("compose: a room.json that still names footprint-<person> gets the socials page", () => {
  const fx = fixture();
  try {
    const rj = JSON.parse(readFileSync(join(fx.sk, "core", "room.json"), "utf8"));
    rj.sections.find((s) => s.id === "person").pages.push({ id: "footprint-__PERSON_SLUG__", title: "Footprint: __PERSON__", blurb: "" });
    writeFileSync(join(fx.sk, "core", "room.json"), JSON.stringify(rj));
    writeFileSync(join(fx.sk, "core", "person", "socials.html"), "<h2>Accounts</h2><p>__PERSON__</p>\n");
    const r = composeRoom({ company: "Old Co", people: "Ann Lee" }, fx.paths);
    assert.equal(readFileSync(join(r.dir, "pages", "footprint-ann-lee.html"), "utf8"), "<h2>Accounts</h2><p>Ann Lee</p>\n");
    assert.ok(!r.warnings.some((w) => w.includes("footprint")));
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- v1.1: meetings and deadlines

test("compose: meetings and deadlines saved, sorted and checked, in room.json and intake.json", () => {
  const fx = fixture();
  try {
    const r = composeRoom(
      {
        company: "Sched Co",
        people: "Ann Lee",
        goal: "negotiate a licence",
        date: "2026-12-01",
        meetings: [{ date: "2026-12-08", time: "14:00", title: "Round 2", who: "Ann Lee", format: "video", length: "60 min" }, { date: "", time: "", title: "" }],
        deadlines: [{ date: "2026-11-30", title: "Send the deck", kind: "Submission" }, { date: "2026-11-20", title: "NDA back", kind: "weird", done: true }],
        now: "2026-11-12T10:00:00Z",
      },
      fx.paths,
    );
    const room = JSON.parse(readFileSync(join(r.dir, "room.json"), "utf8"));
    assert.deepEqual(room.meetings, [
      { date: "2026-12-01", time: "", title: "Meeting 1", who: "", format: "", length: "" },
      { date: "2026-12-08", time: "14:00", title: "Round 2", who: "Ann Lee", format: "video", length: "60 min" },
    ], "the meeting date becomes meeting 1; empty rows dropped");
    assert.deepEqual(room.deadlines, [
      { date: "2026-11-20", title: "NDA back", kind: "other", done: true },
      { date: "2026-11-30", title: "Send the deck", kind: "submission", done: false },
    ]);
    assert.equal(room.meetingDate, "2026-12-01");
    assert.equal(room.summary, "");
    const intake = JSON.parse(readFileSync(join(r.dir, "intake.json"), "utf8"));
    assert.deepEqual(intake.meetings, room.meetings);
    assert.deepEqual(intake.deadlines, room.deadlines);
    assert.equal(scheduleText(intake.deadlines, "deadlines"), "2026-11-20 · NDA back · other · done; 2026-11-30 · Send the deck · submission");
    assert.equal(fillPrompt("{{meetings}} | {{deadlines}}", { ...intake, people: [{ name: "Ann" }], modes: ["deal"] }, "s").split(" | ")[0], "2026-12-01 · Meeting 1; 2026-12-08 14:00 · Round 2 · Ann Lee · video · 60 min");
    assert.match(fillPrompt("{{deadlines}}", { company: "x", people: [], goal: "", modes: [], deadlines: [] }, "s"), /none given \(ask for the deadlines\)/);

    // no date given: the meeting date is the next meeting from today
    const r2 = composeRoom({ company: "Next Co", meetings: [{ date: "2026-11-01" }, { date: "2026-12-03", time: "09:00" }], now: "2026-11-12T10:00:00Z" }, fx.paths);
    assert.equal(r2.intake.meetingDate, "2026-12-03");
    assert.deepEqual(r2.intake.meetings.map((m) => m.title), ["Meeting 1", "Meeting 2"]);

    assert.throws(() => normaliseSchedule([{ date: "Dec 1", title: "x" }]), /meeting 1: date "Dec 1" must be YYYY-MM-DD/);
    assert.throws(() => normaliseSchedule([{ date: "2026-12-01", time: "2pm" }]), /HH:MM/);
    assert.throws(() => normaliseSchedule([], [{ title: "no date" }]), /deadline 1/);
    assert.throws(() => composeRoom({ company: "Bad Sched", deadlines: [{ title: "x", date: "soon" }] }, fx.paths), /deadline 1/);
    assert.ok(!existsSync(join(fx.rooms, "bad-sched")));
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("schedule: next meeting, open deadlines, countdown and summary on the index, tables on the process page", () => {
  const now = new Date(2026, 10, 12, 10, 0); // 12 Nov 2026, 10:00 local
  const meetings = [{ date: "2026-11-12", time: "09:00", title: "Screen" }, { date: "2026-11-14", time: "15:30", title: "Round <2>", who: "Ann", format: "video", length: "60 min" }];
  const deadlines = [{ date: "2026-11-11", title: "Late one", kind: "document", done: false }, { date: "2026-11-13", title: "Deck", kind: "submission" }, { date: "2026-11-12", title: "Done", kind: "prep", done: true }];
  assert.equal(nextMeeting(meetings, now).title, "Round <2>", "a meeting that already started is past");
  assert.equal(nextMeeting([{ date: "2026-11-12", title: "All day" }], now).title, "All day", "no time: counts until the end of the day");
  assert.equal(nextMeeting([{ date: "2026-11-01" }], now), null);
  assert.deepEqual(upcomingDeadlines(deadlines, now).map((d) => [d.title, d.days]), [["Late one", -1], ["Deck", 1]]);
  assert.equal(dayWords(0), "today");
  assert.equal(dayWords(5), "in 5 days");
  assert.equal(dayWords(-3), "3 days late");
  assert.equal(countdownWords((2 * 24 + 5) * 3600000 + 30 * 60000), "2 d 5 h");
  assert.equal(countdownWords(90 * 60000), "1 h 30 min");

  const html = scheduleHtml({ meetings, deadlines }, now);
  assert.match(html, /Round &lt;2&gt;/, "escaped");
  assert.match(html, /data-at="2026-11-14T15:30"/);
  assert.match(html, />2 d 5 h</);
  assert.match(html, /<li class="late"><b>Late one<\/b>/);
  assert.match(html, /<li class="soon"><b>Deck<\/b>/);
  assert.doesNotMatch(html, /Done/);
  assert.match(scheduleHtml({ meetings: [], deadlines: [{ date: "2026-12-01", title: "x" }] }, now), /Not set/);
  assert.equal(scheduleHtml({}, now), "");
  assert.equal(summaryHtml({ summary: "" }), "");
  assert.match(summaryHtml({ summary: "Who & what" }), /<p>Who &amp; what<\/p>/);
  const pb = processBlock({ meetings, deadlines });
  assert.match(pb, /<h2>Meetings<\/h2>/);
  assert.match(pb, /<td>2026-11-14<\/td><td>15:30<\/td><td>Round &lt;2&gt;<\/td>/);
  assert.match(pb, /<td>Done<\/td><td>prep<\/td><td>done<\/td>/);
  const index = readFileSync(join(REPO, "templates", "index.html"), "utf8");
  assert.ok(index.indexOf("{{summary}}") > -1 && index.indexOf("{{summary}}") < index.indexOf("{{sections}}"), "summary sits at the top of the index");
  assert.ok(index.indexOf("{{schedule}}") > -1 && index.indexOf("{{schedule}}") < index.indexOf("{{sections}}"), "the meeting card sits above the chapters");
});

// ---------------------------------------------------------------- v1.1: the companion

test("companion: two lanes wired, gated paths, consent before recording, models from env", () => {
  const fn = (f) => readFileSync(join(REPO, "netlify", "functions", f), "utf8");
  assert.match(fn("assist-suggest.ts"), /path: "\/:room\/api\/suggest"/);
  assert.match(fn("assist-deep.ts"), /path: "\/:room\/api\/deep"/);
  assert.match(fn("assist-transcribe.ts"), /path: "\/:room\/api\/transcribe"/);
  const shared = fn("_assist.ts");
  assert.match(shared, /ASSIST_FAST_MODEL \|\| "claude-opus-5-5"/);
  assert.match(shared, /ASSIST_DEEP_MODEL \|\| "claude-fable-5-2"/);
  assert.match(shared, /cache_control: \{ type: "ephemeral" \}/);
  const env = readFileSync(join(REPO, ".env.example"), "utf8");
  assert.match(env, /^ASSIST_FAST_MODEL=claude-opus-5-5$/m);
  assert.match(env, /^ASSIST_DEEP_MODEL=claude-fable-5-2$/m);
  const page = readFileSync(join(REPO, "templates", "assist.html"), "utf8");
  for (const s of ['id="consent"', 'id="think"', 'id="optTick"', 'id="feed"', "api/steer", "api/know", 'id="export"', "api/deep", "api/suggest", "api/transcribe", "localStorage"]) assert.ok(page.includes(s), s);
  assert.ok(page.indexOf("await askConsent()") < page.indexOf("getUserMedia"), "consent is asked before the microphone opens");
  assert.doesNotMatch(page, /\.innerHTML\s*=/, "model output never goes in as HTML");
});

// ---------------------------------------------------------------- personal life, verdict, drivers, their circles

test("personal life page is findings only, its checklist in the brief; persona verdict and drivers; their circles; no our-side interests[]", () => {
  const sk = join(REPO, "templates", "skeleton", "core");
  const interests = readFileSync(join(sk, "person", "interests.html"), "utf8");
  const brief = (interests.match(/<!--[\s\S]*?-->/) || [""])[0];
  for (const r of ["Sports played", "Sports followed", "Outdoor", "Cars and machines", "Food and drink", "Travel", "Music, books and podcasts", "Causes and charities", "Faith or community groups (only if public)", "Collecting and hobbies", "Family rhythm (no children named)", "Clubs", "How they spend weekends", "Home and places", "Family (married, number of children", "Upbringing and life events"])
    assert.ok(brief.includes(r), `checklist row in the brief: ${r}`);
  assert.match(brief, /OSINT log Checks table/);
  assert.match(brief, /Never write a "None found" row on this page/);
  assert.match(interests, /<th>Evidence<\/th><th>Signal<\/th><th>Grade<\/th>/);
  assert.match(interests, /<h2>Findings<\/h2>/);
  assert.match(interests, /<h2>Photos<\/h2>[\s\S]*<figure class="photo">/);
  assert.match(interests, /Built COLD/);
  assert.doesNotMatch(interests.replace(/<!--[\s\S]*?-->/g, ""), /<td>Sports played<\/td>/, "the reader sees no checklist rows");
  const room = JSON.parse(readFileSync(join(sk, "room.json"), "utf8"));
  const pages = room.sections.find((s) => s.id === "person").pages;
  assert.equal(pages.find((p) => p.id === "interests-__PERSON_SLUG__").title, "Personal life and interests: __PERSON__");
  assert.equal(pages.find((p) => p.id === "relate-__PERSON_SLUG__").title, "Their circles: __PERSON__");

  const persona = readFileSync(join(sk, "person", "persona.html"), "utf8");
  const top = persona.replace(/<!--[\s\S]*?-->/g, "");
  assert.ok(top.indexOf("<h2>Verdict</h2>") < top.indexOf("<h2>Inputs checked</h2>"), "verdict at the top");
  assert.match(persona, /<div class="verdict" data-verdict="">/);
  assert.match(persona, /Proven \/ Mixed \/ Unproven/);
  assert.match(persona, /<h2>Claims against the record<\/h2>[\s\S]*<th>Claim<\/th><th>What the record shows<\/th><th>Source<\/th><th>Grade<\/th>/);
  assert.match(persona, /<h2>What drives them<\/h2>/);
  for (const d of ["Financial", "Social", "Commercial", "Technical"]) assert.match(persona, new RegExp(`<tr class="ck"><td>${d}</td>`), d);
  assert.match(persona, /<figure class="photo headshot">/);
  assert.match(persona, /<h2>How they think and behave<\/h2>/);
  for (const r of ["Decision style", "Risk appetite", "Pace", "What earns their trust", "What irritates them", "How they treat juniors and service staff", "Written habits", "Spoken habits"]) assert.match(persona, new RegExp(`<tr class="ck"><td>${r}</td>`), r);
  const who = readFileSync(join(sk, "pages", "who-they-are.html"), "utf8");
  assert.match(who, /<h2>What drives the company<\/h2>/);
  for (const d of ["Financial", "Social", "Commercial", "Technical"]) assert.match(who, new RegExp(`<tr class="ck"><td>${d}</td>`), `company ${d}`);

  const relate = readFileSync(join(sk, "person", "relate.html"), "utf8");
  for (const h of ["Where they spend time", "They will test for", "Never raise", "Traps"]) assert.match(relate, new RegExp(`<h2>${h}</h2>`), h);
  for (const gone of [/Our interest/, /Opener/, /<h2>Overlaps<\/h2>/, /<h2>Interest overlap<\/h2>/, /Do we share it/]) assert.doesNotMatch(relate, gone);
  assert.match(relate, /never match anything here to our side/);
  for (const f of ["interests", "persona", "relate"])
    for (const m of readFileSync(join(sk, "person", f + ".html"), "utf8").matchAll(/<h2>([^<]*)<\/h2>/g)) assert.ok(m[1].length <= 40, `${f}: ${m[1]}`);
  assert.match(readFileSync(join(sk, "pages", "mirror-footprint.html"), "utf8"), /<h2>Our interests, as they will find them<\/h2>/);
  assert.match(readFileSync(join(sk, "pages", "osint-log.html"), "utf8"), /<h2>Checks per person<\/h2>/);
  const ours = JSON.parse(readFileSync(join(REPO, "config", "our-side.example.json"), "utf8"));
  assert.ok(!("interests" in ours), "our side's interests are no longer matched");
  const std = readFileSync(join(REPO, "pipeline", "STANDARD.md"), "utf8");
  assert.match(std, /14 pages\)/);
  assert.match(std, /at least 8 personal life rows checked/);
  assert.match(std, /Proven \/ Mixed \/ Unproven/);
  const prompts = readFileSync(join(REPO, "pipeline", "PROMPTS.md"), "utf8");
  assert.match(prompts, /PERSONAL LIFE AND INTERESTS/);
  assert.match(prompts, /VERDICT/);
  assert.match(prompts, /Never match anything about the people to our side/);
  assert.doesNotMatch(prompts, /small-talk plan, with sight of our side/);
});

test("lint: personal life rows are counted from the OSINT log plus page findings; rooms without one are not judged on it", () => {
  const base = mkdtempSync(join(tmpdir(), "rooms-int-"));
  try {
    mkdirSync(join(base, "rooms"));
    const r = composeRoom(
      { company: "Harbor Point Capital", people: "Jane Doe, John Roe", goal: "pitch", date: "2026-12-01", now: "2026-11-12T10:00:00Z" },
      { skeletonDir: join(REPO, "templates", "skeleton"), roomsDir: join(base, "rooms"), configDir: join(base, "config") },
    );
    // the page shows findings only: Jane has 2, John has 1
    const find = (n) => `<tr class="ck"><td>Area ${n}</td><td>x</td><td>e</td><td>Strong</td><td><span class="grade verified">Verified</span></td><td><a class="src" href="https://a.example">a</a></td></tr>`;
    writeFileSync(join(r.dir, "pages", "interests-jane-doe.html"), `<table class="checklist">${find(1)}${find(2)}</table>`);
    writeFileSync(join(r.dir, "pages", "interests-john-roe.html"), `<table class="checklist">${find(1)}</table>`);
    // the log holds every check, including those that found nothing (Area 1 repeats a page finding)
    const log = (page, n, g) => `<tr class="ck" data-page="${page}"><td>P</td><td>${page}</td><td>Area ${n}</td><td><span class="grade ${g}">x</span></td><td>q</td></tr>`;
    const rows = [...Array.from({ length: 7 }, (_, i) => log("interests-jane-doe", i + 1, i < 2 ? "verified" : "none")), log("interests-john-roe", 3, "none"), log("interests-john-roe", 4, "none")];
    writeFileSync(join(r.dir, "pages", "osint-log.html"), `<h2>Checks per person</h2><table class="checklist checks">${rows.join("")}</table>`);
    const rep = lintRoom(r.dir, { pageTemplate: '<p class="meta">As of</p>' });
    assert.deepEqual(rep.interests.map((x) => [x.page, x.rows]), [["interests-jane-doe", 7], ["interests-john-roe", 3]], "union of page findings and log checks, by row name");
    const c = rep.checks.find((x) => x.name === "people with under 8 interest rows checked");
    assert.ok(c && !c.ok && c.actual === 2);
    // one more logged check takes Jane to 8
    writeFileSync(join(r.dir, "pages", "osint-log.html"), `<table class="checklist checks">${[...rows, log("interests-jane-doe", 8, "none")].join("")}</table>`);
    assert.equal(lintRoom(r.dir, {}).interests[0].rows, 8);
    const rj = JSON.parse(readFileSync(join(r.dir, "room.json"), "utf8"));
    for (const s of rj.sections) s.pages = s.pages.filter((p) => !p.id.startsWith("interests-"));
    writeFileSync(join(r.dir, "room.json"), JSON.stringify(rj));
    assert.ok(!lintRoom(r.dir, {}).checks.some((x) => /interest/.test(x.name)), "an older room with no interests page is not judged on it");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("lint: a filled persona needs the verdict, a graded claim and the four drivers", () => {
  const base = mkdtempSync(join(tmpdir(), "rooms-ver-"));
  try {
    mkdirSync(join(base, "rooms"));
    const r = composeRoom(
      { company: "Harbor Point Capital", people: "Jane Doe, John Roe", goal: "pitch", date: "2026-12-01", now: "2026-11-12T10:00:00Z" },
      { skeletonDir: join(REPO, "templates", "skeleton"), roomsDir: join(base, "rooms"), configDir: join(base, "config") },
    );
    const g = '<span class="grade inference">Inference</span>';
    const drivers = ["Financial", "Social", "Commercial", "Technical"].map((d) => `<tr class="ck"><td>${d}</td><td>x</td><td>e</td><td>${g}</td><td>s</td></tr>`).join("");
    writeFileSync(
      join(r.dir, "pages", "persona-jane-doe.html"),
      `<div class="verdict" data-verdict="mixed"><p><b>Mixed</b> line</p></div><table class="claims"><tr class="claim"><td>Built X</td><td>Filing shows Y</td><td>s</td><td>${g}</td></tr></table><table class="checklist motives">${drivers}</table>`,
    );
    writeFileSync(join(r.dir, "pages", "persona-john-roe.html"), `<div class="verdict" data-verdict=""></div><table class="checklist motives">${drivers.replace(/<tr class="ck"><td>Technical[\s\S]*$/, "")}</table>`);
    assert.deepEqual(personaGaps(readFileSync(join(r.dir, "pages", "persona-jane-doe.html"), "utf8")), []);
    const rep = lintRoom(r.dir, {});
    assert.deepEqual(rep.personas.map((p) => [p.page, p.missing]), [
      ["persona-jane-doe", []],
      ["persona-john-roe", ["verdict (Proven / Mixed / Unproven)", "claims against the record", "what drives them: technical"]],
    ]);
    const c = rep.checks.find((x) => x.name === "personas missing the verdict or what drives them");
    assert.ok(c && !c.ok && c.actual === 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("reader view: person pages hide rows graded only None found; other rows stay", () => {
  const html = '<table class="checklist"><tr><th>Row</th></tr><tr class="ck"><td>TikTok</td><td><span class="grade none">None found</span></td></tr>\n<tr class="ck"><td>X</td><td><span class="grade verified">Verified</span></td></tr><tr class="ck"><td>Blank</td><td></td></tr></table>';
  const out = hideNoneRows(html);
  assert.doesNotMatch(out, /TikTok/);
  assert.match(out, /<td>X<\/td>/);
  assert.match(out, /<td>Blank<\/td>/, "an ungraded row is lint's business, not hidden");
  assert.ok(isPersonPage("socials-jane-doe") && isPersonPage("footprint-jane-doe") && isPersonPage("relate-a"));
  assert.ok(!isPersonPage("osint-log") && !isPersonPage("public-financials") && !isPersonPage("persona"));
});

test("groups: start, the people, the role, the company, behind the room; person pages split Personal and Professional", () => {
  const room = JSON.parse(readFileSync(join(REPO, "templates", "skeleton", "core", "room.json"), "utf8"));
  const byId = Object.fromEntries(room.sections.map((s) => [s.id, s.group]));
  assert.deepEqual(byId, { start: "start", them: "company", outside: "company", people: "company", person: "person", ask: "role", meetings: "role", drills: "role", mirror: "behind", record: "behind" });
  assert.deepEqual(GROUPS.map((g) => g.id), ["start", "person", "role", "company", "behind"]);
  const parts = Object.fromEntries(room.sections.find((s) => s.id === "person").pages.map((p) => [p.id.replace("-__PERSON_SLUG__", ""), p.part]));
  for (const id of ["interests", "socials", "partner-socials", "names", "education", "financials", "relate"]) assert.equal(parts[id], "personal", id);
  for (const id of ["persona", "linkedin", "writing", "own-words", "network", "public-record", "timeline"]) assert.equal(parts[id], "professional", id);
  assert.equal(partOf({ id: "socials-ann" }), "personal", "inferred when a room has no part");
  assert.equal(partOf({ id: "persona-ann" }), "professional");
  assert.equal(groupOf({ id: "deal" }), "role");
  assert.equal(groupOf({ id: "private-equity" }), "company");
  assert.equal(groupOf({ id: "x", person: "ann" }), "person");

  const base = mkdtempSync(join(tmpdir(), "rooms-grp-"));
  try {
    mkdirSync(join(base, "rooms"));
    const r = composeRoom(
      { company: "Harbor Point Capital", people: "Jane Doe", goal: "negotiate a deal", orgType: "private-equity", date: "2026-12-01", now: "2026-11-12T10:00:00Z" },
      { skeletonDir: join(REPO, "templates", "skeleton"), roomsDir: join(base, "rooms"), configDir: join(base, "config") },
    );
    const g = Object.fromEntries(r.room.sections.map((s) => [s.id, s.group]));
    assert.equal(g.deal, "role", "mode packs sit under the role");
    assert.equal(g["private-equity"], "company", "org-type packs sit under the company");
    assert.equal(g["person-jane-doe"], "person");
    assert.equal(r.room.sections.find((s) => s.id === "person-jane-doe").pages.find((p) => p.id === "relate-jane-doe").part, "personal");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  const build = readFileSync(join(REPO, "scripts", "build.mjs"), "utf8");
  assert.match(build, /details class="grp/);
  assert.match(build, /"Personal" : "Professional"/);
  assert.match(build, /hideNoneRows/);
});
