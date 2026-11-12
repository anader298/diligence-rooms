// Connector tests. No network and no keys: every provider call goes to a fake fetch that
// answers from tests/fixtures/connectors/<provider>.json and records what was asked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { ADAPTERS, BY_ID } from "../scripts/connectors/index.mjs";
import { makePerson, makeCompany, makeSource, PERSON_FIELDS, COMPANY_FIELDS, CONNECTOR_GRADE } from "../scripts/connectors/schema.mjs";
import { mergeAll, sameValue, sameContact } from "../scripts/connectors/merge.mjs";
import { enrich } from "../scripts/connectors/run.mjs";
import { parseCsv, csvRecords } from "../scripts/connectors/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const FX = join(HERE, "fixtures", "connectors");
const fixture = (id) => JSON.parse(readFileSync(join(FX, id + ".json"), "utf8"));

const JANE = { name: "Jane Doe", slug: "jane-doe" };
const ACME = { name: "Acme Capital", domain: "acme.example" };
const KEYS = { APOLLO_API_KEY: "k-apollo", ZOOMINFO_USERNAME: "u", ZOOMINFO_PASSWORD: "p", LUSHA_API_KEY: "k-lusha", COGNISM_API_KEY: "k-cog", CRUNCHBASE_API_KEY: "k-cb", PITCHBOOK_API_KEY: "k-pb", CLAY_WEBHOOK_URL: "https://hooks.clay.example/t/1" };

/** A fetch that answers from a fixture map keyed "METHOD /path" (or "METHOD /path?collection_ids=x"). */
function fakeFetch(map) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    calls.push({ method, url: u, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined });
    const keyQ = `${method} ${u.pathname}?collection_ids=${u.searchParams.get("collection_ids")}`;
    const hit = map[keyQ] ?? map[`${method} ${u.pathname}`];
    if (hit === undefined) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(hit), { status: 200, headers: { "content-type": "application/json" } });
  };
  fn.calls = calls;
  return fn;
}

function ctxFor(id, extra = {}) {
  const spent = [];
  const notes = [];
  const fetch = fakeFetch(existsSync(join(FX, id + ".json")) ? fixture(id) : {});
  return {
    ctx: { env: KEYS, slug: "acme", fetch, fetchedAt: "2026-11-12T10:00:00.000Z", cache: {}, hints: {}, options: {}, importsDir: join(FX, "imports"), rawDir: join(FX, "raw"), spend: (n) => spent.push(n), note: (m) => notes.push(m), ...extra },
    fetch,
    spent,
    notes,
  };
}

/** The contact with this value (phones compared by digits), or undefined. */
const contact = (p, value) => p.contacts.find((c) => c.value === value || (c.type === "phone" && c.value.replace(/\D/g, "").endsWith(value.replace(/\D/g, "").slice(-10))));
/** Assert a contact is kept and labelled, with its source. */
function assertKept(p, value, type, kind, phoneType, label) {
  const c = contact(p, value);
  assert.ok(c, `${label}: ${value} is kept`);
  assert.equal(c.type, type, `${label}: ${value} type`);
  assert.equal(c.kind, kind, `${label}: ${value} kind`);
  if (phoneType) assert.equal(c.phoneType, phoneType, `${label}: ${value} phoneType`);
  assert.ok(c.source && c.source.provider && c.source.fetchedAt && "recordId" in c.source, `${label}: ${value} source`);
}
// Boundaries that remain: no real-time location (Lusha's fixture carries coordinates).
const LOCATION = ["-71.06", "42.36", "coordinates"];
function assertNoLocation(rec, label) {
  const s = JSON.stringify(rec);
  for (const p of LOCATION) assert.ok(!s.includes(p), `${label}: "${p}" must not be stored`);
}
function assertShape(rec, fields, label) {
  assert.ok(rec, `${label}: a record`);
  for (const f of fields) assert.ok(f in rec, `${label}: has ${f}`);
  assert.deepEqual(Object.keys(rec).sort(), [...fields, "source"].sort(), `${label}: only schema keys`);
  assert.ok(rec.source.provider && rec.source.fetchedAt, `${label}: source`);
}

// ---------------------------------------------------------------- registry

test("connectors: every adapter exports the contract", () => {
  assert.deepEqual(ADAPTERS.map((a) => a.id).sort(), ["apollo", "apollo-mcp", "clay", "cognism", "crunchbase", "csv", "linkedin-export", "lusha", "pitchbook", "zoominfo"]);
  for (const a of ADAPTERS) {
    assert.ok(["api", "file", "mcp"].includes(a.kind), a.id);
    assert.ok(Array.isArray(a.envKeys) && Array.isArray(a.fields) && a.fields.length, a.id);
    for (const f of a.fields) assert.match(f, /^(person|company)\.\w+$/, `${a.id} field ${f}`);
    for (const f of a.fields) assert.ok([...PERSON_FIELDS.map((x) => "person." + x), ...COMPANY_FIELDS.map((x) => "company." + x)].includes(f), `${a.id}: ${f} is a schema field`);
    assert.equal(typeof a.docsUrl, "string");
    assert.equal(typeof a.fetchPerson, "function");
    assert.equal(typeof a.fetchCompany, "function");
    const e = a.estimateCredits({ people: [JANE, { name: "John Roe", slug: "john-roe" }] }, {});
    assert.ok(Number.isFinite(e.credits) && e.credits >= 0 && typeof e.note === "string", `${a.id} estimate`);
  }
  assert.equal(BY_ID.apollo.envKeys[0], "APOLLO_API_KEY");
  assert.equal(BY_ID["apollo-mcp"].kind, "mcp");
  assert.match(BY_ID.apollo.mcp, /apollo_people_match/);
});

// ---------------------------------------------------------------- normalisation per adapter

test("apollo: people match, organization enrich, job postings normalised; key in x-api-key; personal reveal on by default", async () => {
  const { ctx, fetch, spent } = ctxFor("apollo");
  const p = await BY_ID.apollo.fetchPerson(JANE, { name: "Acme Capital" }, ctx);
  assertShape(p, PERSON_FIELDS, "apollo person");
  assert.deepEqual(p.titles[0], { title: "Chief Financial Officer", company: "Acme Capital", from: "2021-03", to: null });
  assert.equal(p.titles[1].to, "2021-02");
  assert.equal(p.locationCity, "Boston");
  assertKept(p, "jane.doe@acme.example", "email", "work", null, "apollo");
  assertKept(p, "jane.doe.home@gmail.com", "email", "personal", null, "apollo");
  assertKept(p, "+16175550199", "phone", "work", "direct", "apollo");
  assertKept(p, "+16175550100", "phone", "unknown", "mobile", "apollo");
  assertKept(p, "+16175550111", "phone", "personal", "home", "apollo");
  assertKept(p, "12 Elm Street, Boston, Massachusetts 02139, United States", "address", "unknown", null, "apollo");
  assert.equal(p.seniority, "c_suite");
  assert.deepEqual(p.socials.map((s) => s.platform), ["linkedin", "x"]);
  assert.equal(p.socials[0].handle, "janedoe-example");
  assert.equal(p.source.recordId, "ap-jane-1");
  const call = fetch.calls[0];
  assert.equal(call.headers["x-api-key"], "k-apollo");
  assert.equal(call.url.searchParams.get("reveal_personal_emails"), "true", "revealPersonal defaults to true");
  assert.equal(call.url.searchParams.get("reveal_phone_number"), "false", "phones need a webhookUrl");
  assert.equal(ctx.hints.domain, "acme.example", "domain learned from the match for the org call");

  const c = await BY_ID.apollo.fetchCompany({ name: "Acme Capital" }, ctx);
  assertShape(c, COMPANY_FIELDS, "apollo company");
  assert.equal(c.headcount, 240);
  assert.equal(c.revenue, 45000000);
  assert.deepEqual(c.funding, [{ round: "Series B", date: "2022-05-10", amount: 30000000, investors: ["North Fund", "East Ventures"] }]);
  assert.deepEqual(c.techStack, ["Salesforce", "Snowflake"]);
  assert.deepEqual(c.jobPostings, [{ title: "Head of Data", date: "2026-10-01", url: "https://jobs.acme.example/1" }]);
  assert.deepEqual(c.domains, ["acme.example"]);
  assert.deepEqual(c.addresses.map((a) => [a.value, a.role, a.source.provider]), [["1 Harbor Way, Boston, MA", "principal office", "apollo"]]);
  assert.deepEqual(spent, [2, 1, 1], "match + personal email reveal, org, job postings");
});

test("apollo: revealPersonal false sends no reveals; a webhookUrl turns the phone reveal on; the estimate counts reveal credits", async () => {
  const off = ctxFor("apollo", { revealPersonal: false });
  await BY_ID.apollo.fetchPerson(JANE, ACME, off.ctx);
  assert.equal(off.fetch.calls[0].url.searchParams.get("reveal_personal_emails"), "false");
  assert.deepEqual(off.spent, [1]);
  const hook = ctxFor("apollo", { options: { webhookUrl: "https://hooks.example/apollo" } });
  await BY_ID.apollo.fetchPerson(JANE, ACME, hook.ctx);
  assert.equal(hook.fetch.calls[0].url.searchParams.get("reveal_phone_number"), "true");
  assert.equal(hook.fetch.calls[0].url.searchParams.get("webhook_url"), "https://hooks.example/apollo");
  const two = { people: [JANE, { name: "John Roe", slug: "john-roe" }] };
  assert.equal(BY_ID.apollo.estimateCredits(two, { revealPersonal: false }).credits, 4);
  assert.equal(BY_ID.apollo.estimateCredits(two, {}).credits, 6);
  assert.equal(BY_ID.apollo.estimateCredits(two, { webhookUrl: "https://hooks.example/a" }).credits, 22);
});

test("apollo-mcp: saved MCP responses normalise to the same record, nothing fetched", async () => {
  const base = mkdtempSync(join(tmpdir(), "conn-mcp-"));
  try {
    const raw = join(base, "raw", "apollo-mcp");
    mkdirSync(raw, { recursive: true });
    const fx = fixture("apollo");
    writeFileSync(join(raw, "person-jane-doe.json"), JSON.stringify(fx["POST /api/v1/people/match"]));
    writeFileSync(join(raw, "company.json"), JSON.stringify(fx["GET /api/v1/organizations/enrich"]));
    writeFileSync(join(raw, "job-postings.json"), JSON.stringify(fx["GET /api/v1/organizations/ap-org-9/job_postings"]));
    const { ctx, fetch } = ctxFor("none", { rawDir: join(base, "raw") });
    assert.ok(BY_ID["apollo-mcp"].configured(ctx));
    const p = await BY_ID["apollo-mcp"].fetchPerson(JANE, ACME, ctx);
    const c = await BY_ID["apollo-mcp"].fetchCompany(ACME, ctx);
    const viaKey = await BY_ID.apollo.fetchPerson(JANE, ACME, ctxFor("apollo").ctx);
    assert.deepEqual(p.titles, viaKey.titles);
    assert.equal(c.jobPostings.length, 1);
    assert.equal(fetch.calls.length, 0);
    assert.equal(BY_ID["apollo-mcp"].estimateCredits({ people: [JANE] }).credits, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("zoominfo: authenticate then enrich; education, revenue in thousands, mobile and street kept and labelled", async () => {
  const { ctx, fetch } = ctxFor("zoominfo");
  const p = await BY_ID.zoominfo.fetchPerson(JANE, ACME, ctx);
  assertShape(p, PERSON_FIELDS, "zoominfo person");
  assert.deepEqual(p.education, [{ school: "Boston College", degree: "MBA, Finance", from: null, to: null }]);
  assertKept(p, "+1 617 555 0199", "phone", "work", "direct", "zoominfo");
  assertKept(p, "+1 617 555 0100", "phone", "unknown", "mobile", "zoominfo");
  assertKept(p, "12 Elm Street, Boston", "address", "unknown", null, "zoominfo");
  assert.equal(p.seniority, "C-Level");
  assert.deepEqual(p.departments, ["Finance"]);
  assert.equal(fetch.calls[0].url.pathname, "/authenticate");
  assert.equal(fetch.calls[1].headers.authorization, "Bearer fake-jwt");
  assert.ok(fetch.calls[1].body.outputFields.includes("mobilePhone"), "revealPersonal asks for the mobile");
  const c = await BY_ID.zoominfo.fetchCompany(ACME, ctx);
  assert.equal(c.revenue, 52000000);
  assert.equal(c.headcount, 410);
  assert.equal(fetch.calls.filter((x) => x.url.pathname === "/authenticate").length, 1, "token reused");
  assert.deepEqual(c.addresses.map((a) => a.role), ["principal office"]);
});

test("lusha: search then enrich emails and phones; private email and mobile kept and labelled; no coordinates; billed credits counted", async () => {
  const { ctx, fetch, spent } = ctxFor("lusha");
  const p = await BY_ID.lusha.fetchPerson(JANE, ACME, ctx);
  assertShape(p, PERSON_FIELDS, "lusha person");
  assertKept(p, "jane.doe@acme.example", "email", "work", null, "lusha");
  assertKept(p, "janed@gmail.com", "email", "personal", null, "lusha");
  assertKept(p, "+1 617 555 0199", "phone", "work", "direct", "lusha");
  assertKept(p, "+1 617 555 0100", "phone", "unknown", "mobile", "lusha");
  assert.equal(p.titles[0].from, "2021-03");
  assert.equal(fetch.calls[0].headers.api_key, "k-lusha");
  assert.deepEqual(fetch.calls[1].body.reveal, ["emails", "phones"]);
  assert.deepEqual(spent, [1]);
  const c = await BY_ID.lusha.fetchCompany(ACME, ctx);
  assert.equal(c.headcount, "201-500");
  assert.equal(c.addresses[0].value, "1 Harbor Way");
  assertNoLocation([p, c], "lusha");
});

test("cognism: enrich preview then redeem; mobiles and home address kept and labelled", async () => {
  const { ctx, fetch, spent } = ctxFor("cognism");
  const p = await BY_ID.cognism.fetchPerson(JANE, ACME, ctx);
  assertShape(p, PERSON_FIELDS, "cognism person");
  assertKept(p, "+1 617 555 0199", "phone", "work", "direct", "cognism");
  assertKept(p, "+1 617 555 0100", "phone", "unknown", "mobile", "cognism");
  assertKept(p, "12 Elm Street", "address", "personal", null, "cognism");
  assert.equal(p.titles[0].company, "Acme Capital");
  assert.equal(fetch.calls[0].headers.authorization, "Bearer k-cog");
  const c = await BY_ID.cognism.fetchCompany(ACME, ctx);
  assert.equal(c.headcount, 250);
  assert.equal(c.revenue, "10M-50M");
  assert.deepEqual(spent, [1, 1]);
});

test("crunchbase: autocomplete then entity lookup; employee range, funding, subsidiaries", async () => {
  const { ctx, fetch } = ctxFor("crunchbase");
  const c = await BY_ID.crunchbase.fetchCompany(ACME, ctx);
  assertShape(c, COMPANY_FIELDS, "crunchbase company");
  assert.equal(c.headcount, "101-250");
  assert.equal(c.legalName, "Acme Capital LLC");
  assert.deepEqual(c.funding, [{ round: "series_b", date: "2022-05-10", amount: 30000000, investors: ["North Fund"] }]);
  assert.deepEqual(c.subsidiaries, ["Acme Data Ltd"]);
  assert.equal(fetch.calls[0].headers["X-cb-user-key"], "k-cb");
  const p = await BY_ID.crunchbase.fetchPerson(JANE, ACME, ctx);
  assert.equal(p.locationCity, "Boston");
  assert.deepEqual(p.education[0], { school: "Boston College", degree: "MBA", from: null, to: "2012-05" });
});

test("pitchbook: PB-Token auth; office line and home phone kept and labelled", async () => {
  const { ctx, fetch } = ctxFor("pitchbook");
  const p = await BY_ID.pitchbook.fetchPerson(JANE, ACME, ctx);
  assertShape(p, PERSON_FIELDS, "pitchbook person");
  assertKept(p, "+1 617 555 0150", "phone", "work", "office", "pitchbook");
  assertKept(p, "+1 617 555 0111", "phone", "personal", "home", "pitchbook");
  assert.equal(p.education[0].to, "2012");
  assert.equal(fetch.calls[0].headers.authorization, "PB-Token k-pb");
  const c = await BY_ID.pitchbook.fetchCompany(ACME, ctx);
  assert.equal(c.funding[0].amount, 32000000);
});

test("clay: pushes rows to the table webhook until an export exists, then reads clay.csv", async () => {
  const base = mkdtempSync(join(tmpdir(), "conn-clay-"));
  try {
    const hook = fakeFetch({ "POST /t/1": {} });
    const { ctx, spent, notes } = ctxFor("none", { importsDir: base, fetch: hook });
    const fetch = hook;
    assert.equal(await BY_ID.clay.fetchPerson(JANE, ACME, ctx), null);
    assert.equal(fetch.calls[0].url.toString(), KEYS.CLAY_WEBHOOK_URL);
    assert.equal(fetch.calls[0].body.name, "Jane Doe");
    assert.deepEqual(spent, [1]);
    assert.match(notes[0], /clay\.csv/);
    const withExport = ctxFor("none");
    const p = await BY_ID.clay.fetchPerson(JANE, ACME, withExport.ctx);
    assert.equal(withExport.fetch.calls.length, 0, "no push once the export exists");
    assert.equal(p.source.provider, "clay");
    assert.equal(p.titles[0].title, "Chief Financial Officer");
    assert.equal(BY_ID.clay.estimateCredits({ people: [JANE] }, {}, withExport.ctx).credits, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("linkedin-export: Connections.csv and a positions file fold into one person; email, mobile and home address kept and labelled", async () => {
  const { ctx } = ctxFor("none");
  const p = await BY_ID["linkedin-export"].fetchPerson(JANE, ACME, ctx);
  assertShape(p, PERSON_FIELDS, "linkedin person");
  assertKept(p, "jane.private@gmail.com", "email", "personal", null, "linkedin");
  assertKept(p, "+1 617 555 0100", "phone", "unknown", "mobile", "linkedin");
  assertKept(p, "12 Elm Street", "address", "personal", null, "linkedin");
  assert.deepEqual(p.titles.map((t) => [t.title, t.company, t.from, t.to]), [
    ["Chief Financial Officer", "Acme Capital", null, null],
    ["Chief Financial Officer", "Acme Capital", "2021-03", null],
    ["Vice President, Finance", "Harbor Point Partners", "2016-06", "2021-02"],
  ]);
  assert.deepEqual(p.education, [{ school: "Boston College", degree: "MBA", from: "2010", to: "2012" }]);
  assert.equal(p.locationCity, "Boston");
  assert.match(p.source.note, /1st-degree connection of the user since 14 Mar 2023/);
  assert.equal(await BY_ID["linkedin-export"].fetchCompany(ACME, ctx), null);
});

test("csv: person and company rows by header alias; personal columns kept and labelled", async () => {
  const { ctx } = ctxFor("none");
  const p = await BY_ID.csv.fetchPerson(JANE, ACME, ctx);
  assertShape(p, PERSON_FIELDS, "csv person");
  assertKept(p, "jane.doe@acme.example", "email", "work", null, "csv");
  assertKept(p, "jane@gmail.com", "email", "personal", null, "csv");
  assertKept(p, "+1 617 555 0199", "phone", "work", "office", "csv");
  assertKept(p, "+1 617 555 0100", "phone", "unknown", "mobile", "csv");
  assertKept(p, "12 Elm Street", "address", "personal", null, "csv");
  const c = await BY_ID.csv.fetchCompany(ACME, ctx);
  assert.equal(c.legalName, "Acme Capital LLC");
  assert.equal(c.headcount, 1200);
  assert.deepEqual(parseCsv('a,"b ""q"", c"\r\n1,2\n'), [["a", 'b "q", c'], ["1", "2"]]);
  assert.deepEqual(csvRecords("Home Address,Name,Title,Favourite Colour\n1 Elm St,Ann,CEO,blue\n"), [{ homeAddress: "1 Elm St", name: "Ann", title: "CEO" }]);
});

// ---------------------------------------------------------------- contacts: kept and labelled

test("schema: home address, personal email and personal, mobile or untyped phones are kept and labelled, each with its source", () => {
  const p = makePerson(
    {
      names: ["Ann Lee"],
      city: "12 Elm Street",
      emails: ["ann@gmail.com", { email: "ann@icloud.com", type: "personal" }, { email: "ann.lee@firm.example", type: "work" }, "ann@lee-family.example"],
      phones: [{ number: "+1 555 0100", type: "mobile" }, { number: "+1 555 0111", type: "home" }, { number: "+1 555 0122" }, "+1 555 0133", { number: "+1 555 0144", type: "personal" }, { number: "+1 555 0150", type: "direct" }, { number: "+1 555 0160", type: "work_hq" }],
      addresses: [{ street: "40 Oak Lane", city: "Newton", state: "MA", zip: "02458", type: "home" }],
      homeAddress: "ignored: not a schema input",
    },
    makeSource("test", "1", "2026-11-12T00:00:00Z"),
  );
  assert.equal(p.locationCity, null, "a street address is not a city");
  const k = (v) => { const c = p.contacts.find((x) => x.value === v); return c && [c.type, c.kind, c.phoneType || null]; };
  assert.deepEqual(k("12 Elm Street"), ["address", "unknown", null], "a street-like city is kept as an address");
  assert.deepEqual(k("ann@gmail.com"), ["email", "personal", null], "untyped webmail is personal");
  assert.deepEqual(k("ann@icloud.com"), ["email", "personal", null]);
  assert.deepEqual(k("ann.lee@firm.example"), ["email", "work", null]);
  assert.deepEqual(k("ann@lee-family.example"), ["email", "unknown", null]);
  assert.deepEqual(k("+1 555 0100"), ["phone", "unknown", "mobile"]);
  assert.deepEqual(k("+1 555 0111"), ["phone", "personal", "home"]);
  assert.deepEqual(k("+1 555 0122"), ["phone", "unknown", "other"]);
  assert.deepEqual(k("+1 555 0133"), ["phone", "unknown", "other"]);
  assert.deepEqual(k("+1 555 0144"), ["phone", "personal", "other"]);
  assert.deepEqual(k("+1 555 0150"), ["phone", "work", "direct"]);
  assert.deepEqual(k("+1 555 0160"), ["phone", "work", "office"]);
  assert.deepEqual(k("40 Oak Lane, Newton, MA 02458"), ["address", "personal", null]);
  for (const c of p.contacts) assert.deepEqual(c.source, { provider: "test", fetchedAt: "2026-11-12T00:00:00Z", recordId: "1" });
  assert.ok(!("homeAddress" in p), "only schema keys");
  assert.equal(makePerson({ city: "Boston, MA" }, makeSource("t")).locationCity, "Boston", "the city field stays");
  const c = makeCompany({ name: "Firm", headcount: "1,001-5,000", revenue: "$12.5m", addresses: ["1 Main St", { value: "PO Box 9", role: "mailing" }, { value: "2 Court Sq", type: "registered agent" }] }, makeSource("test"));
  assert.equal(c.headcount, "1001-5000");
  assert.equal(c.revenue, 12500000);
  assert.deepEqual(c.addresses.map((a) => [a.value, a.role]), [["1 Main St", "other"], ["PO Box 9", "mailing"], ["2 Court Sq", "registered"]]);
});

test("merge: a personal email, mobile or home address that matches the company's own record is marked business of record", () => {
  const owner = makePerson(
    {
      names: ["Ann Lee"],
      emails: ["ann.lee.capital@gmail.com", "ann@elsewhere.example"],
      phones: [{ number: "(617) 555-0177", type: "mobile" }, { number: "+1 617 555 0188", type: "home" }],
      addresses: [{ value: "40 Oak Ln., Newton, MA 02458", type: "home" }, { value: "40 Oak Lane, Newton, MA 99999", type: "home" }],
    },
    makeSource("apollo", "a1", "2026-11-12T00:00:00Z"),
  );
  const firm = makeCompany({ name: "Lee Capital", addresses: [{ value: "40 Oak Lane, Newton, MA 02458", role: "principal office" }] }, makeSource("apollo", "o1", "2026-11-12T00:00:00Z"));
  const records = [
    { record: "state registry", url: "https://corp.state.example/lee-capital", addresses: ["40 Oak Lane, Newton, MA 02458"], emails: [] },
    { record: "Form ADV", url: "https://adviserinfo.example/lee", phones: ["+1-617-555-0177"], emails: ["ann.lee.capital@gmail.com"] },
    { record: "WHOIS", emails: ["ANN.LEE.CAPITAL@gmail.com"] },
  ];
  const { merged } = mergeAll([{ provider: "apollo", people: { "ann-lee": owner }, company: firm }], { company: "Lee Capital", people: [{ name: "Ann Lee", slug: "ann-lee" }] }, "2026-11-12T10:00:00Z", records);
  const cs = merged.people["ann-lee"].fields.contacts;
  const it = (v) => cs.find((c) => c.value.value === v);
  assert.equal(it("ann.lee.capital@gmail.com").value.kind, "personal", "kind stays as the provider gave it");
  assert.equal(it("ann.lee.capital@gmail.com").sameAsBusiness, true);
  assert.deepEqual(it("ann.lee.capital@gmail.com").businessRecords.map((r) => r.record), ["Form ADV", "WHOIS"]);
  assert.equal(it("(617) 555-0177").sameAsBusiness, true, "phones match by digits");
  assert.equal(it("40 Oak Ln., Newton, MA 02458").sameAsBusiness, true, "addresses match after abbreviations");
  assert.equal(it("40 Oak Ln., Newton, MA 02458").businessRecords[0].url, "https://corp.state.example/lee-capital");
  assert.equal(it("40 Oak Lane, Newton, MA 99999").sameAsBusiness, false, "a different ZIP is not a match");
  assert.equal(it("ann@elsewhere.example").sameAsBusiness, false);
  assert.equal(it("+1 617 555 0188").sameAsBusiness, false);
  assert.equal(it("+1 617 555 0188").grade, "partly");
  assert.deepEqual(it("+1 617 555 0188").sources.map((x) => [x.provider, x.recordId]), [["apollo", "a1"]]);
  assert.equal(merged.company.fields.addresses[0].sameAsBusiness, true);
  assert.deepEqual(merged.businessRecords.map((r) => r.record), ["state registry", "Form ADV", "WHOIS"]);
  assert.ok(sameContact("phone", "617.555.0177", "+1 (617) 555-0177"));
  assert.ok(!sameContact("email", "a@x.example", "b@x.example"));
});

// ---------------------------------------------------------------- merge and conflicts

async function allResults() {
  const out = [];
  for (const id of ["apollo", "zoominfo", "crunchbase"]) {
    const { ctx } = ctxFor(id);
    out.push({ provider: id, people: { "jane-doe": await BY_ID[id].fetchPerson(JANE, ACME, ctx) }, company: await BY_ID[id].fetchCompany(ACME, ctx) });
  }
  return out;
}

test("merge: per-field provenance, agreeing providers listed, every field graded partly", async () => {
  const results = await allResults();
  const { merged } = mergeAll(results, { company: "Acme Capital", people: [JANE] }, "2026-11-12T10:00:00Z");
  const jane = merged.people["jane-doe"];
  assert.deepEqual(jane.providers, ["apollo", "zoominfo", "crunchbase"]);
  assert.equal(jane.fields.locationCity.value, "Boston");
  assert.deepEqual(jane.fields.locationCity.providers, ["apollo", "zoominfo", "crunchbase"]);
  assert.equal(jane.fields.locationCity.grade, CONNECTOR_GRADE);
  assert.equal(CONNECTOR_GRADE, "partly", "agreement never makes a connector value verified");
  const li = jane.fields.socials.find((s) => s.value.platform === "linkedin");
  assert.deepEqual(li.providers, ["apollo", "zoominfo", "crunchbase"]);
  for (const s of li.sources) assert.ok(s.provider && s.fetchedAt && "recordId" in s);
  const vp = jane.fields.titles.find((t) => /vice president/i.test(t.value.title));
  assert.deepEqual(vp.providers, ["apollo", "zoominfo"]);
  const all = JSON.stringify(merged);
  assert.ok(!all.includes('"grade":"verified"'));
  assert.equal(merged.company.fields.legalName.value, "Acme Capital", "first provider in priority order wins");
  assert.deepEqual(merged.company.fields.legalName.sources.map((s) => s.provider), ["apollo", "zoominfo", "crunchbase"]);
  assert.match(merged.grading, /partly/);
});

test("conflicts: different current title, different dates, different headcount", async () => {
  const results = await allResults();
  const { conflicts } = mergeAll(results, { company: "Acme Capital", people: [JANE] });
  const by = (f) => conflicts.filter((c) => c.field === f);
  assert.equal(by("titles.current").length, 1, "Chief Financial Officer vs CFO");
  const dates = by("titles.dates").find((c) => /Vice President/.test(c.item));
  assert.ok(dates, "VP Finance end month differs (2021-02 vs 2020-12)");
  assert.deepEqual(dates.values.map((v) => v.provider), ["apollo", "zoominfo"]);
  const hc = by("headcount")[0];
  assert.ok(hc, "240 vs 410 vs 101-250");
  assert.deepEqual(hc.values.map((v) => v.value), [240, 410, "101-250"]);
  assert.ok(by("revenue").length, "45M vs 52M");
  assert.ok(sameValue("headcount", 240, "101-250"), "a number inside a range agrees");
  assert.ok(sameValue("headcount", 240, 250), "within 10% agrees");
  assert.ok(!sameValue("headcount", 240, 410));
  assert.ok(!by("locationCity").length, "same city is not a conflict");
});

// ---------------------------------------------------------------- the stage: estimate, then stop

function roomFixture() {
  const base = mkdtempSync(join(tmpdir(), "conn-room-"));
  const room = join(base, "rooms", "acme");
  mkdirSync(join(room, "work"), { recursive: true });
  writeFileSync(join(room, "intake.json"), JSON.stringify({ company: "Acme Capital", people: [JANE, { name: "John Roe", slug: "john-roe" }] }));
  cpSync(join(FX, "imports"), join(room, "work", "imports"), { recursive: true });
  const config = join(base, "connectors.json");
  writeFileSync(config, JSON.stringify({ enabled: ["apollo", "lusha", "linkedin-export", "csv"], maxCredits: 50, providers: {} }));
  return { base, rooms: join(base, "rooms"), room, config };
}

test("enrich: without yes it prints the estimate per provider and stops; nothing fetched, nothing written but the estimate", async () => {
  const fx = roomFixture();
  try {
    const lines = [];
    const fetch = async () => assert.fail("no call may be made without --yes");
    const r = await enrich({ slug: "acme", roomsDir: fx.rooms, configFile: fx.config, env: { APOLLO_API_KEY: "k" }, fetch, log: (l) => lines.push(l) });
    assert.equal(r.stopped, true);
    const out = lines.join("\n");
    assert.match(out, /apollo\s+api\s+yes\s+6\s/, "2 matches + 2 personal email reveals + org + job postings");
    assert.match(out, /lusha\s+api\s+no\s+-\s+needs LUSHA_API_KEY/);
    assert.match(out, /Estimated total: 6 credits/);
    assert.match(out, /Nothing has been spent/);
    assert.ok(!out.includes("k\n") && !out.includes('"k"'), "the key is never printed");
    assert.deepEqual(readdirSync(join(fx.room, "work", "connectors")), ["estimate.json"]);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("enrich CLI: npm run enrich without --yes exits 0 after the estimate and spends nothing", () => {
  const fx = roomFixture();
  try {
    const out = execFileSync(process.execPath, [join(REPO, "scripts", "enrich.mjs"), "acme", "--rooms-dir", fx.rooms, "--config", fx.config, "--providers", "apollo,csv"], {
      env: { PATH: process.env.PATH, APOLLO_API_KEY: "secret-key-value" },
      encoding: "utf8",
    });
    assert.match(out, /apollo .* yes .* 6/);
    assert.match(out, /Run again with --yes/);
    assert.ok(!out.includes("secret-key-value"));
    assert.ok(!existsSync(join(fx.room, "work", "connectors", "merged.json")));
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("enrich: with yes, writes each provider file, merged.json, conflicts.json and run.json; respects the credit cap", async () => {
  const fx = roomFixture();
  try {
    const log = () => {};
    const capped = await enrich({ slug: "acme", yes: true, maxCredits: 2, roomsDir: fx.rooms, configFile: fx.config, env: { APOLLO_API_KEY: "k" }, fetch: async () => assert.fail("over the cap: no call"), log });
    assert.equal(capped.overCap, true);
    const r = await enrich({ slug: "acme", yes: true, roomsDir: fx.rooms, configFile: fx.config, env: { APOLLO_API_KEY: "k" }, fetch: fakeFetch(fixture("apollo")), log, now: () => new Date("2026-11-12T10:00:00Z") });
    const dir = join(fx.room, "work", "connectors");
    for (const f of ["apollo.json", "linkedin-export.json", "csv.json", "merged.json", "conflicts.json", "run.json"]) assert.ok(existsSync(join(dir, f)), f);
    assert.ok(!existsSync(join(dir, "lusha.json")), "an unconfigured provider is skipped");
    const run = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
    const ap = run.providers.find((p) => p.id === "apollo");
    assert.equal(ap.ran, true);
    assert.ok(ap.creditsUsed >= 1);
    assert.ok(ap.fieldsFilled.includes("person.titles") && ap.fieldsFilled.includes("company.headcount"));
    assert.equal(run.history.length, 1);
    const merged = JSON.parse(readFileSync(join(dir, "merged.json"), "utf8"));
    assert.deepEqual(merged.providers, ["apollo", "linkedin-export", "csv"]);
    assert.deepEqual(merged.people["john-roe"].providers, ["apollo"], "the fake answers the same match for anyone");
    assert.ok(r.conflicts.some((c) => c.field === "headcount"), "Apollo 240 vs the CRM's 1200");
    const jc = merged.people["jane-doe"].fields.contacts;
    assert.ok(jc.some((c) => c.value.value === "jane@gmail.com" && c.value.kind === "personal" && c.providers.includes("csv")), "the CRM's personal email is kept");
    assert.ok(jc.every((c) => c.sameAsBusiness === false), "no business-records.json: nothing marked");
    assert.match(merged.contactsRule, /sameAsBusiness/);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- skeleton, pipeline, studio, docs

test("skeleton: connector findings blocks, a data-sources page, and the Enrich stage in the standard and prompts", () => {
  const sk = join(REPO, "templates", "skeleton", "core");
  for (const f of ["person/linkedin", "person/education", "person/network", "person/financials", "pages/public-financials", "pages/people-map", "pages/org-chart"]) {
    const html = readFileSync(join(sk, f + ".html"), "utf8");
    assert.match(html, /<h2>Connector findings<\/h2>\s*(<!--[\s\S]*?-->\s*)?<div class="tw"><table class="checklist"><tr><th>Field<\/th><th>Value<\/th><th>Provider<\/th><th>Grade<\/th><\/tr>/, f);
    assert.ok((html.match(/<tr class="ck">/g) || []).length >= 2, f);
  }
  const ds = readFileSync(join(sk, "pages", "data-sources.html"), "utf8");
  for (const id of ADAPTERS.map((a) => a.id)) assert.match(ds, new RegExp(`<tr class="ck"><td>${id}</td>`), `data-sources row ${id}`);
  const room = JSON.parse(readFileSync(join(sk, "room.json"), "utf8"));
  assert.ok(room.sections.find((s) => s.id === "record").pages.some((p) => p.id === "data-sources"));
  const std = readFileSync(join(REPO, "pipeline", "STANDARD.md"), "utf8");
  assert.match(std, /\*\*Enrich\*\*/);
  assert.ok(std.indexOf("**Enrich**") > std.indexOf("**Harvest**") && std.indexOf("**Enrich**") < std.indexOf("**Research wave**"));
  assert.match(std, /Two independent providers agreeing is still `?partly/);
  const prompts = readFileSync(join(REPO, "pipeline", "PROMPTS.md"), "utf8");
  assert.ok(prompts.indexOf("## P2b. Enrich") > prompts.indexOf("## P2. Harvest") && prompts.indexOf("## P2b. Enrich") < prompts.indexOf("## P3a."));
  assert.match(prompts, /never copy/i);
  const studio = readFileSync(join(REPO, "templates", "studio.html"), "utf8");
  assert.match(studio, /id="connectors"/);
  const gi = readFileSync(join(REPO, ".gitignore"), "utf8");
  assert.match(gi, /^config\/connectors\.json$/m);
  assert.match(gi, /^rooms\/\*\/work\/$/m);
  const env = readFileSync(join(REPO, ".env.example"), "utf8");
  for (const a of ADAPTERS) for (const k of a.envKeys) assert.match(env, new RegExp(`^#?\\s*${k}=`, "m"), k);
});
