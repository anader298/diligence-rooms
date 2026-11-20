// The OSINT dossier page: one self-contained HTML file, every web value escaped, every tab present,
// and it renders for an empty run as well as a full one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderDossier } from "../scripts/osint/dossier.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = () => JSON.parse(readFileSync(join(REPO, "tests", "fixtures", "osint-dossier-result.json"), "utf8"));
const EXTRA = ["accounts", "timeline", "sources", "gaps", "run"];
const XSS = "<img src=x onerror=alert(1)>";
const scripts = (html) => [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];

function hostile() {
  const r = fixture();
  r.subject.name = `Jane ${XSS} Doe`;
  r.rows.unshift(
    { id: "L-9001", module: "evil", var: "role.title", tab: "professional", label: XSS, group: "The seat", value: XSS, url: "javascript:alert(1)", grade: "v", tier: "A", ms: 1, anchors: [XSS, { label: XSS, w: -2 }], detail: { [XSS]: XSS, rows: [{ a: XSS }] }, date: "2026-01-01", image: "javascript:alert(2)" },
    { id: "L-9002", module: "evil", var: "news.articles", tab: "news", label: "x", value: "</script><script>alert(3)</script>", url: "https://example.com/a", grade: "w", tier: "C", ms: 2, anchors: [], detail: null, date: null, image: null }
  );
  r.misses.push({ module: "evil", var: "hobby.teams", label: "x", tab: "personal", searched: XSS });
  return r;
}

test("dossier: web values are escaped, never markup", () => {
  const html = renderDossier(hostile());
  assert.ok(!html.includes(XSS), "raw <img onerror> must not appear anywhere");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"), "server-rendered copies are entity-escaped");
  assert.ok(html.includes("\\u003cimg src=x onerror=alert(1)>"), "the JSON data block writes < as \\u003c");
  assert.equal(scripts(html).length, 2, "a value cannot close the data block and open a script");
  assert.ok(!/href="javascript:/i.test(html) && !/src="javascript:/i.test(html), "javascript: URLs are never linked");
  assert.ok(!/<[^>]*\son[a-z]+\s*=/i.test(html.replace(/<script[\s\S]*?<\/script>/g, "")), "no inline event handlers in the markup");
});

test("dossier: self-contained, script pinned by CSP hash", async () => {
  const html = renderDossier(fixture());
  assert.ok(!/<link\b|<script[^>]+src=/i.test(html), "no external scripts or stylesheets");
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.ok(!/@import|url\(/i.test(css), "no external assets from CSS");
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  const js = scripts(html).find((m) => !m[0].includes("application/json"))[1];
  const { createHash } = await import("node:crypto");
  assert.ok(csp.includes(`'sha256-${createHash("sha256").update(js).digest("base64")}'`), "CSP pins the one inline script");
  assert.doesNotThrow(() => new Function(js), "client script parses");
  const data = JSON.parse(scripts(html).find((m) => m[0].includes("application/json"))[1]);
  assert.equal(data.rows.length, fixture().rows.length);
});

test("dossier: every tab present, with its panel", () => {
  const r = fixture();
  const html = renderDossier(r);
  for (const [id] of r.tabs) {
    assert.ok(html.includes(`id="p-${id}"`), `panel ${id}`);
    assert.ok(html.includes(`data-tab="${id}"`), `tab button ${id}`);
  }
  for (const id of EXTRA) assert.ok(html.includes(`id="p-${id}"`), `panel ${id}`);
  assert.match(html, /<h1>Maren Torvald<\/h1>/);
  assert.match(html, /\$1,750 on record/, "donation tile sums the FEC rows");
});

test("dossier: empty and partial results still render", () => {
  const r = fixture();
  const empty = { ...r, rows: [], misses: [], modules: [], http: { calls: 0, blocked: 0 } };
  const html = renderDossier(empty);
  assert.match(html, /No findings in this run/);
  assert.match(html, /<b>0<\/b> of 88 variables filled/);
  for (const id of EXTRA) assert.ok(html.includes(`id="p-${id}"`));
  const bare = renderDossier({ subject: { name: "Nobody" } });
  assert.match(bare, /<h1>Nobody<\/h1>/);
  for (const id of EXTRA) assert.ok(bare.includes(`id="p-${id}"`));
  assert.doesNotThrow(() => renderDossier(undefined));
});

test("dossier: 2,000 rows render quickly", () => {
  const r = fixture();
  const rows = [];
  for (let i = 0; i < 2000; i++) {
    const b = r.rows[i % r.rows.length];
    rows.push({ ...b, id: "L-" + String(i + 1).padStart(4, "0"), value: b.value + " #" + i });
  }
  const t0 = performance.now();
  const html = renderDossier({ ...r, rows });
  assert.ok(performance.now() - t0 < 1000, "server render under a second");
  assert.ok(html.length < 3_000_000);
});

// ---- top cards, alerts, blocked vs none found
import { cardRows, collectAlerts, isBlockedMiss, fixFor } from "../scripts/osint/dossier.mjs";

const row = (o) => ({ id: "L-" + Math.random().toString().slice(2, 6), module: "x", tab: "personal", label: o.var, tier: "A", anchors: [], detail: null, date: null, image: null, url: null, ms: 1, ...o });
const snap = (html) => html.slice(html.indexOf('<div class="card snap">'), html.indexOf('<nav class="tabs"'));

test("top cards: no pay sentence as education, no namesake or weak rows, tier A first", () => {
  const r = fixture();
  r.rows = [
    row({ var: "career.education", module: "sec-person", grade: "v", value: "In the fourth quarter of 2025, our CEO recommended to the TMCC, and the TMCC approved, that Ms. Calder earned the grant" }),
    row({ var: "career.education", module: "person-wikidata", grade: "w", value: "University of Houston Law Center (Wikidata)" }),
    row({ var: "career.education", module: "profiles", grade: "p", tier: "C", value: "Wittenberg University (LinkedIn public profile)", detail: { identity: "unclear" } }),
    row({ var: "place.home_metro", module: "profiles", grade: "w", tier: "C", value: "Burleson, Texas (chess.com profile location)" }),
    row({ var: "place.home_metro", module: "profiles", grade: "p", tier: "C", value: "Cary (LinkedIn public profile)", url: "https://www.linkedin.com/in/real", detail: { identity: "likely" } }),
    row({ var: "role.title", module: "sec-person", grade: "v", value: "See Remarks" }),
    row({ var: "co.growth_line", module: "sec-docs", tab: "agenda", grade: "v", value: "Although we exclude amortization of acquired intangible assets from our non-GAAP financial measures, revenue grows" }),
    row({ var: "co.facts", module: "wikidata", tab: "company", grade: "v", value: "founded 2000; hq Vienna; industry retail" }),
    row({ var: "money.comp", module: "sec-person", tab: "money", grade: "v", value: "FY2025 total pay $5,751,445 (proxy)" }),
  ];
  const html = renderDossier(r);
  const s = snap(html);
  assert.ok(!/TMCC|Houston Law|Wittenberg|Burleson|See Remarks|amortization|industry retail/.test(s), s);
  assert.match(s, /Cary \(LinkedIn public profile\)/);
  assert.match(s, /\$5,751,445/);
  const best = cardRows([row({ var: "role.start", grade: "p", tier: "C", value: "2023 (news)", module: "sec-docs" }), row({ var: "role.start", grade: "p", tier: "A", value: "January 2023 (proxy)", module: "sec-person" })], "role.start");
  assert.equal(best[0].value, "January 2023 (proxy)");
});

test("alerts: departure and blocked key sources render as a banner at the top", () => {
  const r = fixture();
  r.alerts = [{ level: "red", text: "Steve Ferrante may have left Lumen Arcade: \"Lumen Arcade Store boss quits\"", url: "https://pcgamer.example/x" }];
  r.rows.push(row({ var: "role.status", tab: "professional", grade: "p", value: "dup", detail: { alert: { level: "red", text: "Steve Ferrante may have left Lumen Arcade: \"Lumen Arcade Store boss quits\"" } } }));
  r.misses.push({ module: "fec", var: "politics.donations", label: "x", tab: "politics", searched: "FEC API: blocked (HTTP 429), unknown · fix: set FEC_API_KEY (free at api.data.gov)" });
  const html = renderDossier(r);
  const top = html.slice(html.indexOf("<body>"), html.indexOf('<header class="top">'));
  assert.match(top, /class="alert a-red"[^]*may have left Lumen Arcade/);
  assert.equal((top.match(/may have left/g) || []).length, 1, "same alert from result and row shown once");
  assert.match(top, /class="alert a-amber"[^]*FEC API/);
  const a = collectAlerts({ alerts: [], rows: [], misses: [], modules: [{ id: "patents", label: "Patents", status: "blocked" }] });
  assert.match(a[0].text, /Blocked, so unknown[^]*Patents/);
});

test("gaps: blocked/not-checked is told apart from searched-and-empty, with the fix", () => {
  const blocked = [
    { searched: "FEC API: blocked (HTTP 429), unknown · fix: set FEC_API_KEY (free at api.data.gov)" },
    { searched: "Google Patents xhr: HTTP 503 — patents not checked, unknown rather than none" },
    { searched: "OpenSanctions (PEPs, global lists) not checked: needs OPENSANCTIONS_API_KEY" },
    { searched: "site:x.com search not run: engine blocked (ddg 202), unknown" },
    { searched: "anything", blocked: true, fix: "do X" },
  ];
  for (const m of blocked) assert.ok(isBlockedMiss(m), m.searched);
  assert.ok(!isBlockedMiss({ searched: "GDELT and Google News: no headline naming \"Jane Doe\" in the last 12 months" }));
  assert.ok(!isBlockedMiss({ searched: "Google Patents: no patents with inventor jane doe" }));
  assert.equal(fixFor(blocked[0]), "set FEC_API_KEY (free at api.data.gov)");
  assert.match(fixFor(blocked[2]), /OPENSANCTIONS_API_KEY/);
  assert.match(fixFor(blocked[3]), /BRAVE_API_KEY/);
  const r = fixture();
  r.misses = [{ module: "fec", var: "politics.donations", label: "x", tab: "politics", searched: blocked[0].searched }, { module: "patents", var: "career.patents", label: "x", tab: "professional", searched: "Google Patents: no patents with inventor jane doe" }];
  const html = renderDossier(r);
  const data = JSON.parse(scripts(html).find((m) => m[0].includes("application/json"))[1]);
  assert.deepEqual(data.misses.map((m) => m.blocked), [true, false]);
  assert.equal(data.misses[0].fix, "set FEC_API_KEY (free at api.data.gov)");
  const js = scripts(html).find((m) => !m[0].includes("application/json"))[1];
  assert.match(js, /Blocked \/ not checked/);
  assert.match(js, /Searched, none found/);
});

test("dossier client: numbers, CSS leaks, duplicates and namesake avatars are handled", () => {
  const js = scripts(renderDossier(fixture())).find((m) => !m[0].includes("application/json"))[1];
  // years and Unix times are not formatted as quantities; CSS declarations are stripped
  assert.match(js, /x >= 1900 && x <= 2100/);
  assert.match(js, /CSSDECL/);
  assert.match(js, /function dedupe/);
  assert.match(js, /okImage/);
});
