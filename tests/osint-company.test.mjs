// Company-side OSINT modules. No network: helpers get inline fixtures, and the modules run
// through runOsint with a fake fetch that answers by URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOsint } from "../scripts/osint/run.mjs";
import { matchCompany, pickRevenue, parseForm4, parseJobs, parseSCT, estimates, bioFrom, educationFrom, parseLeadership, paylocityPageData, stripBoilerplate, seniorityOf, money } from "../scripts/osint/colib.mjs";
import secMods from "../scripts/osint/modules/50-sec.mjs";
import jobsMod from "../scripts/osint/modules/53-jobs.mjs";
import estMod from "../scripts/osint/modules/57-estimates.mjs";

const TICKERS = {
  0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
  1: { cik_str: 876167, ticker: "PRGS", title: "PROGRESS SOFTWARE CORP /MA" },
  2: { cik_str: 1111, ticker: "PRGX", title: "Progress Acquisition Holdings Group Inc" },
  3: { cik_str: 2222, ticker: "ACME", title: "Acme United Corp" },
};

const fact = (start, end, val, fp = "FY", form = "10-K", filed = end) => ({ start, end, val, fp, form, filed, fy: Number(end.slice(0, 4)) });
const FACTS = {
  facts: {
    "us-gaap": {
      Revenues: { units: { USD: [fact("2017-12-01", "2018-11-30", 400e6)] } },
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        units: {
          USD: [
            fact("2023-12-01", "2024-11-30", 753e6),
            fact("2024-12-01", "2025-11-30", 978e6),
            fact("2025-06-01", "2025-08-31", 250e6, "Q3", "10-Q"),
            fact("2026-06-01", "2026-08-31", 246e6, "Q3", "10-Q"),
            fact("2025-12-01", "2026-08-31", 740e6, "Q3", "10-Q"), // nine months: must be ignored
          ],
        },
      },
      CashAndCashEquivalentsAtCarryingValue: { units: { USD: [{ end: "2026-08-31", val: 113.6e6, filed: "2026-09-30" }] } },
    },
    dei: { EntityNumberOfEmployees: { units: { pure: [{ end: "2025-11-30", val: 2801, filed: "2026-01-20" }] } } },
  },
};

const FORM4 = `<?xml version="1.0"?><ownershipDocument><documentType>4</documentType><periodOfReport>2026-10-21</periodOfReport>
<issuer><issuerCik>0000876167</issuerCik><issuerName>PROGRESS SOFTWARE CORP /MA</issuerName><issuerTradingSymbol>PRGS</issuerTradingSymbol></issuer>
<reportingOwner><reportingOwnerId><rptOwnerCik>0009990001</rptOwnerCik><rptOwnerName>Whitlock Dana</rptOwnerName></reportingOwnerId>
<reportingOwnerRelationship><isDirector>0</isDirector><isOfficer>1</isOfficer><officerTitle>EVP/GM Digital Experience</officerTitle></reportingOwnerRelationship></reportingOwner>
<nonDerivativeTable><nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle><transactionDate><value>2026-10-21</value></transactionDate>
<transactionCoding><transactionFormType>4</transactionFormType><transactionCode>S</transactionCode></transactionCoding>
<transactionAmounts><transactionShares><value>2086</value></transactionShares><transactionPricePerShare><value>43.47</value><footnoteId id="F2"/></transactionPricePerShare><transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts>
<postTransactionAmounts><sharesOwnedFollowingTransaction><value>10815</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
<ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature></nonDerivativeTransaction></nonDerivativeTable>
<derivativeTable><derivativeTransaction><securityTitle><value>Stock Option</value></securityTitle><transactionDate><value>2026-10-20</value></transactionDate><transactionCoding><transactionCode>M</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>500</value></transactionShares><transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts><postTransactionAmounts><sharesOwnedFollowingTransaction><value>0</value></sharesOwnedFollowingTransaction></postTransactionAmounts></derivativeTransaction></derivativeTable>
</ownershipDocument>`;

const GH = {
  jobs: [
    { title: "VP, Revenue Operations", absolute_url: "https://job-boards.greenhouse.io/acme/jobs/1", location: { name: "Austin, TX" }, departments: [{ name: "Sales" }], first_published: "2026-11-01", content: "&lt;p&gt;Reports to the Chief Revenue Officer. Own Salesforce and HubSpot. Drive ARR growth.&lt;/p&gt;&lt;p&gt;Acme is used by 5,000 teams.&lt;/p&gt;" },
    { title: "Senior Software Engineer", absolute_url: "https://job-boards.greenhouse.io/acme/jobs/2", location: { name: "Remote" }, departments: [{ name: "Engineering" }], first_published: "2026-10-01", content: "&lt;p&gt;Python and AWS. Kubernetes.&lt;/p&gt;&lt;p&gt;Acme is used by 5,000 teams.&lt;/p&gt;" },
    { title: "Sales Operations Analyst", absolute_url: "https://job-boards.greenhouse.io/acme/jobs/3", location: { name: "Austin, TX" }, departments: [{ name: "Sales" }], first_published: "2026-10-05", content: "&lt;p&gt;Reports to the VP, Revenue Operations. Salesforce reporting.&lt;/p&gt;" },
  ],
};

/** Fake fetch: first matching [substring, body, status] wins; everything else is a 404. */
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || "GET" });
    const hit = routes.find(([k]) => url.includes(k));
    const body = hit ? (typeof hit[1] === "string" ? hit[1] : JSON.stringify(hit[1])) : "not found";
    return new Response(body, { status: hit ? hit[2] || 200 : 404, headers: { "content-type": "text/plain" } });
  };
  f.calls = calls;
  return f;
}
const tmp = () => mkdtempSync(join(tmpdir(), "osint-co-"));
const quiet = () => {};

test("matchCompany: exact normalised name, ticker, and no loose matches", () => {
  assert.equal(matchCompany(TICKERS, { name: "Progress Software" }).cik, 876167);
  assert.equal(matchCompany(TICKERS, { name: "Progress Software Corporation" }).ticker, "PRGS");
  assert.equal(matchCompany(TICKERS, { name: "whatever", ticker: "acme" }).cik, 2222);
  assert.equal(matchCompany(TICKERS, { name: "Plumeria Labs" }), null);
  assert.equal(matchCompany(TICKERS, { name: "Harlow Industries" }), null);
});

test("pickRevenue: newest concept, quarter vs year-ago quarter, ignores nine-month totals", () => {
  const r = pickRevenue(FACTS);
  assert.equal(r.concept, "RevenueFromContractWithCustomerExcludingAssessedTax");
  assert.equal(r.annual.val, 978e6);
  assert.ok(Math.abs(r.annualYoY - (978 / 753 - 1)) < 1e-9);
  assert.equal(r.quarter.val, 246e6);
  assert.equal(r.priorQuarter.val, 250e6);
  assert.ok(r.quarterYoY < 0);
});

test("parseForm4: owner, title, trades with codes, derivative rows kept apart", () => {
  const p = parseForm4(FORM4);
  assert.equal(p.owner, "Whitlock Dana");
  assert.equal(p.ownerCik, "0009990001");
  assert.equal(p.title, "EVP/GM Digital Experience");
  assert.equal(p.isOfficer, true);
  assert.equal(p.trades.length, 2);
  const sale = p.trades.find((t) => !t.derivative);
  assert.deepEqual([sale.code, sale.what, sale.shares, sale.price, sale.after, sale.date], ["S", "open-market sale", 2086, 43.47, 10815, "2026-10-21"]);
  assert.equal(p.trades.find((t) => t.derivative).code, "M");
});

test("parseSCT: the person's rows across years, NEO list when absent", () => {
  const html = `<p>Summary Compensation Table</p><table>
  <tr><td>Name and Principal Position</td><td>Year</td><td>Salary ($)</td><td>Stock Awards ($)</td><td>Total ($)</td></tr>
  <tr><td>Yogesh Gupta, Chief Executive Officer</td><td>2025</td><td>$</td><td>649,038</td><td>7,043,127</td><td>10,534,808</td></tr>
  <tr><td>Dana Whitlock, EVP and GM, Digital Experience</td><td>2025</td><td>436,200</td><td>1,391,040</td><td>2,612,330</td></tr>
  <tr><td>2024</td><td>441,346</td><td>1,111,199</td><td>2,191,091</td></tr></table>`;
  const s = parseSCT(html, "Dana Whitlock");
  assert.equal(s.isNeo, true);
  assert.equal(s.years[0].year, 2025);
  assert.equal(s.years[0].total, 2612330);
  assert.equal(s.years[0].cells.Salary, 436200);
  assert.equal(s.years[1].total, 2191091);
  const no = parseSCT(html, "Jane Nobody");
  assert.equal(no.isNeo, false);
  assert.ok(no.neos.includes("Yogesh Gupta"));
});

test("bio, education and leadership cards from a team page", () => {
  const html = `<h3>Ellen Park</h3><p>Ellen Park is the CEO of Harlow Industries. She joined the Company in 2008.</p>
  <img src="/u/Richard-Kessler.jpg" alt=""><h3>Richard Kessler</h3><p>Joining the Company in May of 2025 as VP of Operations, Richard Kessler brings his many years of experience to the team. Mr. Kessler recently served as the COO of the Corlan Group. He graduated NJIT with a BS in Mechanical Engineering Technology and MS in Engineering Management.</p>
  <h3>Chief Financial Officer</h3><p>Our finance team.</p><h4>Ann Lee</h4><p>VP Product at OtherCo</p>`;
  const team = parseLeadership(html);
  assert.deepEqual(team.map((p) => [p.name, p.title]), [["Ellen Park", "CEO"], ["Richard Kessler", "VP of Operations"]]);
  assert.equal(team[1].img, "/u/Richard-Kessler.jpg");
  const bio = bioFrom("Other text. " + team[1].bio, "Richard Kessler");
  assert.match(bio, /Corlan Group/);
  assert.match(educationFrom(bio)[0], /NJIT/);
});

test("job boards: Greenhouse and Paylocity payloads normalise, boilerplate drops out", () => {
  const g = parseJobs("greenhouse", GH);
  assert.equal(g.length, 3);
  assert.equal(g[0].dept, "Sales");
  assert.match(g[0].text, /Chief Revenue Officer/);
  const pd = paylocityPageData(`<script>window.pageData = {"Jobs":[{"JobId":7,"JobTitle":"Maintenance Mechanic","LocationName":"Southampton, PA","PublishedDate":"2026-11-01","Description":"x"}]};</script>`);
  const p = parseJobs("paylocity", pd);
  assert.equal(p[0].title, "Maintenance Mechanic");
  assert.match(p[0].url, /Details\/7$/);
  const s = stripBoilerplate(["A is used by many. Own Salesforce.", "A is used by many. Python.", "A is used by many. AWS.", "A is used by many. Go."]);
  assert.ok(s.every((x) => !x.includes("used by many")));
});

test("jobs module: ATS found on the careers page, rows by department, reporting lines", async () => {
  const fetchImpl = fakeFetch([
    ["acme.com/careers", `<html><body><a href="https://job-boards.greenhouse.io/acme">Open roles</a></body></html>`],
    ["boards-api.greenhouse.io/v1/boards/acme/jobs", GH],
  ]);
  const r = await runOsint({ name: "Pat Doe", company: "Acme Corp", domain: "acme.com", title: "VP Revenue Operations" }, { outDir: tmp(), modules: [jobsMod], fetchImpl, log: quiet });
  const hiring = r.rows.filter((x) => x.var === "co.hiring");
  assert.match(hiring[0].value, /^3 open roles on greenhouse \(Sales 2, Engineering 1\)/);
  assert.equal(hiring[0].grade, "v");
  assert.equal(hiring[1].value.startsWith("VP, Revenue Operations"), true, "most relevant title first");
  assert.ok(r.rows.some((x) => x.var === "role.directs" && /VP, Revenue Operations/.test(x.value)));
  assert.ok(r.rows.some((x) => x.var === "fit.problem" && /Salesforce/.test(x.value)));
  assert.ok(!fetchImpl.calls.some((c) => c.url.includes("api.lever.co")), "no slug probing once the board is known");
});

test("sec module: CIK match, XBRL revenue and quarter rows, misses for a private company", async () => {
  const sub = { name: "PROGRESS SOFTWARE CORP /MA", sic: "7372", sicDescription: "Services-Prepackaged Software", fiscalYearEnd: "1130", exchanges: ["Nasdaq"], filings: { recent: { form: ["10-Q", "8-K", "DEF 14A"], filingDate: ["2026-09-30", "2026-09-30", "2026-03-25"], accessionNumber: ["0000876167-26-000111", "0000876167-26-000110", "0001552781-26-000161"], primaryDocument: ["prgs-20260831.htm", "prgs-20260930.htm", "def14a.htm"], items: ["", "2.02,9.01", ""], reportDate: ["2026-08-31", "", ""] } } };
  const fetchImpl = fakeFetch([
    ["company_tickers.json", TICKERS],
    ["submissions/CIK0000876167.json", sub],
    ["companyfacts/CIK0000876167.json", FACTS],
  ]);
  const company = secMods.find((m) => m.id === "sec");
  const r = await runOsint({ name: "Dana Whitlock", company: "Progress Software" }, { outDir: tmp(), modules: [company], fetchImpl, log: quiet });
  const v = (id) => r.rows.filter((x) => x.var === id).map((x) => x.value);
  assert.match(v("co.filings")[0], /CIK 876167/);
  assert.ok(v("co.facts").some((x) => x.startsWith("Revenue $978M FY ending 2025-11-30 (+29.9% YoY)")));
  assert.ok(v("co.facts").some((x) => /2,801 employees/.test(x)));
  assert.match(v("co.quarter")[0], /\$246M .* -1\.6% YoY/);
  assert.match(v("co.cash")[0], /Cash \$114M/);

  const priv = await runOsint({ name: "Rick Kessler", company: "Harlow Industries" }, { outDir: tmp(), modules: [company], fetchImpl, log: quiet });
  assert.equal(priv.rows.length, 0);
  assert.ok(priv.misses.some((m) => m.var === "co.filings" && /not in SEC/.test(m.searched)));
});

test("estimates: ranges with inputs and formula, proxy pay wins over the band", async () => {
  assert.equal(seniorityOf("Executive Vice President, General Manager"), "evp");
  assert.equal(seniorityOf("President and CEO"), "c-suite-ceo");
  assert.equal(seniorityOf("VP of Operations"), "vp");
  const rows = estimates({ title: "VP of Operations", revenue: 100e6, revenueYoY: 0.1, employees: 400, jobs: 13, fiscalYearEnd: "1231" });
  const by = Object.fromEntries(rows.map((r) => [r.var, r]));
  assert.equal(by["est.team_size"].value, "108-252 people"); // 400 × operations span 0.45 × 0.6-1.4
  assert.equal(by["est.budget"].value, "$16.9M-$40.5M a year"); // 100M × 75% × 0.45 × 0.5-1.2
  assert.equal(by["est.deal_size"].value, "$16k-$80k first-year contract"); // 100M × 0.04% × 0.8 × 0.5-2.5
  assert.match(by["est.decision_window"].value, /^Budget planning Oct-Dec/);
  for (const r of rows) assert.ok(r.detail.formula && r.detail.inputs, r.var);
  const withProxy = estimates({ title: "EVP", revenue: 978e6, proxyComp: { year: 2025, total: 2.7e6 } });
  assert.match(withProxy.find((r) => r.var === "est.comp").value, /^\$2\.4M-\$3\.1M \(FY2025 proxy/);

  const r = await runOsint({ name: "X Y", company: "Z" }, { outDir: tmp(), modules: [estMod], fetchImpl: fakeFetch([]), log: quiet });
  assert.ok(r.rows.every((x) => x.tier === "D" && x.grade === "i" && x.tab === "estimates"));
});

// ---------------------------------------------------------------- fixes after the two reviews

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { nameForms, NICKNAMES, firstNameForms } from "../scripts/osint/core.mjs";
import { latestDebt, kpisFrom, titleFromBio, departureFrom, isCompanyPac, isParkedPage, bestTitle, titleFor, titleFromRemarks } from "../scripts/osint/colib.mjs";
import { revenueSplits, tableScale } from "../scripts/osint/modules/51-sec-docs.mjs";
import govMod, { fecKey } from "../scripts/osint/modules/54-gov.mjs";
import domainMods from "../scripts/osint/modules/55-domain.mjs";
import profileMods from "../scripts/osint/modules/56-profile.mjs";
import leadershipMod from "../scripts/osint/modules/52-leadership.mjs";
import { departureCheck } from "../scripts/osint/run.mjs";

const ZW = "​";
// Summary Compensation Table as two filing agents emit it: every cell padded with zero-width spaces
const SCT_ZW = `<p>Summary Compensation Table</p><table>
<tr><td>${ZW}Name and Principal Position${ZW}</td><td>${ZW}Year${ZW}</td><td>${ZW}Salary ($)${ZW}</td><td>${ZW}Stock Awards ($)${ZW}</td><td>${ZW}Total ($)${ZW}</td></tr>
<tr><td>${ZW}</td><td>${ZW}</td><td>${ZW}</td><td>${ZW}</td><td>${ZW}</td></tr>
<tr><td>J. M. Calder${ZW} Vice President and President, Engine Systems</td><td>${ZW}2025${ZW}</td><td>${ZW}$${ZW}</td><td>${ZW}780,000${ZW}</td><td>${ZW}3,100,000${ZW}</td><td>${ZW}5,612,300${ZW}</td></tr>
<tr><td>${ZW}</td><td>2024</td><td>${ZW}</td><td>760,000</td><td>3,400,000</td><td>6,104,880</td></tr>
<tr><td>K. Lee Chief Financial Officer</td><td>2025</td><td>900,000</td><td>4,000,000</td><td>7,000,000</td></tr></table>`;

test("parseSCT: zero-width cells parse, initials and nicknames match, title read from the label", () => {
  const s = parseSCT(SCT_ZW, { name: "Jenny Calder" });
  assert.equal(s.isNeo, true);
  assert.equal(s.years.length, 2);
  assert.equal(s.years[0].total, 5612300);
  assert.equal(s.years[1].total, 6104880);
  assert.equal(s.title, "Vice President and President, Engine Systems");
  assert.equal(parseSCT(SCT_ZW, "Jennifer Calder").years[0].year, 2025);
  // same surname, other initial: not her
  assert.equal(parseSCT(SCT_ZW, "Robert Lee").isNeo, false);
});

test("nicknames: formal and short forms both ways, aliases kept, table exported for the person modules", () => {
  assert.deepEqual(nameForms({ name: "Dan Holloway" }).slice(0, 2), ["Dan Holloway", "Daniel Holloway"]);
  assert.ok(nameForms({ name: "Daniel Holloway" }).includes("Dan Holloway"));
  assert.ok(nameForms({ name: "Jenny Calder" }).includes("Jennifer Calder"));
  for (const [short, formal] of [["Rick", "Richard"], ["Bob", "Robert"], ["Mike", "Michael"], ["Bill", "William"], ["Jim", "James"], ["Tom", "Thomas"], ["Chris", "Christopher"], ["Kate", "Katherine"], ["Liz", "Elizabeth"], ["Matt", "Matthew"], ["Tony", "Anthony"], ["Alex", "Alexander"]]) {
    assert.ok(nameForms({ name: `${short} Doe` }).includes(`${formal} Doe`), short);
  }
  assert.ok(["Steven", "Stephen"].every((f) => nameForms({ name: "Steve Ferrante" }).includes(`${f} Ferrante`)));
  assert.ok(nameForms({ name: "Dana Whitlock", aliases: ["Dana Smith"] }).includes("Dana Smith"));
  assert.ok(NICKNAMES.daniel.includes("dan"));
  assert.ok(firstNameForms("Jenny").includes("jennifer"));
});

test("segment tables: 'In millions' read as the scale, header row dropped, period kept", () => {
  const html = `<div>Consolidated Revenue The table below presents our consolidated net sales by country</div><table>
  <tr><td>Three months ended</td><td>Nine months ended</td></tr><tr><td>September 30,</td><td>September 30,</td></tr>
  <tr><td>In millions</td><td>2026</td><td>2025</td><td>2026</td><td>2025</td></tr>
  <tr><td>United States</td><td>$</td><td>5,427</td><td>$</td><td>4,663</td></tr><tr><td>China</td><td>974</td><td>844</td></tr>
  <tr><td>India</td><td>466</td><td>447</td></tr><tr><td>Total net sales</td><td>$</td><td>9,438</td><td>8,317</td></tr></table>`;
  const [s] = revenueSplits(html);
  assert.deepEqual(s.rows.map((r) => r.label), ["United States", "China", "India"]);
  assert.equal(s.rows[0].value, 5427e6);
  assert.equal(money(s.rows[0].value), "$5.43B");
  assert.match(s.period, /Three months ended September 30 2026/);
  assert.equal(s.scaleGuessed, false);
  assert.equal(tableScale(`<p>(in thousands, except per share data)</p>`, 40, []).scale, 1e3);
  assert.equal(tableScale("<p>nothing here</p>", 18, []).guessed, true);
});

test("XBRL: each concept read to its latest period; annual and quarter revenue picked apart; stale debt never stamped current", () => {
  const f = {
    facts: {
      "us-gaap": {
        Revenues: { units: { USD: [fact("2024-01-01", "2024-12-31", 34.1e9), fact("2025-01-01", "2025-12-31", 33.67e9)] } },
        RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [fact("2025-07-01", "2025-09-30", 8.317e9, "Q3", "10-Q"), fact("2026-07-01", "2026-09-30", 9.438e9, "Q3", "10-Q")] } },
        LongTermDebtNoncurrent: { units: { USD: [{ end: "2020-12-31", val: 110e6, filed: "2021-02-20" }] } },
        SeniorLongTermNotes: { units: { USD: [{ end: "2025-12-31", val: 490e6, filed: "2026-02-20" }, { end: "2026-09-30", val: 491.8e6, filed: "2026-11-01" }] } },
      },
    },
  };
  const r = pickRevenue(f);
  assert.equal(r.annual.val, 33.67e9);
  assert.equal(r.annualConcept, "Revenues");
  assert.equal(r.quarter.val, 9.438e9);
  assert.equal(r.quarterConcept, "RevenueFromContractWithCustomerExcludingAssessedTax");
  assert.ok(Math.abs(r.quarterYoY - (9.438 / 8.317 - 1)) < 1e-9);
  const d = latestDebt(f);
  assert.equal(d.val, 491.8e6);
  assert.equal(d.end, "2026-09-30");
});

test("sec module: debt from a concept last used years ago is reported stale, with its own date", async () => {
  const sub = { name: "SENTRYLINK HOLDINGS, INC.", sic: "7372", sicDescription: "Services-Prepackaged Software", fiscalYearEnd: "1231", addresses: { business: { city: "TYSONS", stateOrCountry: "VA" } }, filings: { recent: { form: ["10-Q"], filingDate: ["2026-11-01"], accessionNumber: ["0001459200-26-000019"], primaryDocument: ["alrm-20260930.htm"], items: [""], reportDate: ["2026-09-30"] } } };
  const facts = { facts: { "us-gaap": { CashAndCashEquivalentsAtCarryingValue: { units: { USD: [{ end: "2026-09-30", val: 534.7e6, filed: "2026-11-01" }] } }, LongTermDebtNoncurrent: { units: { USD: [{ end: "2020-12-31", val: 110e6, filed: "2021-02-20" }] } } } } };
  const fetchImpl = fakeFetch([["company_tickers.json", { 0: { cik_str: 1459200, ticker: "ALRM", title: "Sentrylink Holdings, Inc." } }], ["submissions/CIK0001459200.json", sub], ["companyfacts/CIK0001459200.json", facts]]);
  const r = await runOsint({ name: "Dan Holloway", company: "Sentrylink" }, { outDir: tmp(), modules: [secMods.find((m) => m.id === "sec")], fetchImpl, log: quiet });
  const cash = r.rows.find((x) => x.var === "co.cash").value;
  assert.match(cash, /^Cash \$535M at 2026-09-30; newest debt figure in XBRL is \$110M at 2020-12-31 \(stale/);
  assert.ok(!/debt \$110M at 2026/.test(cash));
  assert.match(r.rows.find((x) => x.var === "co.filings").value, /business address Tysons, VA/);
});

test("KPIs: a customer count needs KPI phrasing; free cash flow carries its period", () => {
  assert.deepEqual(kpisFrom("The road show gave more than 500 customers and dealers the opportunity to see the X15 engine."), []);
  assert.deepEqual(kpisFrom("Over 1,000 customers attended the event."), []);
  assert.equal(kpisFrom("We ended the quarter with 12,400 customers, up 9%.")[0].value, "12,400");
  assert.equal(kpisFrom("Free cash flow for the nine months ended September 30, 2026 was $156.3 million.")[0].value, "$156.3 million (nine months ended September 30, 2026)");
});

const FORM4_REMARKS = FORM4.replace("<officerTitle>EVP/GM Digital Experience</officerTitle>", "<officerTitle>See Remarks</officerTitle>").replace("</ownershipDocument>", "<remarks>President, Platforms Business</remarks></ownershipDocument>");

test("Form 4: 'See Remarks' is never a title; the remarks text is read instead", () => {
  const p = parseForm4(FORM4_REMARKS);
  assert.equal(p.officerTitle, "See Remarks");
  assert.equal(p.title, "President, Platforms Business");
  assert.equal(titleFromRemarks("Exhibit 24 - Power of Attorney"), null);
  assert.equal(parseForm4(FORM4_REMARKS.replace("<remarks>President, Platforms Business</remarks>", "")).title, null);
});

test("titles: proxy or leadership page beats Form 4 beats --title beats search", () => {
  const t = bestTitle([{ title: "Senior Leader", source: "search" }, { title: "VP & Pres. - Engine Systems", source: "form4", ref: "L-0003" }, { title: "See Remarks", source: "form4" }, { title: "Vice President and President, Engine Systems", source: "proxy", ref: "L-0009" }]);
  assert.equal(t.title, "Vice President and President, Engine Systems");
  assert.equal(titleFor({ titles: [{ title: "VP & Pres. - Engine Systems", source: "form4" }] }, { title: "Director" }).title, "VP & Pres. - Engine Systems");
  assert.equal(titleFor({}, { title: "VP Operations" }).source, "given");
});

const PROXY = `<html><body><p>Executive Officers</p><p>Name Position(s) Stephen Trundle Chief Executive Officer Kevin Bradley Chief Financial Officer Daniel Holloway President, Platforms Business</p>
<p>Kevin Bradley , age 41, has served as our Chief Financial Officer since March 2025. Mr. Bradley joined us in May 2009 and previously served in various finance roles. Mr. Bradley holds a B.B.A. from the University of Notre Dame.</p>
<p>Daniel Holloway , age 50, has served as our President, Platforms Business since January 2023. He previously served as Chief Product Officer from December 2013 to January 2023. Prior to joining us, Mr. Holloway served as the Chief Executive Officer of Emotive Communications Inc., a software company. Mr. Holloway holds a B.A. in Computer Engineering from Dartmouth College and an M.B.A. from The Wharton School.</p>
<p>Daniel Ramos , age 57, has served as our Chief Legal and Compliance Officer since January 2023. He previously served as our Senior Vice President of Corporate Development.</p>
<p>In the fourth quarter of 2025, our CEO recommended to the TMCC, and the TMCC approved, a determination that Mr. Holloway earned the 2025 grant of performance-based restricted stock units in full.</p>
<p>Summary Compensation Table</p><table><tr><td>Name and Principal Position</td><td>Year</td><td>Salary ($)</td><td>Total ($)</td></tr>
<tr><td>${ZW}Daniel Holloway${ZW}</td><td>${ZW}2025${ZW}</td><td>${ZW}438,500${ZW}</td><td>${ZW}2,325,341${ZW}</td></tr>
<tr><td>President, Platforms Business</td><td></td><td></td><td></td></tr></table></body></html>`;

test("bio: stops at the next officer, ignores pay prose; education needs a degree or a school", () => {
  const text = PROXY.replace(/<[^>]+>/g, " ");
  const bio = bioFrom(text, { name: "Dan Holloway" });
  assert.match(bio, /^Daniel Holloway , age 50/);
  assert.ok(!/Bradley|Ramos|Notre Dame|TMCC/.test(bio), bio);
  assert.deepEqual(educationFrom(bio), ["Mr. Holloway holds a B.A. in Computer Engineering from Dartmouth College and an M.B.A. from The Wharton School."]);
  assert.deepEqual(educationFrom("In the fourth quarter of 2025, our CEO recommended to the TMCC, and the TMCC approved, a determination that Ms. Calder earned the 2025 grant in full."), []);
});

test("titles cut from bios keep 'of' and commas", () => {
  assert.equal(titleFromBio("Tim Shannon currently serves as Senior Vice President, Global Commercial. He joined in 2019."), "Senior Vice President, Global Commercial");
  assert.equal(titleFromBio("Cheryl holds the position of Senior Director of Human Resources at Harlow."), "Senior Director of Human Resources");
  assert.equal(titleFromBio("He serves as Chief Financial Officer."), "Chief Financial Officer");
});

test("sec-person: a nickname finds the formal-name filer, See Remarks resolved, proxy pay, clean bio, old 8-K filed as history", async () => {
  const sub = { name: "SENTRYLINK HOLDINGS, INC.", sic: "7372", fiscalYearEnd: "1231", filings: { recent: { form: ["DEF 14A"], filingDate: ["2026-04-20"], accessionNumber: ["0001104659-26-047867"], primaryDocument: ["def14a.htm"], items: [""], reportDate: [""] } } };
  const efts = { hits: { hits: [
    { _id: "0001193125-26-245330:ownership.xml", _source: { ciks: ["0001459200", "0001642717"], display_names: ["Holloway Daniel  (CIK 0001642717)", "Sentrylink Holdings, Inc.  (ALRM)  (CIK 0001459200)"], root_forms: ["4"], form: "4", file_date: "2026-10-01" } },
    { _id: "0000950103-19-000740:dp8k.htm", _source: { ciks: ["0001459200"], display_names: ["Sentrylink Holdings, Inc.  (ALRM)  (CIK 0001459200)"], root_forms: ["8-K"], form: "8-K", file_date: "2019-01-10" } },
  ] } };
  const owner = { filings: { recent: { form: ["4"], filingDate: ["2026-10-01"], accessionNumber: ["0001193125-26-245330"], primaryDocument: ["xslF345X05/ownership.xml"] } } };
  const fetchImpl = fakeFetch([
    ["company_tickers.json", { 0: { cik_str: 1459200, ticker: "ALRM", title: "Sentrylink Holdings, Inc." } }],
    ["submissions/CIK0001459200.json", sub],
    ["submissions/CIK0001642717.json", owner],
    ["Daniel%20Holloway", efts],
    ["ownership.xml", FORM4_REMARKS.replace("0000876167", "0001459200")],
    ["def14a.htm", PROXY],
    ["dp8k.htm", "<p>Item 5.02. On January 8, 2019, the Board appointed Daniel Holloway as Chief Product Officer of the Company.</p>"],
  ]);
  const person = secMods.find((m) => m.id === "sec-person");
  const r = await runOsint({ name: "Dan Holloway", company: "Sentrylink", title: "Product leader" }, { outDir: tmp(), modules: [person, estMod], fetchImpl, log: quiet });
  const v = (id) => r.rows.filter((x) => x.var === id);
  assert.ok(fetchImpl.calls.some((c) => c.url.includes("efts") && decodeURIComponent(c.url).includes('"Dan Holloway" OR "Daniel Holloway"')));
  assert.equal(v("role.title")[0].value, "President, Platforms Business");
  assert.ok(!r.rows.some((x) => /see remarks/i.test(String(x.value))));
  assert.match(v("money.comp")[0].value, /^FY2025 total \$2\.3M/);
  assert.ok(v("career.education").every((x) => !/Notre Dame/.test(x.value)));
  assert.ok(v("role.start").every((x) => !/May 2009/.test(x.value)), "Bradley's start date must not be his");
  assert.ok(!v("co.exec_changes").length, "a 2019 appointment is not a change in the last 24 months");
  assert.ok(v("career.timeline").some((x) => x.value.startsWith("2019-01-10")));
  assert.equal(v("money.holdings")[0].value.includes("after 2026-10-21"), true, "trade date, not filing date");
  // estimates take the proxy pay and the strongest title, and cite ledger ids
  const comp = v("est.comp")[0];
  assert.match(comp.value, /FY2025 proxy total \$2\.3M/);
  assert.ok(comp.detail.ledgerIds.includes(v("money.comp")[0].id));
  const team = v("est.team_size")[0];
  assert.ok(!team || !/Individual contributor/.test(team.value));
});

test("estimates: segment president is not an IC; no pay guess without a title; stale headcount drives nothing", () => {
  assert.equal(seniorityOf("Vice President and President, Engine Systems"), "evp");
  assert.equal(seniorityOf("President, Platforms Business"), "evp");
  assert.equal(seniorityOf("VP & Pres. - Engine Systems"), "evp");
  const seg = estimates({ title: "Vice President and President, Engine Systems", revenue: 33.67e9, employees: 69600 });
  assert.match(seg.find((r) => r.var === "est.comp").value, /^\$4\.0M-\$10\.0M/);
  const none = estimates({ employees: 41, employeesSource: "Form 5500 participants 2021 (stale)", jobs: 24 });
  assert.ok(!none.some((r) => r.var === "est.comp"), "no title, no proxy: no pay estimate");
  assert.ok(!none.some((r) => r.var === "est.seg_growth"), "no growth from a 2021 headcount");
  assert.ok(!none.some((r) => r.var === "est.deal_size"));
  const ops = estimates({ title: "VP of Operations", employees: 260, employeesSource: "Form 5500 participants 2025", refs: { title: "L-0007", employees: "L-0002" } });
  const team = ops.find((r) => r.var === "est.team_size");
  assert.equal(team.value, "70-164 people"); // 260 × operations span 0.45 × 0.6-1.4
  assert.deepEqual(team.detail.ledgerIds, ["L-0007", "L-0002"]);
  assert.match(team.detail.inputs.employees, /\(L-0002\)$/);
});

test("departures: former / quits / joins / hired-by read as left; own-company appointments and bios do not", () => {
  const S = { name: "Steve Ferrante", company: "Lumen Arcade" };
  assert.equal(departureFrom("Former Lumen Arcade VP Steve Ferrante appointed chief business officer at Kestrel Studios", S).newCompany, "Kestrel Studios");
  assert.equal(departureFrom("Steve Ferrante leaves Lumen Arcade to join Kestrel Studios", S).newCompany, "Kestrel Studios");
  assert.equal(departureFrom("Kestrel Studios appoints Steve Ferrante as chief business officer", S).newCompany, "Kestrel Studios");
  assert.ok(departureFrom("Mr. Ferrante will step down from his role effective March 1, 2026.", S));
  assert.equal(departureFrom("Lumen Arcade appoints Steve Ferrante as GM of the Lumen Arcade Store", S), null);
  assert.equal(departureFrom("Steve Ferrante, who succeeds John Smith, who retired", S), null);
  const J = { name: "Jennifer Calder", company: "Halvorsen" };
  assert.equal(departureFrom("Jennifer Calder named President of Engine Systems", J), null);
  assert.equal(departureFrom("Prior to joining Halvorsen, Ms. Calder joined Caterpillar in 1999.", J), null);
  const rows = [{ id: "L-0040", module: "company-news", var: "news.company", value: "Former Lumen Arcade VP Steve Ferrante appointed chief business officer at Kestrel Studios (gamesindustry.biz)", grade: "p", date: "2026-06-02", url: "https://example.com/a" }, { id: "L-0041", module: "search", var: "news.articles", value: "Steve Ferrante joins Acme Bank", grade: "w" }];
  const shared = {};
  const d = departureCheck(S, rows, shared);
  assert.equal(d.alerts[0].level, "warn");
  assert.match(d.alerts[0].text, /may have left Lumen Arcade \(2026-06-02\) and joined Kestrel Studios/);
  assert.equal(shared.departed.newCompany, "Kestrel Studios");
  assert.equal(d.departures.length, 1, "an unanchored namesake headline is ignored");
});

test("run: departure becomes a role.title row graded p and a top-level alert", async () => {
  const news = { id: "fake-news", lane: "fast", async run(ctx) { ctx.add({ var: "news.company", value: "Steve Ferrante leaves Lumen Arcade to join Kestrel Studios", url: "https://example.com/n", grade: "p", date: "2026-06-02" }); } };
  const r = await runOsint({ name: "Steve Ferrante", company: "Lumen Arcade" }, { outDir: tmp(), modules: [news, estMod], fetchImpl: fakeFetch([]), log: quiet });
  const row = r.rows.find((x) => x.module === "departure");
  assert.equal(row.var, "role.title");
  assert.equal(row.grade, "p");
  assert.equal(row.value, "Left Lumen Arcade (2026-06-02) → Kestrel Studios");
  assert.deepEqual(Object.keys(r.alerts[0]).sort(), ["level", "module", "text", "url"]);
  assert.equal(r.alerts[0].url, "https://example.com/n");
  assert.equal(r.departed.newCompany, "Kestrel Studios");
});

test("leadership: a site that answers 403 everywhere is 'blocked', not 'no page'; module status blocked", async () => {
  const fetchImpl = fakeFetch([["halvorsen.com", "Access Denied", 403]]);
  const r = await runOsint({ name: "Jennifer Calder", company: "Halvorsen", domain: "halvorsen.com" }, { outDir: tmp(), modules: [leadershipMod], fetchImpl, log: quiet });
  const m = r.misses.find((x) => x.var === "co.leadership");
  assert.match(m.searched, /^blocked \(HTTP 403 on \d+ of \d+ paths\)/);
  assert.equal(r.modules[0].status, "blocked");
  assert.match(r.misses.find((x) => x.var === "news.company").searched, /blocked/);
});

test("gov: USAspending pages through every page; PACs need the company as the connected organisation; FEC 429 is unknown", async () => {
  const award = (i, name) => ({ "Award ID": `A${i}`, "Recipient Name": name, "Award Amount": 1000 + i, "Awarding Agency": "Department of Defense", "Start Date": `2025-01-${String((i % 28) + 1).padStart(2, "0")}`, Description: "x", generated_internal_id: `g${i}` });
  const page1 = { results: [...Array.from({ length: 82 }, (_, i) => award(i, "PROGRESS SOFTWARE CORPORATION")), ...Array.from({ length: 18 }, (_, i) => award(100 + i, "TELERIK INC"))], page_metadata: { hasNext: true } };
  const page2 = { results: Array.from({ length: 25 }, (_, i) => award(200 + i, "PROGRESS SOFTWARE CORPORATION")), page_metadata: { hasNext: false } };
  let n = 0;
  const base = fakeFetch([["lda.gov", { count: 0, results: [] }], ["api.open.fec.gov", { message: "OVER_RATE_LIMIT" }, 429]]);
  const fetchImpl = async (url, opts = {}) => (url.includes("usaspending") ? new Response(JSON.stringify(++n === 1 ? page1 : page2), { status: 200 }) : base(url, opts));
  const r = await runOsint({ name: "Dana Whitlock", company: "Progress Software" }, { outDir: tmp(), modules: [govMod], fetchImpl, log: quiet });
  const g = r.rows.filter((x) => x.var === "co.gov");
  assert.match(g[0].value, /^107 federal contract awards/);
  assert.deepEqual(g[0].detail.relatedRecipients, ["TELERIK INC"]);
  assert.equal(n, 2);
  assert.match(r.misses.find((x) => x.var === "politics.company_pac").searched, /429.*unknown, not checked/);
  assert.equal(r.modules[0].status, "blocked");
  assert.equal(fecKey({}), "DEMO_KEY");
  assert.equal(fecKey({ FEC_API_KEY: "k" }), "k");
  assert.ok(!base.calls.some((c) => c.url.includes("www.fec.gov")), "no key scraped from fec.gov pages");
  assert.equal(isCompanyPac({ name: "HALVORSEN INC. POLITICAL ACTION COMMITTEE", committee_type: "Q" }, "Halvorsen"), true);
  for (const name of ["BUD HALVORSEN CAMPAIGN", "HALVORSEN FOR CONGRESS", "HALVORSEN-FERRANTE CORP EMPLOYEES FOR GOOD GOVERNMENT"]) assert.equal(isCompanyPac({ name, committee_type: "Q" }, "Halvorsen"), false, name);
  assert.equal(isCompanyPac({ name: "GOOD GOVERNMENT FUND", committee_type: "Q", affiliated_committee_name: "HALVORSEN INC" }, "Halvorsen"), true);
  assert.equal(isCompanyPac({ name: "HALVORSEN PAC", committee_type: "Q", affiliated_committee_name: "HALVORSEN-FERRANTE CORP" }, "Halvorsen"), false);
});

test("wayback: only status-200 captures, parked and for-sale pages skipped", async () => {
  const cdx = [["timestamp", "original"], ["20110128000000", "http://plumerialabs.com/"], ["20130419000000", "http://www.plumerialabs.com/"]];
  const fetchImpl = fakeFetch([["cdx/search/cdx", cdx], ["20110128000000id_", "<html><body>plumerialabs.com is for sale! HugeDomains.com - buy this domain</body></html>"], ["20130419000000id_", "<html><body><h1>Plumeria Labs</h1><p>Product management for teams that build what customers need.</p></body></html>"]]);
  const wb = domainMods.find((m) => m.id === "wayback");
  const r = await runOsint({ name: "X Y", company: "Plumeria Labs", domain: "plumerialabs.com" }, { outDir: tmp(), modules: [wb], fetchImpl, log: quiet });
  assert.ok(fetchImpl.calls[0].url.includes("filter=statuscode:200"));
  assert.match(r.rows[0].value, /first served a page in the web archive on 2013-04-19 \(1 earlier parked/);
  assert.equal(isParkedPage("<html><body>Welcome to Acme, makers of tubing since 1954. Our products and services for industry.</body></html>"), false);
});

test("wikidata: never 'verified', deprecated values dropped, SEC address preferred for HQ", async () => {
  const ent = { id: "Q1", labels: { en: { value: "Lumen Arcade" } }, descriptions: { en: { value: "American video game company" } }, claims: { P856: [{ rank: "normal", mainsnak: { datavalue: { value: "https://www.lumenarcade.com" } } }], P571: [{ rank: "normal", mainsnak: { datavalue: { value: { time: "+1991-00-00T00:00:00Z" } } } }], P159: [{ rank: "preferred", mainsnak: { datavalue: { value: { id: "Q2" } } } }, { rank: "normal", mainsnak: { datavalue: { value: { id: "Q3" } } } }, { rank: "deprecated", mainsnak: { datavalue: { value: { id: "Q4" } } } }] } };
  const fetchImpl = fakeFetch([["company_tickers.json", {}], ["wbsearchentities", { search: [{ id: "Q1" }] }], ["ids=Q1&", { entities: { Q1: ent } }], ["wbgetentities", { entities: { Q2: { labels: { en: { value: "Cary" } } }, Q3: { labels: { en: { value: "North Carolina" } } }, Q4: { labels: { en: { value: "Rockville" } } } } }]]);
  const wd = profileMods.find((m) => m.id === "wikidata");
  const r = await runOsint({ name: "Steve Ferrante", company: "Lumen Arcade", domain: "lumenarcade.com" }, { outDir: tmp(), modules: [wd], fetchImpl, log: quiet });
  const row = r.rows.find((x) => x.var === "co.facts");
  assert.equal(row.grade, "p");
  assert.match(row.value, /hq Cary \(Wikidata\)/);
  assert.ok(!/Rockville|North Carolina/.test(row.value));
});

test("output folder: a different subject moves the old folder aside, never mixing ledgers", async () => {
  const dir = tmp();
  const out = join(dir, "run");
  const one = { id: "one", lane: "fast", async run(ctx) { ctx.add({ var: "co.facts", value: `about ${ctx.subject.name}`, grade: "v" }); } };
  await runOsint({ name: "Dan Holloway", company: "Sentrylink" }, { outDir: out, modules: [one], fetchImpl: fakeFetch([]), log: quiet });
  const notes = [];
  const r = await runOsint({ name: "Jenny Calder", company: "Halvorsen" }, { outDir: out, modules: [one], fetchImpl: fakeFetch([]), log: (s) => notes.push(s) });
  assert.deepEqual(r.rows.map((x) => x.value), ["about Jenny Calder"]);
  const moved = readdirSync(dir).filter((f) => f.startsWith("run.prev-"));
  assert.equal(moved.length, 1);
  assert.match(readFileSync(join(dir, moved[0], "ledger.jsonl"), "utf8"), /about Dan Holloway/);
  assert.match(notes.join("\n"), /moved it to/);
  // same subject again: old rows retired (backup kept), not duplicated
  const r2 = await runOsint({ name: "Jenny Calder", company: "Halvorsen" }, { outDir: out, modules: [one], fetchImpl: fakeFetch([]), log: quiet });
  assert.equal(r2.rows.length, 1);
  assert.ok(readdirSync(out).some((f) => /^ledger\..+\.jsonl$/.test(f)));
  assert.ok(existsSync(join(out, "osint.json")));
});
