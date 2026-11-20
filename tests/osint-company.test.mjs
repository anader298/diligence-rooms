// Company-side OSINT modules. No network: helpers get inline fixtures, and the modules run
// through runOsint with a fake fetch that answers by URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOsint } from "../scripts/osint/run.mjs";
import { matchCompany, pickRevenue, parseForm4, parseJobs, parseSCT, estimates, bioFrom, educationFrom, parseLeadership, paylocityPageData, stripBoilerplate, seniorityOf } from "../scripts/osint/colib.mjs";
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
  assert.equal(by["est.team_size"].value, "19-45 people"); // 400 × 0.08 × 0.6-1.4
  assert.equal(by["est.budget"].value, "$3.0M-$7.2M a year"); // 100M × 75% × 0.08 × 0.5-1.2
  assert.equal(by["est.deal_size"].value, "$16k-$80k first-year contract"); // 100M × 0.04% × 0.8 × 0.5-2.5
  assert.match(by["est.decision_window"].value, /^Budget planning Oct-Dec/);
  for (const r of rows) assert.ok(r.detail.formula && r.detail.inputs, r.var);
  const withProxy = estimates({ title: "EVP", revenue: 978e6, proxyComp: { year: 2025, total: 2.7e6 } });
  assert.match(withProxy.find((r) => r.var === "est.comp").value, /^\$2\.4M-\$3\.1M \(FY2025 proxy/);

  const r = await runOsint({ name: "X Y", company: "Z" }, { outDir: tmp(), modules: [estMod], fetchImpl: fakeFetch([]), log: quiet });
  assert.ok(r.rows.every((x) => x.tier === "D" && x.grade === "i" && x.tab === "estimates"));
});
