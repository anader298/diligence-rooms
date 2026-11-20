// Accuracy rules: fitted identity weights, the two-signal rule for Verified, and the fixes for the
// false-positive patterns found by hand-labelling. Fictional people and companies only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWeights, identityProb, sourceFamily, corroborate, isPrimary, overlap } from "../scripts/osint/weights.mjs";
import { featuresOfRow, fit, probOf } from "../scripts/osint/fit-weights.mjs";
import { markStale, runOsint } from "../scripts/osint/run.mjs";
import { sameCompany, kpisFrom, isParkedPage } from "../scripts/osint/colib.mjs";
import { revenueSplits } from "../scripts/osint/modules/51-sec-docs.mjs";
import { headlineIsPerson } from "../scripts/osint/modules/56-profile.mjs";
import { scoreCandidate } from "../scripts/osint/modules/30-identity.mjs";

const SUBJ = { name: "Mara Quill", company: "Tessellate Robotics", domain: "tessellate.example" };

test("weights: versioned file, probability in bits, thresholds present", () => {
  const w = loadWeights();
  assert.match(w.id, /^osint-weights@\d+$/);
  assert.ok(w.version >= 2, "fitted weights are in force");
  assert.ok(w.fitted?.candidates > 0);
  const nameOnly = identityProb({ name: true }, w);
  const anchored = identityProb({ name: true, employer_on_profile: true }, w);
  assert.ok(nameOnly.p < 0.2, `name alone stays a lead (p ${nameOnly.p})`);
  assert.ok(anchored.p > nameOnly.p);
  assert.ok(anchored.p < w.identity.thresholds.verified, "one anchor never reaches verified on its own");
});

test("identity: a name-only account is unclear; the verdict carries p, features and the weights id", () => {
  const yt = { site: "youtube", handle: "maraquill", url: "https://www.youtube.com/@maraquill", name: "Mara Quill" };
  const s = scoreCandidate(yt, SUBJ, {}, [yt]);
  assert.equal(s.verdict, "unclear");
  assert.equal(s.features.name, true);
  assert.equal(s.features.derived_handle, true);
  assert.equal(s.weights, loadWeights().id);
  assert.ok(typeof s.p === "number" && s.p < 0.5);
});

test("fit: features read back from older rows' reasons; the fit separates anchored from name-only", () => {
  const row = { module: "identity", detail: { verdict: "likely", reasons: ["name +2", "employer on profile +5", 'other place "Leeds" -3'], handle: "maraquill", site: "linkedin" } };
  const f = featuresOfRow(row, SUBJ);
  assert.deepEqual(Object.keys(f).sort(), ["derived_handle", "employer_on_profile", "empty_profile", "name", "place_contra"]);
  const ex = [];
  for (let i = 0; i < 40; i++) ex.push({ slug: "a", x: { name: true }, y: 0 });
  for (let i = 0; i < 4; i++) ex.push({ slug: "b", x: { name: true, company_text: true }, y: 1 });
  ex.push({ slug: "c", x: { name: true }, y: 1 });
  const m = fit(ex, ["name", "company_text"], { name: 2, company_text: 4 }, { sd: 1 });
  assert.ok(probOf({ name: true }, m) < 0.15);
  assert.ok(probOf({ name: true, company_text: true }, m) > 0.5);
});

test("source families: one per registry, the company's own domain, otherwise the site", () => {
  assert.equal(sourceFamily("https://www.sec.gov/Archives/x", SUBJ), "sec");
  assert.equal(sourceFamily("https://data.sec.gov/api/xbrl/x", SUBJ), "sec");
  assert.equal(sourceFamily("https://investors.tessellate.example/news", SUBJ), "company-site");
  assert.equal(sourceFamily("https://www.linkedin.com/in/maraquill", SUBJ), "linkedin");
  assert.equal(sourceFamily("https://blog.example.org/a", SUBJ), "example.org");
  assert.equal(sourceFamily("https://news.example.org/b", SUBJ), "example.org", "two pages of one site are one family");
});

test("two-signal rule: single-source Verified drops to Partly; corroborated or primary rows stay", () => {
  const rows = [
    { id: "L-1", module: "leadership", var: "role.title", value: "Chief Operating Officer", url: "https://tessellate.example/leadership", grade: "v" },
    { id: "L-2", module: "sec-person", var: "role.title", value: "Chief Operating Officer", url: "https://www.sec.gov/Archives/edgar/data/1/2/x.xml", grade: "v", anchors: ["sec-owner-cik"] },
    { id: "L-3", module: "form5500", var: "co.benefit_plans", value: "TESSELLATE 401K PLAN: 41 participants", url: "https://www.efast.dol.gov/5500search/", grade: "v" },
    { id: "L-4", module: "leadership", var: "career.timeline", value: "Joined in 2019 from a logistics firm", url: "https://tessellate.example/team/mara", grade: "v" },
    { id: "L-5", module: "records", var: "rec.sanctions", value: "Clear: no match", url: "https://www.treasury.gov/ofac/downloads/sdn.csv", grade: "v" },
    { id: "L-6", module: "wikidata", var: "co.facts", value: "founded 2015", url: "https://www.wikidata.org/wiki/Q1", grade: "p" },
  ];
  corroborate(rows, SUBJ, loadWeights());
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by["L-1"].grade, "v", "company site title corroborated by the Form 4");
  assert.deepEqual(by["L-1"].corroborated_by, ["L-2"]);
  assert.equal(by["L-2"].grade, "v");
  assert.equal(by["L-3"].grade, "p", "a name-matched plan from one registry is one signal");
  assert.equal(by["L-3"].graded_from, "v");
  assert.match(by["L-3"].grade_basis, /one source/);
  assert.equal(by["L-4"].grade, "p");
  assert.equal(by["L-5"].grade, "v");
  assert.equal(by["L-5"].grade_basis, "primary record");
  assert.equal(by["L-6"].grade, "p", "rows below Verified are left alone");
  assert.ok(isPrimary(by["L-2"], SUBJ));
  assert.ok(!isPrimary(by["L-3"], SUBJ));
  assert.ok(overlap("Chief Operating Officer", "COO, Chief Operating Officer") >= 0.6);
});

test("identity rows: an account's own evidence sources count, so two sources keep Verified", () => {
  const rows = [
    { id: "L-1", module: "identity", var: "social.accounts", value: "github @mquill", url: "https://github.com/mquill", grade: "v", detail: { signalSources: ["github", "company-site"] } },
    { id: "L-2", module: "identity", var: "social.accounts", value: "linkedin @maraquill", url: "https://www.linkedin.com/in/maraquill", grade: "v", detail: { signalSources: ["linkedin"] } },
  ];
  corroborate(rows, SUBJ, loadWeights());
  assert.equal(rows[0].grade, "v");
  assert.equal(rows[1].grade, "p");
});

test("stale seat: once a later source reports a change, older title rows drop to Weak", () => {
  const rows = [
    { id: "L-1", module: "sec-person", var: "role.title", value: "EVP, Operations", grade: "v", date: "2026-04-01" },
    { id: "L-2", module: "leadership", var: "role.title", value: "EVP, Operations", grade: "p", date: null },
    { id: "L-3", module: "sec-person", var: "role.title", value: "Senior Advisor", grade: "v", date: "2026-10-01" },
    { id: "L-4", module: "departure", var: "role.title", value: "Stepping down", grade: "p", date: "2026-09-08" },
  ];
  markStale(rows, "2026-09-08", "L-4");
  assert.equal(rows[0].grade, "w");
  assert.equal(rows[0].graded_from, "v");
  assert.match(rows[0].grade_basis, /out of date/);
  assert.equal(rows[1].grade, "w");
  assert.equal(rows[2].grade, "v", "a title filed after the change stays");
  assert.equal(rows[3].grade, "p");
});

test("company names: the record must be the company, not another firm sharing a word", () => {
  assert.ok(sameCompany("Tessellate", "TESSELLATE INC."));
  assert.ok(sameCompany("Tessellate", "Tessellate Systems Incorporated"));
  assert.ok(sameCompany("Tessellate Robotics", "TESSELLATE ROBOTICS, LLC"));
  assert.ok(!sameCompany("Tessellate", "Tessellate Interior Services"));
  assert.ok(!sameCompany("Tessellate", "Valdez Gravel & Tessellate"));
  assert.ok(!sameCompany("Tessellate", "Tessellate Landscaping LLC"));
});

test("headlines: a one-word company that is also a person's surname", () => {
  assert.ok(headlineIsPerson("Kim Varga breaks silence over selection row", "Varga"));
  assert.ok(headlineIsPerson("Varga might not be available for the final, says coach", "Varga"));
  assert.ok(!headlineIsPerson("Varga Inc. reports third quarter results", "Varga"));
  assert.ok(!headlineIsPerson("Varga to build new engine plant in Ohio", "Varga"));
  assert.ok(!headlineIsPerson("Kim Varga breaks silence", "Varga Holdings Group Partners"), "multi-word names are not checked");
});

test("KPIs: a sub-metric or a target is never reported as the company figure", () => {
  const k = kpisFrom("Tessellate AI-first ARR grew 150% year over year. Total Tessellate ARR grew 10.5% to $2.1 billion. We are targeting non-GAAP operating margin of 44.0% in the fourth quarter. GAAP operating margin was 31.2%.", { company: "Tessellate" });
  const by = Object.fromEntries(k.map((x) => [x.kpi, x.value]));
  assert.equal(by["ARR growth"], "10.5%");
  assert.equal(by["GAAP operating margin"], "31.2%");
  assert.ok(!Object.values(by).includes("44.0%"));
  assert.ok(!Object.values(by).includes("150%"));
  const only = kpisFrom("Robotics ARR grew 40%.", { company: "Tessellate" });
  assert.equal(only[0].kpi, "Robotics ARR growth", "a lone sub-metric is named as one");
});

test("revenue tables: percentage lines are not money", () => {
  const html = `<p>In millions</p><table>
<tr><td>Americas</td><td>3,970</td><td>59</td></tr>
<tr><td>Percentage of total revenue</td><td>59</td><td>%</td></tr>
<tr><td>EMEA</td><td>1,850</td><td>27</td></tr>
<tr><td>Asia</td><td>900</td><td>14</td></tr>
<tr><td>Total revenue</td><td>6,720</td><td>100</td></tr></table>`;
  const s = revenueSplits(html);
  assert.equal(s.length, 1);
  assert.deepEqual(s[0].rows.map((r) => r.label), ["Americas", "EMEA", "Asia"]);
});

test("web archive: AdSense parking is parked; a JavaScript app shell is not", () => {
  assert.ok(isParkedPage(`<html><head><script src="http://www.google.com/adsense/domains/caf.js"></script><title>tessellate.example</title></head><body>Related searches</body></html>`));
  assert.ok(!isParkedPage(`<html><head><title>Tessellate</title><meta content="x" name="csrf-token" /></head><body><script src="/assets/application-1b2c.js"></script></body></html>`));
  assert.ok(isParkedPage(`<html><body>coming</body></html>`));
});

test("runner: every ledger row records the weights version; single-source Verified rows are downgraded on disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "osint-acc-"));
  const mod = {
    id: "plans",
    lane: "fast",
    async run(ctx) {
      ctx.add({ var: "co.benefit_plans", value: "TESSELLATE 401K PLAN: 12 participants", url: "https://www.efast.dol.gov/5500search/", grade: "v" });
      ctx.add({ var: "rec.sanctions", value: "Clear: no match for Mara Quill", url: "https://www.treasury.gov/ofac/downloads/sdn.csv", grade: "v" });
    },
  };
  const recMod = { ...mod, id: "records" };
  const res = await runOsint(SUBJ, { outDir: dir, modules: [mod], log: () => {}, fetchImpl: async () => new Response("", { status: 404 }) });
  assert.equal(res.weights, loadWeights().id);
  const disk = readFileSync(join(dir, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(disk.every((r) => r.weights === loadWeights().id));
  assert.equal(disk.find((r) => r.var === "co.benefit_plans").grade, "p");
  // the same sanctions screen from the records module is a primary record
  const dir2 = mkdtempSync(join(tmpdir(), "osint-acc-"));
  const res2 = await runOsint(SUBJ, { outDir: dir2, modules: [recMod], log: () => {}, fetchImpl: async () => new Response("", { status: 404 }) });
  assert.equal(res2.rows.find((r) => r.var === "rec.sanctions").grade, "v");
});

test("departure: a CEO asking employees to quit has not left; the run raises no alert", async () => {
  const { departureFrom, othersLeave } = await import("../scripts/osint/colib.mjs");
  const { departureSignals } = await import("../scripts/osint/modules/30-identity.mjs");
  const { departureCheck } = await import("../scripts/osint/run.mjs");
  const s = { name: "Avery Lund", company: "Corvid Systems" };
  const head = "Corvid Systems CEO Avery Lund asks employees to quit if they do not like the return-to-office rule";
  assert.ok(othersLeave(head));
  assert.equal(departureFrom(head, s), null);
  assert.equal(departureFrom("Avery Lund tells staff who disagree they can leave Corvid Systems", s), null);
  assert.equal(departureSignals(s, { searchResults: [{ title: head, url: "https://news.example/a" }] }, []).length, 0);
  const rows = [{ id: "L-1", module: "person-news", var: "news.articles", value: head, grade: "p", anchors: ["company"] }];
  assert.equal(departureCheck(s, rows, { searchResults: [{ title: head, url: "https://news.example/a" }] }).alerts.length, 0);
  // a real resignation still counts
  assert.ok(departureFrom("Avery Lund resigns from Corvid Systems", s)?.left);
  assert.equal(departureFrom("Avery Lund quits Corvid Systems to join Heron Labs", s).newCompany, "Heron Labs");
});

test("stale seat: search snippets that still give the old title drop to Weak; history lines stay", () => {
  const rows = [
    { id: "L-1", module: "sec-person", var: "role.title", value: "EVP, Merchandising", grade: "v", date: "2026-04-01" },
    { id: "L-2", module: "search", var: "news.articles", value: "Mara Quill is Exec VP: Merchandising at Tessellate", grade: "p" },
    { id: "L-3", module: "search", var: "career.timeline", value: "Mara Quill, formerly head of merchandising at Kestrel", grade: "p" },
    { id: "L-4", module: "search", var: "news.articles", value: "Tessellate opens a plant in Ohio", grade: "p" },
  ];
  markStale(rows, "2026-11-14", "L-9");
  assert.deepEqual(rows.map((r) => r.grade), ["w", "w", "p", "p"]);
});
