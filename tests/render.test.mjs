// The room's look: render helpers, the index aside, and a full build of the sample room
// (groups, person cards with verdicts, read counters, jump bar, source chips, one card).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pageStatus, liftTldr, jumpBar, sourceChips, fillMarks, demoAttrs, initials, longDate, minutes, ev, donut, verdictChip } from "../scripts/lib/render.mjs";
import { asideHtml, summaryHtml, oneCardWhen } from "../scripts/lib/schedule.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

test("render: page status from grades, explicit status wins", () => {
  assert.equal(pageStatus({}, { verified: 3, weak: 1 }), "found");
  assert.equal(pageStatus({}, { verified: 1, weak: 2, inference: 1 }), "weak");
  assert.equal(pageStatus({}, { none: 2 }), "none");
  assert.equal(pageStatus({}, {}), "none", "no graded line");
  assert.equal(pageStatus({ status: "weak" }, { verified: 9 }), "weak");
});

test("render: short version lifted and labelled, first paragraph left alone", () => {
  const a = liftTldr('<p>Built from X.</p><div class="tldr"><ul><li>One</li></ul></div><h2>A</h2>');
  assert.match(a.tldr, /^<div class="tldr"><p class="lbl">The short version<\/p><ul>/);
  assert.equal(a.body, "<p>Built from X.</p><h2>A</h2>");
  const b = liftTldr("<p>Built from X.</p><h2>A</h2>");
  assert.equal(b.tldr, "");
  assert.equal(b.body, "<p>Built from X.</p><h2>A</h2>");
});

test("render: jump bar drops a leading number from the link only; source chips idempotent; FILL marked", () => {
  const j = jumpBar("<h2>1. Identity</h2><p>x</p><h2>2. Own words</h2>");
  assert.match(j.body, /<h2 id="1-identity">1\. Identity<\/h2>/);
  assert.match(j.nav, /<li><a href="#1-identity">Identity<\/a><\/li>/);
  assert.equal(jumpBar("<h2>Only</h2>").nav, "", "one heading: no bar");
  const once = sourceChips('<a class="src" href="https://a.example">a</a>');
  assert.equal(once, '<a class="src" href="https://a.example"><span class="vh">Source: </span>a</a>');
  assert.equal(sourceChips(once), once);
  assert.equal(fillMarks("x [FILL: date] y"), 'x <span class="fill">[FILL: date]</span> y');
});

test("render: small helpers", () => {
  assert.equal(initials("Dan Ellison"), "DE");
  assert.equal(initials("Cher"), "C");
  assert.equal(longDate("2026-03-02"), "2 March 2026");
  assert.equal(minutes(10), 1);
  assert.equal(minutes(690), 3);
  assert.equal(ev({}), "");
  assert.match(ev({ verified: 2, weak: 1 }), /aria-label="Grades: 2 verified, 1 weak"/);
  assert.match(donut({ verified: 1, inference: 1 }), />50%<\/text>/);
  assert.equal(verdictChip({ level: "mixed" }), '<span class="vchip mixed">Mixed</span>');
  assert.equal(verdictChip({ level: "maybe" }), "");
  assert.equal(demoAttrs({}), "", "real rooms never carry a demo clock or seeded progress");
  assert.equal(demoAttrs({ demo: { now: "2026-03-03T19:40", read: ["a", "b"] } }), ' data-now="2026-03-03T19:40" data-demo-read="a b"');
});

test("aside: no meetings, an all-day meeting, past then next, done and old deadlines", () => {
  const now = new Date(2026, 2, 3, 19, 40);
  assert.match(asideHtml({}, now), /Not set/);
  const allDay = asideHtml({ meetings: [{ date: "2026-03-05", title: "Day" }] }, now);
  assert.match(allDay, /data-meeting="2026-03-05T09:00"/);
  assert.match(allDay, /time to be confirmed/);
  const html = asideHtml(
    {
      people: [{ name: "Dan Ellison", slug: "dan-ellison" }],
      meetings: [{ date: "2026-02-17", time: "10:00", title: "Discovery" }, { date: "2026-03-05", time: "10:00", tz: "CT", title: "Pitch", who: "Dan and Theo" }],
      deadlines: [{ date: "2026-03-04", time: "18:00", title: "Proposal" }, { date: "2026-03-01", title: "Old" }, { date: "2026-02-20", title: "Ancient" }, { date: "2026-03-09", title: "Done", done: true }],
    },
    now,
    new Set(["one-card"]),
  );
  assert.match(html, /<h2 id="nx">Pitch<\/h2>/);
  assert.match(html, /10:00&nbsp;CT/);
  assert.match(html, /<b class="cd">1<\/b>[\s\S]*<b class="ch">14<\/b>[\s\S]*<b class="cm">20<\/b>/, "countdown filled at build time");
  assert.match(html, /<span class="mono" aria-hidden="true">DE<\/span>/);
  assert.match(html, /<li class="is-done"><b>Discovery<\/b>/);
  assert.match(html, /href="one-card.html"/);
  assert.doesNotMatch(html, /practice/, "no practice page, no button");
  assert.match(html, /data-due="2026-03-04T18:00"/);
  assert.match(html, /data-due="2026-03-01T23:59"/, "a deadline missed within three days still shows");
  assert.doesNotMatch(html, /Ancient|Done/);
  assert.equal(summaryHtml({ summary: "A & B" }), '<div class="summary"><p class="lbl">In one paragraph</p><p>A &amp; B</p></div>');
  assert.match(oneCardWhen({ meetings: [{ date: "2026-03-05", time: "10:00", title: "Pitch" }] }, now).when, /data-until="2026-03-05T10:00"/);
});

test("build: the sample room renders in groups, with person cards, verdicts, read counters and the new page shell", () => {
  const dir = mkdtempSync(join(tmpdir(), "rooms-build-"));
  try {
    execFileSync(process.execPath, [join(REPO, "scripts", "build.mjs")], { env: { ...process.env, DR_OUT: dir }, stdio: "pipe" });
    const index = readFileSync(join(dir, "northwind", "index.html"), "utf8");
    const room = JSON.parse(readFileSync(join(REPO, "rooms", "northwind", "room.json"), "utf8"));
    const total = room.sections.reduce((a, s) => a + s.pages.length, 0);
    assert.match(index, new RegExp(`data-pages="${total}"`));
    for (const s of room.sections) assert.match(index, new RegExp(`<details class="sec" id="${s.id}"[^>]*>[\\s\\S]*?data-read-of="${s.pages.map((p) => p.id).join(" ")}"`), s.id);
    const order = ["g-person", "g-role", "g-company", "g-behind"].map((g) => index.indexOf(`id="${g}"`));
    assert.ok(order.every((x, i) => x > -1 && (i === 0 || x > order[i - 1])), "the person, the role, the company, then behind the room");
    assert.ok(index.indexOf('id="start-here"') < order[0], "Start here on top");
    assert.match(index, /<details class="grp g-behind" id="g-behind"><summary>/, "Behind the room starts collapsed");
    assert.match(index, /<details class="grp g-person" id="g-person" open>/);
    assert.match(index, /<span class="vchip proven">Proven<\/span>/, "verdict on the person card");
    assert.match(index, /<figure class="headshot sm"/, "headshot frame on the person card");
    assert.match(index, /<ol class="matters">/);
    assert.match(index, /<ul class="drives-strip">/);
    assert.match(index, /<ol class="dealpath">/);
    assert.match(index, /<section class="next" data-meeting="2026-03-05T10:00"/);
    assert.match(index, /data-now="2026-03-03T19:40"/, "the synthetic room sets a demo clock");
    assert.doesNotMatch(index, /data-read-of=""/);
    const persona = readFileSync(join(dir, "northwind", "persona-coo.html"), "utf8");
    assert.match(persona, /<nav class="jumps" aria-label="On this page">/);
    assert.match(persona, /<details class="legend">/);
    assert.doesNotMatch(persona, /<a class="src" href="[^"]*">(?!<span class="vh">)/, "every source link is a chip");
    assert.match(persona, /<button class="readbtn" type="button" data-page-id="persona-coo"/);
    assert.match(persona, /<nav class="pager"/);
    assert.match(persona, /<script src="assets\/room.js"><\/script>/);
    const card = readFileSync(join(dir, "northwind", "one-card.html"), "utf8");
    assert.match(card, /<main id="main" class="oc">/);
    assert.match(card, /data-until="2026-03-05T10:00"/);
    assert.ok(existsSync(join(dir, "northwind-sample", "index.html")), "the static sample is copied as it is");
    assert.ok(existsSync(join(dir, "_corpus", "northwind.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
