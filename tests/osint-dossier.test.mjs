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
