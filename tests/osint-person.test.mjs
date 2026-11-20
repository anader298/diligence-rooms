// Person-side OSINT modules. No network: every call goes to a fake fetch that answers from the
// small fixtures below, routed by URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOsint } from "../scripts/osint/run.mjs";
import { parseDdgHtml, parseBingImages, nameMatch, companyIn, derivedHandles, handleFromUrl } from "../scripts/osint/person-lib.mjs";
import search, { classify } from "../scripts/osint/modules/10-search.mjs";
import accounts from "../scripts/osint/modules/12-accounts.mjs";
import fec, { matchDonation } from "../scripts/osint/modules/18-fec.mjs";
import { patentsFrom } from "../scripts/osint/modules/20-patents.mjs";
import { scoreCandidate } from "../scripts/osint/modules/30-identity.mjs";
import { screen } from "../scripts/osint/modules/22-records.mjs";

const JANE = { name: "Jane Doe", company: "Acme Robotics", domain: "acmerobotics.com", handles: [], aliases: [] };

/** fake fetch: routes is [[regex, (url, init) => {status, body, headers}]]; unmatched URLs get 404. */
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
const run = (subject, modules, fetchImpl) => runOsint(subject, { outDir: mkdtempSync(join(tmpdir(), "osint-person-")), modules, fetchImpl, log: () => {} });

const DDG_HTML = `
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.linkedin.com%2Fin%2Fjanedoe&amp;rut=abc">Jane Doe - VP Operations - Acme Robotics | LinkedIn</a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Experience: <b>Acme Robotics</b> · Location: Austin, Texas · 500+ connections</a>
</div>
<div class="result results_links results_links_deep result--ad ">
  <h2 class="result__title"><a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=ads.example&amp;u3=x">Buy things</a></h2>
  <a class="result__snippet" href="x">An ad</a>
</div>
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.linkedin.com%2Fin%2Fsomeone-else">Sam Smith - Engineer | LinkedIn</a></h2>
  <a class="result__snippet" href="x">People also viewed: Jane Doe, Acme</a>
</div>`;

test("DuckDuckGo html: results decoded, ads dropped", () => {
  const r = parseDdgHtml(DDG_HTML);
  assert.equal(r.length, 2);
  assert.equal(r[0].url, "https://www.linkedin.com/in/janedoe");
  assert.match(r[0].title, /Jane Doe - VP Operations/);
  assert.match(r[0].snippet, /Location: Austin, Texas/);
});

test("search module: profile only when the title names him; sidebar mentions dropped; DDG block falls back", async () => {
  let ddg = 0;
  const f = fakeFetch([
    [/html\.duckduckgo\.com/, () => (++ddg === 1 ? { body: DDG_HTML } : { status: 202, body: "<div class='anomaly-modal'></div>" })],
    [/bing\.com\/search/, { body: "<rss><channel></channel></rss>" }],
    [/search\?q=.*format=json/, { status: 429, body: "slow down" }],
  ]);
  const res = await run(JANE, [{ ...search, budgetMs: 9000 }], f);
  const acc = res.rows.filter((r) => r.var === "social.accounts");
  assert.equal(acc.length, 1);
  assert.equal(acc[0].url, "https://www.linkedin.com/in/janedoe");
  assert.equal(acc[0].grade, "p"); // anchored by the company in the title
  assert.equal(acc[0].tier, "C");
  assert.ok(!res.rows.some((r) => r.url?.includes("someone-else")));
  const place = res.rows.find((r) => r.var === "place.home_metro");
  assert.match(place.value, /Austin, Texas/);
  assert.ok(res.misses.some((m) => /not run|blocked/.test(m.searched)));
});

test("classify: podcasts to talks, obituaries to family leads, aggregators to career", () => {
  assert.equal(classify({ title: "Jane Doe on the Ops Podcast", snippet: "", url: "https://podcasts.apple.com/us/podcast/x/id1" }, JANE).var, "voice.talks");
  assert.equal(classify({ title: "John Doe Obituary", snippet: "", url: "https://www.legacy.com/us/obituaries/x" }, JANE).var, "family.close_circle");
  assert.equal(classify({ title: "Jane Doe - Acme", snippet: "", url: "https://theorg.com/org/acme/jane-doe" }, JANE).var, "career.timeline");
  assert.equal(classify({ title: "Jane Doe", snippet: "", url: "https://www.instagram.com/janedoe/" }, JANE).var, "social.accounts");
  assert.equal(classify({ title: "Photo", snippet: "Jane Doe", url: "https://www.instagram.com/p/abc/" }, JANE).var, "news.articles");
});

test("Bing images: tiles parsed from the m= attribute", () => {
  const m = (o) => JSON.stringify(o).replace(/"/g, "&quot;");
  const html = `<a class="iusc" style="" m="${m({ murl: "https://img.example/jane.jpg", turl: "https://tse.example/t1", purl: "https://acmerobotics.com/team", t: "Jane Doe | Acme Robotics", desc: "VP Operations" })}" href="#">x</a>
    <a class="iusc" m="${m({ murl: "https://img.example/other.jpg", purl: "https://other.example/", t: "Someone &amp; Else" })}">y</a>`;
  const r = parseBingImages(html);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { image: "https://img.example/jane.jpg", thumb: "https://tse.example/t1", page: "https://acmerobotics.com/team", title: "Jane Doe | Acme Robotics", desc: "VP Operations" });
  assert.equal(r[1].title, "Someone & Else");
});

const FEC = {
  results: [
    { sub_id: "1", contributor_name: "DOE, JANE", contributor_first_name: "JANE", contributor_last_name: "DOE", contributor_employer: "ACME ROBOTICS INC", contributor_occupation: "VP OPERATIONS", contributor_city: "AUSTIN", contributor_state: "TX", contributor_zip: "787011234", contribution_receipt_amount: 2900, contribution_receipt_date: "2024-03-02T00:00:00", committee_id: "C001", committee: { name: "SMITH FOR SENATE", party: "DEM" }, pdf_url: "https://docquery.fec.gov/x.pdf" },
    { sub_id: "2", contributor_name: "DOE, JANE M", contributor_first_name: "JANE", contributor_last_name: "DOE", contributor_employer: "RETIRED", contributor_occupation: "RETIRED", contributor_city: "MIAMI", contributor_state: "FL", contribution_receipt_amount: 50, contribution_receipt_date: "2023-01-01T00:00:00", committee_id: "C002", committee: { name: "WINRED", party: "REP" } },
    { sub_id: "3", contributor_name: "DOE, JOHN", contributor_first_name: "JOHN", contributor_last_name: "DOE", contributor_employer: "ACME ROBOTICS", contribution_receipt_amount: 500, contribution_receipt_date: "2022-01-01T00:00:00", committee_id: "C003", committee: { name: "X PAC" } },
  ],
};

test("FEC: name + employer kept, namesakes dropped, summary and place written", async () => {
  const f = fakeFetch([[/api\.open\.fec\.gov/, { body: FEC }]]);
  const res = await run(JANE, [{ ...fec, budgetMs: 3000 }], f);
  assert.match(f.calls[0], /contributor_name=Doe%2C%20Jane/i);
  assert.match(f.calls[0], /api_key=DEMO_KEY/);
  const d = res.rows.filter((r) => r.var === "politics.donations");
  assert.equal(d.length, 1);
  assert.equal(d[0].value, "$2,900 to SMITH FOR SENATE, 2024-03-02");
  assert.equal(d[0].tier, "A");
  assert.deepEqual(d[0].anchors, ["name", "company"]);
  assert.equal(d[0].detail.occupation, "VP OPERATIONS");
  const sum = res.rows.find((r) => r.var === "cause.political");
  assert.match(sum.value, /1 federal contribution\(s\), \$2,900/);
  assert.match(sum.value, /Democratic \$2,900/);
  assert.match(res.rows.find((r) => r.var === "place.home_metro").value, /AUSTIN, TX 78701/);
  assert.equal(matchDonation(FEC.results[2], JANE), null);
  assert.equal(matchDonation(FEC.results[1], JANE).grade, "w");
});

test("FEC: a 429 is recorded as unknown, not as none", async () => {
  const f = fakeFetch([[/api\.open\.fec\.gov/, { status: 429, body: { error: { code: "OVER_RATE_LIMIT" } } }]]);
  const res = await run(JANE, [{ ...fec, budgetMs: 3000 }], f);
  assert.equal(res.rows.length, 0);
  assert.match(res.misses[0].searched, /429.*unknown rather than none/);
});

test("sweep: a generic Instagram or TikTok page without his name never counts", async () => {
  const f = fakeFetch([
    [/instagram\.com/, { body: `<html><head><meta property="og:title" content="Instagram"><title>Instagram</title></head></html>` }],
    [/threads\.com/, { body: `<html><head><title>Threads</title></head></html>` }],
    [/tiktok\.com\/@janedoe$/, { body: `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({ __DEFAULT_SCOPE__: { "webapp.user-detail": { statusCode: 0, userInfo: { user: { uniqueId: "janedoe", nickname: "DJ Jay", signature: "beats" }, stats: { followerCount: 9 } } } } })}</script>` }],
    [/tiktok\.com/, { body: `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">{"__DEFAULT_SCOPE__":{"webapp.user-detail":{"statusCode":10221}}}</script>` }],
    [/youtube\.com\/@janedoe$/, { body: `<meta property="og:title" content="Jane Doe"><meta property="og:description" content="Ops at Acme Robotics. Marathoner.">` }],
    [/pinterest\.com/, { body: `<meta property="og:description" content="">` }],
    [/twitch\.tv|t\.me|steamcommunity/, { body: `<meta property="og:title" content="Twitch">` }],
  ]);
  const res = await run(JANE, [{ ...accounts, budgetMs: 9000 }], f);
  const acc = res.rows.filter((r) => r.var === "social.accounts");
  assert.equal(acc.length, 1, acc.map((a) => a.value).join("\n"));
  assert.equal(acc[0].url, "https://www.youtube.com/@janedoe");
  assert.deepEqual(acc[0].anchors, ["name", "company"]);
  assert.ok(!res.rows.some((r) => /instagram|tiktok/.test(r.url || "") && r.var === "social.accounts"));
  assert.ok(res.misses.some((m) => /instagram: not checkable/.test(m.searched)));
});

test("handles: derived from the name, and read back from profile URLs", () => {
  assert.deepEqual(derivedHandles({ name: "Gabriel Venhaus" }), ["gabrielvenhaus", "gabriel.venhaus", "gabriel_venhaus", "gvenhaus", "gabrielv", "gabevenhaus"]);
  assert.equal(handleFromUrl("https://www.linkedin.com/in/janedoe/"), "janedoe");
  assert.equal(handleFromUrl("https://www.youtube.com/@JaneDoe"), "JaneDoe");
  assert.equal(handleFromUrl("https://www.instagram.com/p/xyz/"), null);
  assert.equal(handleFromUrl("https://github.com/janedoe/repo"), null);
  assert.ok(nameMatch("Rick Kessler joins Harlow", { name: "Richard Kessler" }));
  assert.ok(!companyIn("Making progress on my goals", { name: "X", company: "Progress Software" }));
  assert.ok(companyIn("EVP at Progress Software", { name: "X", company: "Progress Software" }));
});

test("identity score: company + shared handle verifies, a different company marks a namesake", () => {
  const li = { site: "linkedin", handle: "janedoe", url: "https://www.linkedin.com/in/janedoe", name: "Jane Doe", title: "Jane Doe - Acme Robotics | LinkedIn" };
  const yt = { site: "youtube", handle: "janedoe", url: "https://www.youtube.com/@janedoe", name: "Jane Doe" };
  const other = { site: "linkedin", handle: "jane-doe-2", url: "https://www.linkedin.com/in/jane-doe-2", title: "Jane Doe - Globex Bank | LinkedIn", snippet: "Location: Miami, FL" };
  const all = [li, yt, other];
  const shared = { reverseHits: [] };
  const s1 = scoreCandidate(li, JANE, shared, all);
  assert.equal(s1.score, 8);
  assert.equal(s1.verdict, "verified"); // name +2, company +4, same handle +2: two families besides the name
  const s1b = scoreCandidate(li, { ...JANE, city: "Austin" }, { reverseHits: [{ page: "https://www.linkedin.com/in/janedoe" }] }, all);
  assert.equal(s1b.verdict, "verified");
  assert.ok(s1b.reasons.includes("headshot reused +3"));
  const s2 = scoreCandidate(yt, JANE, shared, all);
  assert.equal(s2.score, 4);
  assert.equal(s2.verdict, "likely");
  const s3 = scoreCandidate(other, { ...JANE, state: "TX" }, shared, all);
  assert.equal(s3.score, -4);
  assert.equal(s3.verdict, "namesake");
});

test("patents: family copies collapse, other inventors with the surname are dropped", () => {
  const p = (n, title, inv, a = "Playtex Products, Inc.") => ({ patent: { title: ` ${title}`, publication_number: n, inventor: `<b>${inv}</b>`, assignee: a, priority_date: "2004-02-03" } });
  const json = { results: { cluster: [{ result: [p("EP1B1", "Waste disposal device", "Richard Kessler"), p("US7500339B2", "Waste disposal device", "Richard S Kessler"), p("EP2B1", "Flow meter", "Alain Kessler", "Endress+Hauser")] }] } };
  const r = patentsFrom(json, { name: "Richard Kessler" });
  assert.equal(r.length, 1);
  assert.equal(r[0].number, "US7500339B2");
});

test("sanctions screen: surname + first name on SDN and LEIE rows", () => {
  const sdn = `36,"AL-QAIDA, Jane",individual,SDGT,-0- \n37,"DOE, Jane",individual,SDGT,-0-,-0-,-0-,-0-,-0-,-0-,-0-,"DOB 1970"\n38,"DOE, John",individual,X`;
  assert.equal(screen(sdn, JANE, "sdn").length, 1);
  const leie = `LASTNAME,FIRSTNAME,MIDNAME,BUSNAME\nDOE,JANE,M,,IND,NURSE,,,19700101,1 MAIN,AUSTIN,TX,78701,1128a1,20200101`;
  assert.equal(screen(leie, JANE, "leie")[0].detail.state, "TX");
});
