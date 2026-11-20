// Part 2 company and records modules, offline. Company fixtures are trimmed recordings of live
// public endpoints (tests/fixtures/osint-part2/company/, 20 Nov 2026); person-level records are
// synthetic (Jane Doe at Acme Robotics). Every call goes to a fake fetch routed by URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runOsint } from "../scripts/osint/run.mjs";
import registries, { leiBrief } from "../scripts/osint/modules/61-registries.mjs";
import intl, { parseFrance, parseNorway, parseNorwayRoles, parseCzechVr, parseUkOfficers, officerIsSubject } from "../scripts/osint/modules/62-intl-registries.mjs";
import frames, { parseSicAtom, mergeFrames, standing } from "../scripts/osint/modules/63-sec-frames.mjs";
import broker, { matchHits, parseDetail, hitNamesSubject } from "../scripts/osint/modules/64-brokercheck.mjs";
import licenses, { matchRecords, sources } from "../scripts/osint/modules/65-licenses.mjs";
import bankCu, { bankReason, coreName, pickFdic } from "../scripts/osint/modules/66-bank-cu.mjs";
import csl, { compact, screenPerson, screenCompany } from "../scripts/osint/modules/67-sanctions-csl.mjs";
import lobbying, { matchLobbyists, matchFara } from "../scripts/osint/modules/68-lobbying-fara.mjs";
import domainIntel, { parseRdap, dnsHost } from "../scripts/osint/modules/69-domain-intel.mjs";
import enforcement, { companyFacilities, summarize } from "../scripts/osint/modules/70-enforcement.mjs";
import patents, { odpApplications } from "../scripts/osint/modules/20-patents.mjs";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "osint-part2", "company");
const fx = (n) => JSON.parse(readFileSync(join(FIX, `${n}.json`), "utf8"));
const JANE = { name: "Jane Doe", company: "Acme Robotics", domain: "acmerobotics.com", city: "Austin", state: "TX", handles: [], aliases: [] };

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push(url);
    for (const [re, h] of routes) {
      if (re.test(url)) {
        const r = typeof h === "function" ? h(url, init) : h;
        const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
        return new Response(body, { status: r.status || 200, headers: r.headers || {} });
      }
    }
    return new Response("not found", { status: 404 });
  };
  fn.calls = calls;
  return fn;
}
const run = (subject, modules, fetchImpl) => runOsint(subject, { outDir: mkdtempSync(join(tmpdir(), "osint-p2co-")), modules, fetchImpl, log: () => {} });
const rowsOf = (res, mod) => res.rows.filter((r) => r.module === mod);
// SEC: not a registrant (empty tickers file) unless a test says otherwise
const NO_SEC = [/sec\.gov\/files\/company_tickers/, { body: {} }];
const NO_WD = [/wikidata\.org/, { body: { search: [] } }];

// ------------------------------------------------------------------ registries

test("registries: GLEIF parent 404 means top of group; children listed with countries", async () => {
  const f = fakeFetch([
    NO_SEC,
    NO_WD,
    [/lei-records\?filter/, { body: fx("gleif-danone-records") }],
    [/direct-children/, { body: fx("gleif-danone-children") }],
    [/(direct|ultimate)-parent/, { status: 404, body: { errors: [{ status: "404" }] } }],
  ]);
  const res = await run({ name: "Jane Doe", company: "Danone" }, [registries], f);
  const rows = rowsOf(res, "registries");
  assert.ok(rows.some((r) => /reports no parent/.test(r.value)));
  const kids = rows.find((r) => r.detail?.relation === "direct-children");
  assert.ok(kids, "children row");
  assert.match(kids.value, /direct subsidiar/);
  assert.equal(kids.grade, "v");
  assert.equal(leiBrief(null), null);
});

test("registries: no LEI is a miss, not an error", async () => {
  const f = fakeFetch([NO_SEC, NO_WD, [/lei-records\?filter/, { body: { data: [] } }]]);
  const res = await run({ name: "Jane Doe", company: "Nowhere Widgets" }, [registries], f);
  assert.equal(res.modules[0].status, "ok");
  assert.ok(res.misses.some((m) => m.var === "co.structure" && /no LEI/.test(m.searched)));
});

// ------------------------------------------------------------------ intl-registries

test("intl-registries: France picks the entity, lists dirigeants, and names the subject's role", async () => {
  const fr = fx("fr-danone");
  const ceo = fr.results[0].dirigeants.find((d) => d.type_dirigeant === "personne physique");
  const subject = { name: `${ceo.prenoms} ${ceo.nom}`, company: "Danone", country: "FR" };
  const f = fakeFetch([NO_SEC, NO_WD, [/lei-records/, { body: { data: [] } }], [/recherche-entreprises/, { body: fr }]]);
  const res = await run(subject, [intl], f);
  const rows = rowsOf(res, "intl-registries");
  const reg = rows.find((r) => r.var === "co.registry");
  assert.match(reg.value, /SIREN 552032534/);
  assert.match(reg.value, /revenue/);
  assert.ok(rows.some((r) => r.var === "co.leadership"));
  const role = rows.find((r) => r.var === "role.title");
  assert.ok(role, "role row for the subject");
  assert.equal(role.grade, "v");
  assert.ok(parseFrance(fr, ["Danone"]).officers.length >= 1);
});

test("intl-registries: Norway entity and roles; role group date is not a start date", () => {
  const e = parseNorway(fx("no-equinor"), ["Equinor ASA"]);
  assert.equal(e.orgnr, "923609016");
  const roles = parseNorwayRoles(fx("no-equinor-roller"));
  assert.ok(roles.length >= 1);
  assert.ok(roles.every((r) => !("since" in r)));
  assert.ok(officerIsSubject(roles[0], { name: `${roles[0].first} ${roles[0].last}` }));
});

test("intl-registries: Czech register keeps current members and marks former ones with their end date", () => {
  const vr = {
    zaznamy: [
      {
        primarniZaznam: true,
        statutarniOrgany: [
          {
            nazevOrganu: "Statutární orgán - představenstvo",
            clenoveOrganu: [
              { datumZapisu: "2022-08-05", datumVymazu: "2022-08-05", clenstvi: { funkce: { nazev: "předseda představenstva", vznikFunkce: "2022-07-01" } }, fyzickaOsoba: { jmeno: "JANE", prijmeni: "DOE" } },
              { datumZapisu: "2022-08-05", datumVymazu: "2026-10-12", clenstvi: { clenstvi: { vznikClenstvi: "2022-07-01", zanikClenstvi: "2026-09-21" }, funkce: { nazev: "předseda představenstva" } }, fyzickaOsoba: { jmeno: "JANE", prijmeni: "DOE" } },
              { datumZapisu: "2024-03-01", clenstvi: { clenstvi: { vznikClenstvi: "2024-03-01" }, funkce: { nazev: "člen představenstva" } }, fyzickaOsoba: { jmeno: "JOHN", prijmeni: "ROE" } },
            ],
          },
        ],
      },
    ],
  };
  const o = parseCzechVr(vr);
  assert.equal(o.length, 2, "superseded copy dropped");
  const jane = o.find((x) => x.last === "Doe");
  assert.equal(jane.former, true);
  assert.equal(jane.until, "2026-09-21");
  assert.ok(!o.find((x) => x.last === "Roe").former);
});

test("intl-registries: UK needs a key; with one, officers parse from Companies House", async () => {
  const f = fakeFetch([NO_SEC, NO_WD, [/lei-records/, { body: { data: [] } }]]);
  const res = await run({ name: "Jane Doe", company: "Acme Robotics Ltd", country: "UK" }, [intl], f);
  assert.ok(res.misses.some((m) => /COMPANIES_HOUSE_API_KEY/.test(m.searched)));
  const of = parseUkOfficers({ items: [{ name: "DOE, Jane Mary", officer_role: "director", appointed_on: "2020-01-01" }, { name: "ROE, John", officer_role: "secretary", resigned_on: "2021-01-01" }] });
  assert.deepEqual(of.map((x) => [x.first, x.last]), [["Jane Mary", "Doe"]]);
  assert.ok(officerIsSubject(of[0], JANE));
});

test("intl-registries: a country without a wired register is a miss", async () => {
  const f = fakeFetch([NO_SEC, NO_WD, [/lei-records/, { body: { data: [] } }]]);
  const res = await run({ name: "Jane Doe", company: "Acme", country: "BR" }, [intl], f);
  assert.ok(res.misses.some((m) => /no free company-register API wired for country BR/.test(m.searched)));
});

// ------------------------------------------------------------------ sec-frames

const ATOM = (rows) => `<?xml version="1.0"?><feed>${rows.map(([cik, name]) => `<entry><content><company-info><cik>${String(cik).padStart(10, "0")}</cik><name>${name}</name></company-info></content></entry>`).join("")}</feed>`;

test("sec-frames: rank, median and nearest peers from frames joined to the SIC list", async () => {
  const peers = [[1, "ACME ROBOTICS INC"], [2, "BIG BOTS CORP"], [3, "SMALL BOTS INC"], [4, "MID BOTS INC"], [5, "OTHER CO"]];
  const fr = (vals) => ({ data: vals.map(([cik, val, name]) => ({ cik, val, entityName: name, end: "2025-12-31" })) });
  const f = fakeFetch([
    [/company_tickers/, { body: { 0: { cik_str: 1, ticker: "ACME", title: "Acme Robotics Inc" } } }],
    [/submissions\/CIK0000000001/, { body: { name: "ACME ROBOTICS INC", sic: "3569", sicDescription: "General Industrial Machinery", filings: { recent: { form: [], filingDate: [], accessionNumber: [], primaryDocument: [] } } } }],
    [/browse-edgar.*SIC=3569.*start=0&/, { body: ATOM(peers) }],
    [/browse-edgar/, { body: ATOM([]) }],
    [/frames\/us-gaap\/Revenues\//, { body: fr([[1, 500e6, "ACME"], [2, 2e9, "BIG BOTS"], [3, 50e6, "SMALL BOTS"], [4, 400e6, "MID BOTS"], [99, 9e9, "NOT A PEER"]]) }],
    [/frames\/us-gaap\/RevenueFromContract/, { body: { data: [] } }],
    [/frames\/us-gaap\/NetIncomeLoss/, { body: fr([[1, 50e6, "ACME"], [2, 100e6, "BIG"], [3, -5e6, "SMALL"], [4, 20e6, "MID"]]) }],
    [/frames\/us-gaap\/Assets/, { body: fr([[1, 1e9, "ACME"], [2, 5e9, "BIG"]]) }],
  ]);
  const res = await run({ name: "Jane Doe", company: "Acme Robotics" }, [frames], f);
  const rows = rowsOf(res, "sec-frames");
  const rev = rows.find((r) => r.detail.measure === "revenue");
  assert.equal(rev.detail.rank, 2);
  assert.equal(rev.detail.n, 4, "the non-peer filer is excluded");
  assert.equal(rev.detail.nearest[0].name, "MID BOTS");
  assert.ok(rows.find((r) => r.detail.measure === "net income").detail.margin > 0.09);
  assert.ok(!rows.find((r) => r.detail.measure === "assets"), "fewer than 3 peers report assets: no row");
  assert.deepEqual(parseSicAtom(ATOM([[7, "X &amp; Y"]])), [{ cik: 7, name: "X & Y" }]);
  assert.equal(mergeFrames({ data: [{ cik: 1, val: 1 }] }, { data: [{ cik: 1, val: 5 }] }).get(1).val, 5);
  assert.equal(standing(1, new Set([1, 2]), mergeFrames({ data: [{ cik: 1, val: 1 }, { cik: 2, val: 2 }] })), null);
});

test("sec-frames: a private company is a miss", async () => {
  const res = await run({ name: "Jane Doe", company: "Acme Robotics" }, [frames], fakeFetch([NO_SEC]));
  assert.ok(res.misses.some((m) => m.var === "co.peers" && /not an SEC registrant/.test(m.searched)));
});

// ------------------------------------------------------------------ brokercheck-iapd

const BC_HIT = (crd, first, last, firms = [], other = [], disc = "N") => ({ _source: { ind_source_id: crd, ind_firstname: first, ind_lastname: last, ind_other_names: other, ind_bc_scope: "Active", ind_ia_scope: "NotInScope", ind_bc_disclosure_fl: disc, ind_current_employments: firms.map(([firm_name, branch_city, branch_state]) => ({ firm_name, branch_city, branch_state })) } });

test("brokercheck-iapd: employer match verifies; disclosures get their own row; terms carried", async () => {
  const search = { hits: { total: 3, hits: [BC_HIT("111", "Jane", "Doe", [["ACME ROBOTICS SECURITIES LLC", "Austin", "TX"]], [], "Y"), BC_HIT("222", "Janet", "Doe", [["OTHER FIRM", "Boise", "ID"]]), BC_HIT("333", "John", "Doe")] } };
  const detail = { hits: { hits: [{ _source: { content: JSON.stringify({ currentEmployments: [{ firmName: "ACME ROBOTICS SECURITIES LLC", registrationBeginDate: "1/2/2020", branchOfficeLocations: [{ city: "Austin", state: "TX" }] }], previousEmployments: [{ firmName: "OLD FIRM", registrationBeginDate: "1/1/2010", registrationEndDate: "1/1/2019" }], productExamCategory: [{ examCategory: "Series 7", examTakenDate: "1/1/2010" }], disclosures: [{ disclosureType: "Customer Dispute", eventDate: "3/3/2021", disclosureResolution: "Settled" }] }) } }] } };
  const f = fakeFetch([[/brokercheck\.finra\.org\/search\/individual\/111/, { body: detail }], [/search\/individual\?/, { body: search }]]);
  const res = await run(JANE, [broker], f);
  const lic = rowsOf(res, "brokercheck-iapd").filter((r) => r.var === "career.licenses");
  assert.equal(lic[0].grade, "v");
  assert.match(lic[0].value, /CRD 111/);
  assert.match(lic[0].value, /previously OLD FIRM/);
  assert.match(lic[0].detail.terms, /permitted uses/);
  const disc = rowsOf(res, "brokercheck-iapd").find((r) => r.var === "rec.disclosures");
  assert.match(disc.value, /Customer Dispute/);
  assert.ok(!hitNamesSubject(BC_HIT("333", "John", "Doe")._source, JANE));
  assert.equal(matchHits(search, null, JANE).length, 1, "Janet is not a form of Jane");
  assert.equal(parseDetail({}), null);
});

test("brokercheck-iapd: nobody registered is a checked-none row", async () => {
  const f = fakeFetch([[/search\/individual/, { body: { hits: { total: 0, hits: [] } } }]]);
  const res = await run(JANE, [broker], f);
  assert.match(rowsOf(res, "brokercheck-iapd")[0].value, /No FINRA-registered/);
});

// ------------------------------------------------------------------ licenses

test("licenses: NY attorney with the company as employer verifies and gives the law school", async () => {
  const f = fakeFetch([
    [/data\.ny\.gov/, { body: [{ registration_number: "1000001", first_name: "JANE", last_name: "DOE", company_name: "ACME ROBOTICS INC", city: "AUSTIN", state: "TX", year_admitted: "2010", law_school: "Example Law School", status: "Currently registered" }] }],
    [/npiregistry/, { body: { result_count: 0, results: [] } }],
    [/data\.colorado\.gov/, { body: [] }],
    [/data\.texas\.gov/, { body: [] }],
  ]);
  const res = await run(JANE, [licenses], f);
  const rows = rowsOf(res, "licenses");
  const lic = rows.find((r) => r.var === "career.licenses");
  assert.equal(lic.grade, "v");
  assert.deepEqual(lic.anchors, ["name", "company", "place"]);
  assert.match(rows.find((r) => r.var === "career.education").value, /Example Law School/);
});

test("licenses: many name-only NPI records collapse to one namesake row", () => {
  const recs = Array.from({ length: 6 }, (_, i) => ({ first: "JANE", last: "DOE", city: "ELSEWHERE", state: "WA", id: `NPI ${i}` }));
  const m = matchRecords(recs, JANE, {});
  assert.equal(m.length, 6);
  assert.ok(m.every((x) => x.grade === "w"));
  assert.match(sources(JANE)[1].url, /JANE/);
});

// ------------------------------------------------------------------ bank-cu

test("bank-cu: FDIC record for a bank holding company", async () => {
  const f = fakeFetch([NO_SEC, NO_WD, [/lei-records/, { body: { data: [] } }], [/api\.fdic\.gov/, { body: fx("fdic-huntington") }]]);
  const res = await run({ name: "Jane Doe", company: "Huntington Bancshares" }, [bankCu], f);
  const row = rowsOf(res, "bank-cu")[0];
  assert.match(row.value, /The Huntington National Bank/);
  assert.match(row.value, /assets \$\d/);
  assert.equal(coreName("Huntington Bancshares Inc"), "huntington");
  assert.equal(pickFdic(fx("fdic-huntington"), "Huntington Bancshares")[0].CERT, 6560);
});

test("bank-cu: NCUA credit union with the CEO on file", async () => {
  const f = fakeFetch([NO_SEC, NO_WD, [/lei-records/, { body: { data: [] } }], [/GetSearchLocations/, { body: fx("ncua-search") }], [/GetCreditUnionDetails/, { body: fx("ncua-detail") }]]);
  const res = await run({ name: "Jane Doe", company: "Navy Federal Credit Union" }, [bankCu], f);
  const rows = rowsOf(res, "bank-cu");
  assert.match(rows.find((r) => r.var === "co.facts").value, /charter 5536/);
  assert.ok(rows.find((r) => r.var === "co.leadership"));
});

test("bank-cu: not a bank is a quiet miss with no FDIC call", async () => {
  const f = fakeFetch([NO_SEC, NO_WD, [/lei-records/, { body: { data: [] } }]]);
  const res = await run(JANE, [bankCu], f);
  assert.ok(res.misses.some((m) => /does not look like a bank/.test(m.searched)));
  assert.ok(!f.calls.some((u) => /fdic|ncua/.test(u)));
  assert.equal(bankReason({ company: "First Example Bancorp" }), 'name "First Example Bancorp"');
  assert.match(bankReason({ company: "Example Holdings" }, { sub: { sic: "6022", sicDescription: "State commercial banks" } }), /SIC 6022/);
});

// ------------------------------------------------------------------ sanctions-csl

const CSL = { results: [
  { name: "Jane DOE", alt_names: ["J. Doe"], type: "Individual", source: "Specially Designated Nationals (SDN) - Treasury Department", programs: ["EXAMPLE"], addresses: [{ country: "XX" }], id: "1" },
  { name: "ACME ROBOTICS CO., LTD.", alt_names: [], type: "Entity", source: "Entity List (EL) - Bureau of Industry and Security", programs: [], addresses: [{ country: "YY" }], id: "2" },
  { name: "Acme Robotics Road Holdings", alt_names: [], source: "Entity List (EL) - Bureau of Industry and Security", id: "3" },
  { name: "Doe Shipping", alt_names: [], type: "Vessel", source: "SDN", id: "4" },
] };

test("sanctions-csl: person and company matched locally, cached under OSINT_CACHE_DIR", async () => {
  const dir = mkdtempSync(join(tmpdir(), "csl-"));
  const prev = process.env.OSINT_CACHE_DIR;
  process.env.OSINT_CACHE_DIR = dir;
  try {
    const f = fakeFetch([[/consolidated\.json/, { body: CSL }]]);
    const res = await run(JANE, [csl], f);
    const rows = rowsOf(res, "sanctions-csl");
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.grade === "p"));
    assert.ok(rows.some((r) => /company name "ACME ROBOTICS CO., LTD."/.test(r.value)));
    // warm: no download
    const f2 = fakeFetch([]);
    const res2 = await run({ ...JANE, name: "Mary Major", company: "Clean Co" }, [csl], f2);
    assert.equal(f2.calls.length, 0);
    assert.match(rowsOf(res2, "sanctions-csl")[0].value, /^Clear: no match/);
    assert.ok(readFileSync(join(dir, "csl.compact.json"), "utf8").length > 10);
  } finally {
    if (prev == null) delete process.env.OSINT_CACHE_DIR;
    else process.env.OSINT_CACHE_DIR = prev;
  }
});

test("sanctions-csl: matchers ignore partial company names and vessels", () => {
  const list = compact(CSL);
  assert.equal(screenPerson(list, { name: "Jane Doe" }).length, 1);
  assert.equal(screenPerson(list, { name: "John Doe" }).length, 0);
  assert.equal(screenCompany(list, ["Acme Robotics"]).length, 1);
});

test("sanctions-csl: a failed download with no cache is blocked, not clear", async () => {
  const prev = process.env.OSINT_CACHE_DIR;
  process.env.OSINT_CACHE_DIR = mkdtempSync(join(tmpdir(), "csl-"));
  try {
    const res = await run(JANE, [csl], fakeFetch([[/consolidated/, { status: 503, body: "down" }]]));
    assert.equal(res.modules[0].status, "blocked");
    assert.equal(rowsOf(res, "sanctions-csl").length, 0);
  } finally {
    if (prev == null) delete process.env.OSINT_CACHE_DIR;
    else process.env.OSINT_CACHE_DIR = prev;
  }
});

// ------------------------------------------------------------------ lobbying-fara

test("lobbying-fara: lobbyist tied to the company verifies; FARA registrant by company name", async () => {
  const lda = { count: 2, results: [{ id: 9, first_name: "JANE", middle_name: "Q", last_name: "DOE", registrant: { id: 77, name: "ACME ROBOTICS INC", city: "AUSTIN", state: "TX" } }, { id: 10, first_name: "JOHN", last_name: "DOE", registrant: { id: 78, name: "X" } }] };
  const fara = { REGISTRANTS_ACTIVE: { ROW: [{ Name: "Acme Robotics, Inc.", Registration_Number: 9999, Registration_Date: "1/2/2024", City: "Austin", State: "TX" }, { Name: "Other Agents LLC", Registration_Number: 1 }] } };
  const f = fakeFetch([[/lda\.gov\/api\/v1\/lobbyists/, { body: lda }], [/efile\.fara\.gov/, { body: fara }]]);
  const res = await run(JANE, [lobbying], f);
  const rows = rowsOf(res, "lobbying-fara");
  assert.equal(rows.find((r) => r.var === "politics.person_lobbying").grade, "v");
  const fr = rows.find((r) => r.var === "politics.company_pac");
  assert.equal(fr.date, "2024-01-02");
  assert.equal(matchLobbyists(lda, JANE).length, 1);
  assert.equal(matchFara(fara, ["Acme Robotics"]).length, 1);
});

test("lobbying-fara: lda.gov 429 is blocked (partial when FARA answered)", async () => {
  const f = fakeFetch([[/lda\.gov/, { status: 429, body: "slow" }], [/efile\.fara\.gov/, { body: { REGISTRANTS_ACTIVE: { ROW: [] } } }]]);
  const res = await run(JANE, [lobbying], f);
  assert.equal(res.modules[0].status, "partial");
  assert.ok(res.misses.some((m) => /LDA_API_KEY/.test(m.searched)));
});

// ------------------------------------------------------------------ domain-intel

test("domain-intel: RDAP dates, registrar and DNS host", async () => {
  const f = fakeFetch([[/rdap\.org\/domain\/microsoft\.com/, { body: fx("rdap-microsoft") }]]);
  const res = await run({ name: "Jane Doe", company: "Microsoft", domain: "microsoft.com" }, [domainIntel], f);
  const row = rowsOf(res, "domain-intel")[0];
  assert.match(row.value, /registered 1991-05-02/);
  assert.match(row.value, /MarkMonitor/);
  assert.equal(row.date, "1991-05-02");
  assert.equal(dnsHost(["ns1.example.com", "ns2.example.com"], "example.com"), "self-hosted");
  assert.equal(parseRdap({ objectClassName: "entity" }), null);
});

// ------------------------------------------------------------------ enforcement

test("enforcement: only facilities named as the company count; penalties summed", async () => {
  const fac = [
    { FacName: "ACME ROBOTICS INC", FacCity: "AUSTIN", FacState: "TX", FacComplianceStatus: "Significant Violation", FacSNCFlg: "Y", FacFormalActionCount: "2", FacTotalPenalties: "$120,000", FacDateLastPenalty: "02/17/2024", RegistryID: "1" },
    { FacName: "ACME ROBOTICS PLANT 2", FacCity: "RENO", FacState: "NV", FacComplianceStatus: "No Violation Identified", FacFormalActionCount: "0", FacTotalPenalties: "$0", RegistryID: "2" },
    { FacName: "100 ACME ROBOTICS ROAD", FacCity: "X", FacState: "CA", FacComplianceStatus: "Violation", FacTotalPenalties: "$9,999", RegistryID: "3" },
  ];
  const f = fakeFetch([[/get_facilities/, { body: { Results: { Message: "Success", QueryRows: "3", QueryID: "42" } } }], [/get_qid/, { body: { Results: { Facilities: fac } } }]]);
  const res = await run(JANE, [enforcement], f);
  const rows = rowsOf(res, "enforcement");
  assert.match(rows[0].value, /2 facilities named Acme Robotics in 2 state/);
  assert.match(rows[0].value, /\$120,000/);
  assert.equal(rows[0].date, "2024-02-17");
  assert.equal(rows.length, 2);
  assert.equal(companyFacilities(fac, ["Acme Robotics"]).length, 2);
  assert.equal(summarize([]).facilities, 0);
});

// ------------------------------------------------------------------ patents (USPTO ODP)

test("patents: USPTO ODP applications parsed by inventor; without a key a miss names USPTO_API_KEY", async () => {
  const odp = { count: 1, patentFileWrapperDataBag: [{ applicationNumberText: "17000001", applicationMetaData: { inventionTitle: "Robot gripper", filingDate: "2021-01-01", patentNumber: "11000001", grantDate: "2023-01-01", firstApplicantName: "Acme Robotics Inc", inventorBag: [{ inventorNameText: "Jane Doe", correspondenceAddressBag: [{ cityName: "Austin", geographicRegionCode: "TX", countryCode: "US" }] }, { inventorNameText: "John Roe" }] } }] };
  const apps = odpApplications(odp, JANE);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].city, "Austin");
  const gp = [/patents\.google\.com/, { body: { results: { total_num_results: 0, cluster: [] } } }];
  const prev = process.env.USPTO_API_KEY;
  delete process.env.USPTO_API_KEY;
  try {
    const res = await run(JANE, [patents], fakeFetch([gp]));
    assert.ok(res.misses.some((m) => /USPTO_API_KEY/.test(m.searched)));
    process.env.USPTO_API_KEY = "test-key";
    let hdr = null;
    const res2 = await run(JANE, [patents], fakeFetch([gp, [/api\.uspto\.gov/, (u, init) => ((hdr = init.headers), { body: odp })]]));
    assert.equal(hdr["X-API-KEY"], "test-key");
    const home = res2.rows.find((r) => r.var === "place.home_metro");
    assert.match(home.value, /Austin, TX/);
    assert.equal(home.grade, "p");
  } finally {
    if (prev == null) delete process.env.USPTO_API_KEY;
    else process.env.USPTO_API_KEY = prev;
  }
});
