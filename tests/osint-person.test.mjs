// Person-side OSINT modules. No network: every call goes to a fake fetch that answers from the
// small fixtures below, routed by URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOsint } from "../scripts/osint/run.mjs";
import { parseDdgHtml, parseBingImages, nameMatch, nameVariants, firstForms, companyIn, derivedHandles, handleFromUrl, looksLikeEducation } from "../scripts/osint/person-lib.mjs";
import search, { classify, queryPlan, isoDay } from "../scripts/osint/modules/10-search.mjs";
import accounts from "../scripts/osint/modules/12-accounts.mjs";
import profiles from "../scripts/osint/modules/14-profiles.mjs";
import images, { imageKeeps } from "../scripts/osint/modules/16-images.mjs";
import fec, { matchDonation } from "../scripts/osint/modules/18-fec.mjs";
import { patentsFrom } from "../scripts/osint/modules/20-patents.mjs";
import identity, { scoreCandidate, statedCompany, isPlace, departureSignals } from "../scripts/osint/modules/30-identity.mjs";
import { screen } from "../scripts/osint/modules/22-records.mjs";
import wdNews from "../scripts/osint/modules/24-wikidata-news.mjs";
import talks, { parseYouTubeResults, approxDate } from "../scripts/osint/modules/25-talks.mjs";
import quotes, { extractQuotes } from "../scripts/osint/modules/26-quotes.mjs";
import aliases, { aliasesIn } from "../scripts/osint/modules/27-aliases.mjs";

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
  const res = await run(JANE, [{ ...search, budgetMs: 9000 }, identity], f);
  // The profile goes through the identity score: "Jane Doe - ... - Acme Robotics" states the employer.
  const acc = res.rows.filter((r) => r.var === "social.accounts");
  assert.equal(acc.length, 1);
  assert.equal(acc[0].url, "https://www.linkedin.com/in/janedoe");
  // one source (the LinkedIn page itself) states name and employer: Partly, not Verified
  assert.equal(acc[0].grade, "p");
  assert.equal(acc[0].module, "identity");
  assert.equal(acc[0].weights, acc[0].detail.weights);
  assert.ok(!res.rows.some((r) => r.url?.includes("someone-else")));
  const place = res.rows.find((r) => r.var === "place.home_metro");
  assert.match(place.value, /Austin, Texas/);
  assert.ok(res.misses.some((m) => /blocked \(202\)|blocked \(HTTP 202\)|not run: engine blocked/.test(m.searched)), res.misses.map((m) => m.searched).join("\n"));
});

test("classify: podcasts to talks, obituaries to family leads, aggregators to career", () => {
  assert.equal(classify({ title: "Jane Doe on the Ops Podcast", snippet: "", url: "https://podcasts.apple.com/us/podcast/x/id1" }, JANE).var, "voice.talks");
  assert.equal(classify({ title: "John Doe Obituary", snippet: "", url: "https://www.legacy.com/us/obituaries/x" }, JANE).var, "family.close_circle");
  assert.equal(classify({ title: "Jane Doe - Acme", snippet: "", url: "https://theorg.com/org/acme/jane-doe" }, JANE).var, "career.timeline");
  assert.equal(classify({ title: "Jane Doe", snippet: "", url: "https://www.instagram.com/janedoe/" }, JANE).var, "social.accounts");
  assert.equal(classify({ title: "Jane Doe on LinkedIn: we shipped", snippet: "", url: "https://www.linkedin.com/posts/janedoe_ops-activity-1" }, JANE).var, "social.work_posts");
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
  assert.ok(res.misses.some((m) => /FEC API: blocked \(HTTP 429\), unknown · fix: set FEC_API_KEY/.test(m.searched)));
  assert.ok(res.misses.some((m) => m.var === "cause.political" && /unknown rather than none/.test(m.searched)));
  assert.ok(!res.rows.some((r) => /No federal contributions/.test(r.value)), "a 429 never becomes 'none on record'");
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
  const res = await run(JANE, [{ ...accounts, budgetMs: 9000 }, identity], f);
  const acc = res.rows.filter((r) => r.var === "social.accounts");
  assert.equal(acc.length, 1, acc.map((a) => a.value).join("\n"));
  assert.equal(acc[0].url, "https://www.youtube.com/@janedoe");
  assert.deepEqual(acc[0].anchors, ["name", "company"]);
  assert.ok(!res.rows.some((r) => r.module === "accounts" && r.var === "social.accounts"), "the sweep itself writes no account rows");
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

test("identity score: employer on the profile verifies, a different company marks a namesake", () => {
  const li = { site: "linkedin", handle: "janedoe", url: "https://www.linkedin.com/in/janedoe", name: "Jane Doe", title: "Jane Doe - Acme Robotics | LinkedIn" };
  const yt = { site: "youtube", handle: "janedoe", url: "https://www.youtube.com/@janedoe", name: "Jane Doe" };
  const other = { site: "linkedin", handle: "jane-doe-2", url: "https://www.linkedin.com/in/jane-doe-2", title: "Jane Doe - Globex Bank | LinkedIn", snippet: "Location: Miami, FL" };
  const all = [li, yt, other];
  const shared = { reverseHits: [] };
  const s1 = scoreCandidate(li, JANE, shared, all);
  assert.equal(s1.score, 7);
  // name +2, employer on the profile +5: the page alone is one source, so likely (Partly), never verified
  assert.equal(s1.verdict, "likely");
  assert.deepEqual(s1.signalSources, ["linkedin"]);
  const s1b = scoreCandidate(li, { ...JANE, city: "Austin" }, { reverseHits: [{ page: "https://www.linkedin.com/in/janedoe" }] }, all);
  assert.ok(s1b.reasons.includes("headshot reused +3"));
  assert.ok(["likely", "verified"].includes(s1b.verdict));
  // employer, headshot and an official link: three anchors from three sources verify
  const s1c = scoreCandidate(li, JANE, { reverseHits: [{ page: "https://www.linkedin.com/in/janedoe" }], officialLinks: ["https://www.linkedin.com/in/janedoe"] }, all);
  assert.equal(s1c.verdict, "verified");
  assert.ok(s1c.p >= 0.99 && s1c.signalSources.length >= 2);
  // The YouTube account shares only a handle derived from the name: no bonus, name alone = unclear.
  const s2 = scoreCandidate(yt, JANE, shared, all);
  assert.equal(s2.score, 2);
  assert.equal(s2.verdict, "unclear");
  const s3 = scoreCandidate(other, { ...JANE, state: "TX" }, shared, all);
  assert.equal(s3.verdict, "namesake");
  // the employer field verifies only under the exact given name, not a formal or nickname form
  const steven = { site: "linkedin", handle: "steven-ferrante-1", url: "https://www.linkedin.com/in/steven-ferrante-1", title: "Steven Ferrante - Lumen Arcade | LinkedIn" };
  assert.equal(scoreCandidate(steven, { name: "Steve Ferrante", company: "Lumen Arcade", domain: "lumenarcade.com" }, {}, [steven]).verdict, "likely");
});

test("identity: 16 strangers sharing a derived handle are never 'likely' (Steve Ferrante case)", () => {
  const S = { name: "Steve Ferrante", company: "Lumen Arcade", domain: "lumenarcade.com" };
  const sites = ["chess.com", "x", "pinterest", "myspace", "medium", "substack", "kaggle", "vimeo", "telegram", "tiktok", "calendly", "flickr", "about.me"];
  const all = sites.map((site) => ({ site, handle: "steveferrante", url: `https://${site}/steveferrante`, name: "Steve Ferrante", sources: ["sweep:derived"] }));
  const likely = all.map((c) => scoreCandidate(c, S, {}, all)).filter((x) => x.verdict === "likely" || x.verdict === "verified");
  assert.equal(likely.length, 0);
});

test("identity: real LinkedIn is not penalised for a place in the title or for a new employer the news names", () => {
  const holloway = { name: "Dan Holloway", company: "Sentrylink", domain: "sentrylink.com" };
  const k = { site: "linkedin", handle: "dan-holloway-b5264", url: "https://www.linkedin.com/in/dan-holloway-b5264", title: "Dan Holloway - McLean, Virginia, United States | Professional Profile | LinkedIn", snippet: "Location: McLean · 500+ connections" };
  assert.equal(statedCompany(k), null);
  assert.ok(isPlace("McLean, Virginia, United States") && isPlace("Greater Chicago Area") && !isPlace("Kestrel Studios"));
  const sk = scoreCandidate(k, holloway, {}, [k]);
  assert.ok(sk.score >= 2 && !sk.reasons.some((r) => /-3/.test(r)), sk.reasons.join(", "));
  const vhn = { site: "linkedin", handle: "dan-holloway-15115012", url: "https://www.linkedin.com/in/dan-holloway-15115012", title: "Dan Holloway - CEO - VHN | LinkedIn" };
  assert.equal(scoreCandidate(vhn, holloway, {}, [k, vhn]).verdict, "namesake");

  const ferrante = { name: "Steve Ferrante", company: "Lumen Arcade", domain: "lumenarcade.com" };
  const shared = { searchResults: [{ title: "Former Lumen Arcade VP Steve Ferrante appointed chief business officer at Kestrel Studios", snippet: "Former Lumen Arcade vice president Steve Ferrante has joined Kestrel Studios", url: "https://news.example/a" }] };
  const li = { site: "linkedin", handle: "steveferrante", url: "https://www.linkedin.com/in/steveferrante", name: "Steve Ferrante", company: "Kestrel Studios", bio: "Experience: Kestrel Studios · Location: Cary", sources: ["sweep:derived"] };
  const s = scoreCandidate(li, ferrante, shared, [li]);
  assert.equal(s.verdict, "likely", s.reasons.join(", "));
  assert.ok(s.reasons.some((r) => /Kestrel Studios.*\+4/.test(r)));
  const dep = departureSignals(ferrante, shared, [{ ...li, ...s, otherEmployer: { name: "Kestrel Studios" } }]);
  assert.ok(dep.some((d) => d.kind === "news") && dep.some((d) => d.kind === "profile"));
  assert.equal(departureSignals(ferrante, { searchResults: [{ title: "Steve Ferrante on the Lumen Arcade Store roadmap", snippet: "Lumen Arcade", url: "x" }] }).length, 0);
});

test("identity module: only verified/likely in social.accounts, departure raised as an alert", async () => {
  const S = { name: "Steve Ferrante", company: "Lumen Arcade", domain: "lumenarcade.com", handles: [], aliases: [] };
  const seed = {
    id: "seed", lane: "fast", async run(ctx) {
      ctx.shared.searchResults = [{ title: "Lumen Arcade Store boss quits after 8 years to take up new role at Kestrel", snippet: "Steve Ferrante, VP and GM of the Lumen Arcade Store, is leaving", url: "https://pcgamer.example/x" }];
      ctx.shared.accounts = [
        { site: "chess.com", handle: "steveferrante", url: "https://www.chess.com/member/steveferrante", name: "Steve Ferrante", location: "Burleson, Texas", avatar: "https://img.example/a.png", source: "derived", confirmed: true },
        { site: "x", handle: "steveferrante", url: "https://x.com/steveferrante", name: "Steve Ferrante", bio: "Orange County, CA", avatar: "https://img.example/b.png", source: "derived", confirmed: true },
        { site: "linkedin", handle: "steve-ferrante-epic", url: "https://www.linkedin.com/in/steve-ferrante-epic", name: "Steve Ferrante", company: "Lumen Arcade", source: "search", confirmed: true },
      ];
    },
  };
  const res = await run(S, [seed, identity], fakeFetch([]));
  const acc = res.rows.filter((r) => r.var === "social.accounts");
  assert.deepEqual(acc.map((r) => r.url), ["https://www.linkedin.com/in/steve-ferrante-epic"]);
  const cands = res.rows.filter((r) => r.var === "social.candidates" && r.detail?.verdict !== "summary");
  assert.ok(cands.every((r) => !r.image), "namesake avatars are never attached");
  assert.ok(cands.every((r) => r.grade === "w" || r.grade === "i"));
  // run.mjs's departure check sees the headline first; identity adds its own alert only when that found nothing.
  const alerts = [...(res.alerts || []).map((a) => a.text), ...res.rows.filter((r) => r.detail?.alert).map((r) => r.detail.alert.text)];
  assert.equal(alerts.filter((t) => /may have left Lumen Arcade/.test(t)).length, 1, alerts.join("\n"));
});

test("identity: a likely profile naming a new employer raises the departure alert when the news check did not", async () => {
  const S = { name: "Steve Ferrante", company: "Lumen Arcade", domain: "lumenarcade.com", handles: [], aliases: [] };
  const seed = { id: "seed", lane: "fast", async run(ctx) {
    ctx.shared.searchResults = [{ title: "Steve Ferrante and Lumen Arcade Store at Kestrel Studios showcase", snippet: "Steve Ferrante, Lumen Arcade veteran, Kestrel Studios", url: "https://news.example/s" }];
    ctx.shared.accounts = [{ site: "linkedin", handle: "steveferrante", url: "https://www.linkedin.com/in/steveferrante", name: "Steve Ferrante", company: "Kestrel Studios", source: "derived", confirmed: true }];
  } };
  const res = await run(S, [seed, identity], fakeFetch([]));
  const row = res.rows.find((r) => r.var === "role.status");
  assert.match(row.value, /may have left Lumen Arcade[^]*Kestrel Studios/);
  assert.equal(row.detail.alert.level, "red");
  assert.equal(res.rows.find((r) => r.var === "social.accounts").grade, "p");
});

test("names: adjacent words only, nicknames both ways", () => {
  const S = { name: "Steve Ferrante" };
  assert.ok(!nameMatch("Steve & Ferrante Black Sea crossover", S));
  assert.ok(!nameMatch("steve + ferrante — blow your mind", S));
  assert.ok(!nameMatch("Steve and Ferrante", S));
  assert.ok(nameMatch("Ferrante, Steve", S));
  assert.ok(nameMatch("Stephen P. Ferrante joins", S));
  assert.deepEqual(nameVariants({ name: "Dan Holloway" }), ["Dan Holloway", "Daniel Holloway"]);
  assert.ok(nameVariants({ name: "Jenny Calder" }).includes("Jennifer Calder"));
  assert.ok(firstForms("jennifer").includes("jenny") && firstForms("jenny").includes("jennifer"));
  assert.ok(nameMatch("Jennifer Calder, Vice President", { name: "Jenny Calder" }));
});

test("search: employer-anchored and formal-name queries come first; dates are ISO", () => {
  const plan = queryPlan({ name: "Dan Holloway", company: "Sentrylink" }).map((x) => x[0]);
  assert.equal(plan[0], '"Dan Holloway" "Sentrylink"');
  assert.ok(plan.indexOf('"Daniel Holloway" "Sentrylink"') < plan.indexOf('"Dan Holloway" site:instagram.com'));
  assert.equal(isoDay("Wed, 18 Nov 2026 15:39:00 GMT"), "2026-11-18");
});

test("search: name-only namesake hits and fan edits are set aside; every engine blocked is reported blocked", async () => {
  const S = { name: "Steve Ferrante", company: "Lumen Arcade", domain: "lumenarcade.com", handles: [], aliases: [] };
  const rss = `<rss><channel>
    <item><title>Steve Ferrante - Wikipedia</title><link>https://en.wikipedia.org/wiki/Steve_Ferrante</link><description>American politician, Texas House</description></item>
    <item><title>Steve &amp; Ferrante Black Sea crossover - YouTube</title><link>https://www.youtube.com/watch?v=abc</link><description>fan edit</description></item>
    <item><title>Lumen Arcade Store boss Steve Ferrante on PC exclusives</title><link>https://news.example/x</link><description>interview with Steve Ferrante</description></item>
  </channel></rss>`;
  const f = fakeFetch([[/html\.duckduckgo\.com/, { status: 202, body: "anomaly-modal" }], [/bing\.com\/search/, { body: rss }], [/format=json/, { status: 429, body: "x" }]]);
  const res = await run(S, [{ ...search, budgetMs: 12000 }], f);
  const urls = res.rows.map((r) => r.url);
  assert.ok(urls.includes("https://news.example/x"));
  assert.ok(!urls.includes("https://en.wikipedia.org/wiki/Steve_Ferrante"));
  assert.ok(!urls.includes("https://www.youtube.com/watch?v=abc"));
  const f2 = fakeFetch([[/duckduckgo/, { status: 202, body: "anomaly-modal" }], [/bing\.com/, { status: 429, body: "" }], [/format=json/, { status: 429, body: "x" }]]);
  const res2 = await run(S, [{ ...search, budgetMs: 12000 }], f2);
  assert.ok(res2.misses.some((m) => m.var === "news.articles" && /blocked \(HTTP 202\), unknown · fix: set BRAVE_API_KEY/.test(m.searched)), res2.misses.map((m) => m.searched).join("\n"));
});

test("FEC: nickname and formal name both queried and matched; grade p needs employer or place", async () => {
  const S = { name: "Jenny Calder", company: "Halvorsen", domain: "halvorsen.com", handles: [], aliases: [] };
  const recs = { results: [
    { sub_id: "1", contributor_name: "CALDER, JENNIFER", contributor_first_name: "JENNIFER", contributor_last_name: "CALDER", contributor_employer: "HALVORSEN INC", contributor_city: "COLUMBUS", contributor_state: "IN", contribution_receipt_amount: 500, contribution_receipt_date: "2024-01-01", committee: { name: "HALVORSEN INC PAC" } },
    { sub_id: "2", contributor_name: "CALDER, JENNY", contributor_first_name: "JENNY", contributor_last_name: "CALDER", contributor_employer: "SELF", contributor_city: "TAMPA", contributor_state: "FL", contribution_receipt_amount: 25, contribution_receipt_date: "2024-02-01", committee: { name: "ACTBLUE" } },
    { sub_id: "3", contributor_name: "CALDERWOOD, JENNIFER", contributor_first_name: "JENNIFER", contributor_last_name: "CALDERWOOD", contributor_employer: "HALVORSEN", contribution_receipt_amount: 25, contribution_receipt_date: "2024-02-01", committee: { name: "X" } },
  ] };
  const f = fakeFetch([[/api\.open\.fec\.gov/, { body: recs }]]);
  const res = await run(S, [{ ...fec, budgetMs: 3000 }], f);
  assert.ok(f.calls.some((u) => /contributor_name=Calder%2C%20Jenny/.test(u)) && f.calls.some((u) => /contributor_name=Calder%2C%20Jennifer/.test(u)));
  assert.ok(f.calls.every((u) => /api_key=DEMO_KEY/.test(u)), "DEMO_KEY only, never a scraped key");
  const d = res.rows.filter((r) => r.var === "politics.donations");
  assert.equal(d.length, 1);
  assert.equal(d[0].grade, "p");
  assert.equal(matchDonation(recs.results[1], S).grade, "w");
  assert.equal(matchDonation(recs.results[2], S), null, "a longer surname is not a match");
});

test("images: the name AND (company or title) on the page; job ads and look-alikes dropped", async () => {
  const S = { name: "Jane Doe", company: "Acme Robotics", domain: "acmerobotics.com", title: "VP Operations", handles: [], aliases: [] };
  assert.deepEqual(imageKeeps({ title: "Jane Doe | Acme Robotics", page: "https://acmerobotics.com/team" }, S), ["name", "company"]);
  assert.ok(imageKeeps({ title: "Jane Doe, operations leader", page: "https://x.example/" }, S));
  assert.equal(imageKeeps({ title: "Jane Doe", page: "https://x.example/" }, S), null);
  assert.equal(imageKeeps({ title: "Jane Doe hiring at Acme Robotics - Jobs", page: "https://indeed.com/jobs/1" }, S), null);
  const m = (o) => JSON.stringify(o).replace(/"/g, "&quot;");
  const tiles = Array.from({ length: 20 }, (_, i) => `<a class="iusc" m="${m({ murl: `https://img.example/${i}.jpg`, purl: `https://acmerobotics.com/p${i}`, t: `Jane Doe at Acme Robotics ${i}` })}">x</a>`).join("") + `<a class="iusc" m="${m({ murl: "https://img.example/z.jpg", purl: "https://z.example/", t: "Jane Doe" })}">y</a>`;
  const yandexState = JSON.stringify({ initialState: { cbirSites: { sites: [{ title: "Bob Cone - GitHub", url: "https://github.com/bob", domain: "github.com", originalImage: { url: "https://img/bob" } }] }, cbirTags: { tags: ["craig brown"] } } }).replace(/"/g, "&quot;");
  const f = fakeFetch([[/bing\.com\/images/, { body: tiles }], [/commons\.wikimedia/, { body: { query: { pages: {} } } }], [/yandex\.com/, { body: `<div data-state="${yandexState}"></div>` }]]);
  const res = await run({ ...S, photo: "https://img.example/jane.jpg" }, [{ ...images, budgetMs: 5000 }], f);
  assert.match(f.calls.find((u) => /bing/.test(u)), /Acme%20Robotics/, "employer in the image query");
  assert.equal(res.rows.filter((r) => r.var === "pic.image_results").length, 12, "capped at 12");
  assert.ok(!res.rows.some((r) => r.var === "pic.reverse"), "look-alikes and Yandex tags are not rows");
  assert.ok(res.misses.some((m) => /look-alikes not shown/.test(m.searched)));
});

test("profiles: a namesake's account is not read; a verified one is", async () => {
  const seed = { id: "seed", lane: "fast", async run(ctx) {
    ctx.shared.accounts = [
      { site: "chess.com", handle: "janedoe", url: "https://chess.com/janedoe", name: "Jane Doe", location: "Burleson, Texas", source: "derived", confirmed: true, anchors: ["name"] },
      { site: "github", handle: "jdoe-acme", url: "https://github.com/jdoe-acme", name: "Jane Doe", company: "@acmerobotics", location: "Austin, TX", source: "search", confirmed: true, anchors: ["name", "company"] },
    ];
  } };
  const f = fakeFetch([[/api\.github\.com\/users\/jdoe-acme\/repos/, { body: [] }]]);
  const res = await run(JANE, [seed, { ...profiles, budgetMs: 5000 }], f);
  const metro = res.rows.filter((r) => r.var === "place.home_metro").map((r) => r.value);
  assert.ok(metro.some((v) => /Austin/.test(v)));
  assert.ok(!metro.some((v) => /Burleson/.test(v)), metro.join("; "));
  assert.ok(res.rows.filter((r) => r.module === "profiles").every((r) => r.grade === "p"));
});

test("wikidata: a same-name entity without the company gives no education; news headlines must name him", async () => {
  const S = { name: "Steve Ferrante", company: "Lumen Arcade", domain: "lumenarcade.com", handles: [], aliases: [] };
  const ent = { Q1: { id: "Q1", labels: { en: { value: "Steve Ferrante" } }, descriptions: { en: { value: "American politician" } }, claims: { P31: [{ mainsnak: { datavalue: { value: { id: "Q5" } } } }], P69: [{ mainsnak: { datavalue: { value: { id: "Q9" } } } }] } } };
  const gd = { articles: [{ title: "Funeral notices in the Chronicle last week", url: "https://c.example/f", domain: "c.example", seendate: "20261101T000000Z" }, { title: "Lumen Arcade Store overhaul might be too little, says analyst", url: "https://e.example/a", domain: "e.example", seendate: "20261102T000000Z" }] };
  const f = fakeFetch([
    [/wbsearchentities/, { body: { search: [{ id: "Q1", label: "Steve Ferrante" }] } }],
    [/wbgetentities/, { body: { entities: ent } }],
    [/gdeltproject/, { body: gd }],
    [/news\.google\.com/, { body: "<rss><channel></channel></rss>" }],
  ]);
  const [wd, gdelt] = wdNews;
  const res = await run(S, [wd, { ...gdelt, budgetMs: 8000 }], f);
  assert.ok(!res.rows.some((r) => r.var === "career.education"));
  assert.equal(res.rows.find((r) => r.var === "career.timeline").grade, "i");
  const news = res.rows.filter((r) => r.var === "news.articles").map((r) => r.url);
  assert.deepEqual(news, ["https://e.example/a"]);
});

test("talks: YouTube ytInitialData parsed; only videos naming him with the company", async () => {
  const S = { name: "Steve Ferrante", company: "Lumen Arcade", domain: "lumenarcade.com", handles: [], aliases: [] };
  const vr = (id, title, snip, ch = "IGN", pub = "2 years ago") => ({ videoRenderer: { videoId: id, title: { runs: [{ text: title }] }, ownerText: { runs: [{ text: ch }] }, publishedTimeText: { simpleText: pub }, lengthText: { simpleText: "4:09" }, detailedMetadataSnippets: [{ snippetText: { runs: [{ text: snip }] } }] } });
  const data = { contents: { a: { b: [vr("v1", "State of Unreal 2024", "Lumen Arcade Store general manager Steve Ferrante announced"), vr("v2", "WWA4 Steve Ferrante Vs. Ric King!", "an epic encounter"), vr("v3", "Steve & Ferrante | crossover", "Lumen Arcade fan edit")] } } };
  const html = `<script>var ytInitialData = ${JSON.stringify(data)};</script>`;
  assert.equal(parseYouTubeResults(html).length, 3);
  assert.ok(approxDate("2 years ago").startsWith(String(new Date().getUTCFullYear() - 2)));
  const res = await run(S, [talks], fakeFetch([[/youtube\.com\/results/, { body: html }]]));
  const t = res.rows.filter((r) => r.var === "voice.talks");
  assert.deepEqual(t.map((r) => r.url), ["https://www.youtube.com/watch?v=v1"]);
  assert.ok(t[0].date);
  const blocked = await run(S, [talks], fakeFetch([[/youtube/, { status: 429, body: "" }]]));
  assert.match(blocked.misses[0].searched, /YouTube search: blocked \(HTTP 429\), unknown/);
});

test("quotes: 'said <Name>' and '<Name> said' forms, surname only when the full name is present", async () => {
  const S = { name: "Dan Holloway", company: "Sentrylink", domain: "sentrylink.com", handles: [], aliases: [] };
  const text = "Sentrylink today announced a new platform. “We are thrilled to bring this platform to more partners this year,” said Daniel Holloway, President of Platforms. Later, Holloway said: “Our partners asked for this and we listened carefully to them.” “Unrelated words from someone else in the release,” said Kevin Bradley.";
  const q = extractQuotes(text, S);
  assert.equal(q.length, 2);
  assert.ok(!q.some((x) => /Unrelated/.test(x)));
  assert.equal(extractQuotes("“Holloway said things that are long enough to count here,” said Holloway.", S).length, 0, "surname alone without the full name");
  const seed = { id: "seed", lane: "fast", async run(ctx) { ctx.shared.searchResults = [{ title: "Sentrylink launches X", snippet: "", url: "https://www.prnewswire.com/news-releases/x.html" , q: "x" }, { title: "Sentrylink launches X - Dan Holloway", snippet: "", url: "https://www.prnewswire.com/news-releases/y.html" }]; } };
  const f = fakeFetch([[/prnewswire\.com\/news-releases\/y/, { body: `<html><head><meta property="og:title" content="Sentrylink launches X"></head><body>${text}</body></html>` }], [/efts\.sec\.gov/, { body: { hits: { hits: [] } } }]]);
  const res = await run(S, [seed, quotes], f);
  const rows = res.rows.filter((r) => r.var === "voice.quotes");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].grade, "p");
});

test("aliases: maiden and former names from snippets that name the company; used by later modules", async () => {
  const S = { name: "Dana Whitlock", company: "Progress Software", domain: "progress.com", handles: [], aliases: [] };
  assert.deepEqual(aliasesIn("Dana (Albrecht) Whitlock - Progress Software | LinkedIn", S).map((a) => a.alias), ["Dana Albrecht"]);
  assert.deepEqual(aliasesIn("Dana Whitlock, née Albrecht, EVP at Progress Software", S).map((a) => a.alias), ["Dana Albrecht"]);
  assert.equal(aliasesIn("Jenny (Jennifer) Calder at Halvorsen", { name: "Jenny Calder" }).length, 0, "a formal first name is not an alias");
  const seed = { id: "seed", lane: "fast", async run(ctx) { ctx.shared.searchResults = [{ title: "Dana (Albrecht) Whitlock - Progress Software | LinkedIn", snippet: "", url: "https://www.linkedin.com/in/lj" }, { title: "Dana (Smith) Whitlock wedding", snippet: "", url: "https://w.example" }]; } };
  const subj = { ...S };
  const res = await run(subj, [seed, aliases], fakeFetch([]));
  const r = res.rows.filter((x) => x.var === "names.aliases");
  assert.equal(r.length, 1);
  assert.match(r[0].value, /Dana Albrecht/);
  assert.deepEqual(subj.foundAliases, ["Dana Albrecht"]);
  assert.ok(nameMatch("Dana Albrecht, KMWorld 2010", subj));
});

test("education must look like education", () => {
  assert.ok(!looksLikeEducation("In the fourth quarter of 2025, our CEO recommended to the TMCC, and the TMCC approved, a determination that Ms. Calder earned the grant"));
  assert.ok(looksLikeEducation("B.A., Dartmouth College; M.B.A., The Wharton School"));
  assert.ok(looksLikeEducation("California State University-Fullerton (LinkedIn public profile)"));
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

test("FEC: payroll PAC deductions collapse to one row per committee; the tile uses the summary total", async () => {
  const S = { name: "Jenny Calder", company: "Halvorsen", domain: "halvorsen.com", handles: [], aliases: [] };
  const rec = (i) => ({ sub_id: String(i), contributor_name: "CALDER, JENNIFER", contributor_first_name: "JENNIFER", contributor_last_name: "CALDER", contributor_employer: "HALVORSEN INC.", contributor_city: "INDIANAPOLIS", contributor_state: "IN", contribution_receipt_amount: 100, contribution_receipt_date: `2026-0${(i % 9) + 1}-15`, committee: { name: "HALVORSEN INC. PAC" } });
  const f = fakeFetch([[/api\.open\.fec\.gov/, { body: { results: Array.from({ length: 30 }, (_, i) => rec(i)) } }]]);
  const res = await run(S, [{ ...fec, budgetMs: 3000 }], f);
  const d = res.rows.filter((r) => r.var === "politics.donations");
  assert.equal(d.length, 1);
  assert.match(d[0].value, /\$3,000 to HALVORSEN INC\. PAC in 30 contributions/);
  const { renderDossier } = await import("../scripts/osint/dossier.mjs");
  const html = renderDossier(res);
  assert.match(html, /\$3,000 on record/);
});
