// Part 2 person/online OSINT modules. No network: every call goes to a fake fetch answering from
// recorded fixtures (tests/fixtures/osint-part2/person, public figures, trimmed) or small
// synthetic bodies, routed by URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { makeHttp } from "../scripts/osint/core.mjs";
import actorSearch, { mastodonMatches, makeAccount, pushAccount } from "../scripts/osint/modules/40-actor-search.mjs";
import gravatar, { gravatarProfile, gravatarTie, sha256 } from "../scripts/osint/modules/41-gravatar.mjs";
import githubEmail, { commitAuthors } from "../scripts/osint/modules/42-github-email.mjs";
import verifiedLinks, { keybaseProofs, mastodonVerified, anchoredRoot } from "../scripts/osint/modules/43-verified-links.mjs";
import linkpages, { parseLinktree, relMeLinks } from "../scripts/osint/modules/44-linkpages.mjs";
import devCommunities, { seMatches, hnActivity } from "../scripts/osint/modules/45-dev-communities.mjs";
import packageRegistries, { cratesSummary, pypiUser, gemsSummary } from "../scripts/osint/modules/46-package-registries.mjs";
import hobbyApis, { letterboxdFeed, chessRatings } from "../scripts/osint/modules/47-hobby-apis.mjs";
import wikipedia, { wikiTitles, wikiAnchors, viewSpikes } from "../scripts/osint/modules/48-wikipedia.mjs";
import scholarly, { openalexMatches, crossrefWorks, orcidEducation } from "../scripts/osint/modules/49-scholarly.mjs";
import feeds, { discoverFeed, channelIdFrom, feedUrlsFor } from "../scripts/osint/modules/80-feeds.mjs";
import mediaFeeds, { itunesEpisodes, podcastIndexHeaders } from "../scripts/osint/modules/81-media-feeds.mjs";
import books, { olAuthors } from "../scripts/osint/modules/82-books.mjs";

const FX = join(import.meta.dirname, "fixtures", "osint-part2", "person");
const fx = (f) => JSON.parse(readFileSync(join(FX, f), "utf8"));

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, headers: init.headers || {} });
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

/** Run one module with a minimal ctx (as run.mjs builds it) and return rows, misses, status and shared. */
async function runMod(mod, subject, { routes = [], shared = {}, env = {} } = {}) {
  const fetchImpl = fakeFetch(routes);
  const http = makeHttp({ cacheDir: mkdtempSync(join(tmpdir(), "osint-p2p-")), fetchImpl });
  const rows = [];
  const misses = [];
  let status = null;
  const ctx = {
    subject: { handles: [], aliases: [], ...subject },
    shared,
    http,
    env,
    opts: {},
    log: () => {},
    add: (f) => (rows.push(f), f),
    miss: (v, searched) => misses.push({ var: v, searched }),
    status: (s, why) => {
      if (!status || s === "blocked") status = { status: s, why };
    },
    alert: () => {},
  };
  await mod.run(ctx);
  return { rows, misses, status, shared, calls: fetchImpl.calls };
}

const EUGEN = { name: "Eugen Rochko", company: "Mastodon" };

test("actor-search: Mastodon name search keeps name matches, drops mirrors, keys mastodon.social accounts by bare username", async () => {
  const fixture = fx("mastodon-search-eugen-rochko.json");
  const m = mastodonMatches(fixture, EUGEN, "mastodon.social");
  assert.equal(m.length, 1);
  assert.equal(m[0].handle, "Gargron");
  assert.ok(m[0].extra.fields.some((f) => f.verified));
  const mirror = { accounts: [{ ...fixture.accounts[0], acct: "Gargron@mastodon-social.activitypub-proxy.cf", url: "https://mastodon-social.activitypub-proxy.cf/@Gargron" }] };
  assert.equal(mastodonMatches(mirror, EUGEN, "fosstodon.org").length, 0);
  assert.equal(mastodonMatches(fixture, { name: "Jane Doe" }, "mastodon.social").length, 0);
  const res = await runMod(actorSearch, EUGEN, {
    routes: [
      [/mastodon\.social\/api\/v2\/search/, { body: fixture }],
      [/mastodon\.online\/api\/v2\/search/, { body: fixture }], // the same account federated: one candidate
      [/fosstodon\.org/, { status: 429, body: "slow down" }],
    ],
  });
  assert.equal(res.rows.length, 0, "name search writes no rows; identity scores the candidates");
  assert.equal(res.shared.accounts.length, 1);
  const a = res.shared.accounts[0];
  assert.equal(a.source, "name-search");
  assert.ok(a.nameMatch && a.anchors.includes("company"), "the bio names Mastodon");
  assert.equal(res.status.status, "partial");
});

test("pushAccount dedupes by site+handle and by URL", () => {
  const shared = {};
  assert.ok(pushAccount(shared, { site: "github", handle: "Jdoe", url: "https://github.com/jdoe" }));
  assert.ok(!pushAccount(shared, { site: "github", handle: "jdoe", url: "https://github.com/x" }));
  assert.ok(!pushAccount(shared, { site: "gh", handle: null, url: "https://github.com/jdoe/" }));
  assert.equal(shared.accounts.length, 1);
  const acc = makeAccount({ site: "x", name: "Jane Doe", bio: "VP at Acme Robotics", source: "given" }, { name: "Jane Doe", company: "Acme Robotics" });
  assert.deepEqual(acc.anchors, ["name", "company"]);
  assert.ok(acc.confirmed);
});

test("gravatar: given email ties the profile; verified accounts join candidates and official links; guessed pattern needs the name", async () => {
  const g = fx("gravatar-beau-lebens.json");
  const p = gravatarProfile(g);
  assert.equal(p.name, "Beau Lebens");
  assert.equal(p.company, "Automattic");
  assert.ok(p.verified.some((v) => v.url === "https://github.com/beaulebens"));
  const BEAU = { name: "Beau Lebens", company: "Automattic", domain: "automattic.com", email: "beau@dentedreality.com.au" };
  assert.equal(gravatarTie(p, { source: "given" }, BEAU).grade, "p");
  assert.equal(gravatarTie(p, { source: "pattern" }, { name: "Jane Doe" }).tied, false);
  const hash = sha256("beau@dentedreality.com.au");
  const res = await runMod(gravatar, BEAU, { routes: [[new RegExp(`/v3/profiles/${hash}$`), { body: g }]] });
  const row = res.rows.find((r) => r.var === "social.proofs");
  assert.ok(row);
  assert.equal(row.grade, "p");
  assert.match(row.value, /verified accounts: .*github\.com\/beaulebens/);
  assert.ok(res.shared.officialLinks.includes("https://github.com/beaulebens"));
  assert.ok(res.shared.accounts.some((a) => a.site === "github" && a.handle === "beaulebens" && a.source === "gravatar-verified"));
  // guessed patterns on the domain answer 404: misses, not rows
  assert.equal(res.calls.length, 5);
});

test("gravatar: no email and no domain is a miss, not a call", async () => {
  const res = await runMod(gravatar, { name: "Jane Doe" });
  assert.equal(res.calls.length, 0);
  assert.match(res.misses[0].searched, /no email/);
});

test("github-email: commit authors grouped; future author dates ignored; a guessed address under someone else's profile name is dropped", async () => {
  const items = [
    { author: { login: "jdoe", html_url: "https://github.com/jdoe" }, commit: { author: { name: "Jane Doe", date: "2026-03-01T10:00:00Z" } }, repository: { full_name: "acme/robot" } },
    { author: { login: "jdoe" }, commit: { author: { name: "Jane Doe", date: "2099-12-31T00:00:00Z" } }, repository: { full_name: "spoof/sandbox" } },
    { author: null, commit: { author: { name: "Jane Doe", date: "2026-01-01T00:00:00Z" } } },
  ];
  const a = commitAuthors({ items }, "2026-11-20");
  assert.equal(a.length, 1);
  assert.equal(a[0].commits, 2);
  assert.equal(a[0].last, "2026-03-01");
  const JANE = { name: "Jane Doe", company: "Acme Robotics", domain: "acmerobotics.com" };
  const res = await runMod(githubEmail, JANE, {
    routes: [
      [/search\/commits\?q=author-email%3Ajane\.doe%40/, { body: { total_count: 2, items } }],
      [/search\/commits/, { body: { total_count: 0, items: [] } }],
      [/api\.github\.com\/users\/jdoe$/, { body: { login: "jdoe", name: "Someone Else", avatar_url: "a" } }],
    ],
  });
  assert.equal(res.rows.length, 0);
  assert.ok(res.misses.some((m) => /profile name is "Someone Else"/.test(m.searched)));
  const ok = await runMod(githubEmail, { ...JANE, email: "jane@acmerobotics.com" }, {
    routes: [
      [/author-email%3Ajane%40acmerobotics/, { body: { total_count: 2, items } }],
      [/search\/commits/, { body: { total_count: 0, items: [] } }],
      [/api\.github\.com\/users\/jdoe$/, { body: { login: "jdoe", name: "Jane Doe", company: "@acmerobotics" } }],
    ],
  });
  const row = ok.rows.find((r) => r.var === "social.proofs");
  assert.equal(row.grade, "p");
  assert.ok(ok.shared.accounts.some((x) => x.site === "github" && x.handle === "jdoe" && x.source === "commit-email:given"));
});

test("verified-links: Keybase proofs of a given handle become proofs and official links", async () => {
  const kb = fx("keybase-chris.json");
  const proofs = keybaseProofs(kb.them[0]);
  assert.ok(proofs.some((p) => p.service === "github" && p.handle === "malgorithms"));
  assert.ok(proofs.some((p) => p.service === "dns"));
  const res = await runMod(verifiedLinks, { name: "Chris Coyne", company: "Keybase", handles: ["chris"] }, { routes: [[/keybase\.io\/_\/api\/1\.0\/user\/lookup\.json\?usernames=chris/, { body: kb }]] });
  const row = res.rows.find((r) => r.var === "social.proofs");
  assert.equal(row.grade, "p");
  assert.match(row.value, /Keybase @chris \(verified\) links .*github malgorithms/);
  assert.ok(res.shared.officialLinks.includes("https://github.com/malgorithms"));
  assert.ok(!res.shared.officialLinks.some((u) => /chriscoyne\.com/.test(u)), "domains are not profile links");
});

test("verified-links: Mastodon verified fields; an unanchored root links but vouches for nothing", async () => {
  const acct = fx("mastodon-search-eugen-rochko.json").accounts[0];
  const v = mastodonVerified(acct);
  assert.ok(v.some((f) => f.url === "https://github.com/Gargron"));
  const shared = { accounts: [{ site: "mastodon", handle: "Gargron", url: "https://mastodon.social/@Gargron", confirmed: true, anchors: ["name"], source: "name-search" }] };
  assert.equal(anchoredRoot(shared.accounts[0], shared), false);
  const res = await runMod(verifiedLinks, EUGEN, { shared, routes: [[/mastodon\.social\/api\/v1\/accounts\/lookup\?acct=Gargron/, { body: acct }]] });
  const row = res.rows.find((r) => r.var === "social.proofs");
  assert.equal(row.grade, "w");
  assert.match(row.value, /not yet tied/);
  assert.equal(res.shared.officialLinks, undefined);
});

test("linkpages: Linktree __NEXT_DATA__ and rel=me links parsed; given handle's page adds candidates", async () => {
  const page = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { username: "janedoe", pageTitle: "Jane Doe", description: "Ops at Acme Robotics", socialLinks: [{ type: "X", url: "https://x.com/janedoe_ops" }], links: [{ title: "My talks", url: "https://example.com/talks" }], account: { username: "janedoe" } } } })}</script></html>`;
  const p = parseLinktree(page);
  assert.equal(p.title, "Jane Doe");
  assert.deepEqual(p.social, ["https://x.com/janedoe_ops"]);
  assert.deepEqual(relMeLinks('<a rel="me noopener" href="https://mastodon.social/@jd">m</a><link rel="me" href="https://github.com/jd"><a href="https://x.com/no">x</a>'), ["https://mastodon.social/@jd", "https://github.com/jd"]);
  const res = await runMod(linkpages, { name: "Jane Doe", company: "Acme Robotics", handles: ["janedoe"] }, { routes: [[/linktr\.ee\/janedoe$/, { body: page }]] });
  const row = res.rows.find((r) => r.var === "social.linkpage");
  assert.equal(row.grade, "p");
  assert.ok(res.shared.accounts.some((a) => a.url === "https://x.com/janedoe_ops" && a.source === "linkpage"));
  assert.ok(res.shared.officialLinks.includes("https://x.com/janedoe_ops"));
});

test("dev-communities: Stack Overflow name matches become candidates; a given HN handle's activity is read", async () => {
  const se = { items: [{ user_id: 1, display_name: "Jane Doe", link: "https://stackoverflow.com/users/1/jane-doe", location: "Austin, TX", reputation: 120, creation_date: 1500000000 }, { user_id: 2, display_name: "Janet Smith", link: "x" }] };
  assert.equal(seMatches(se, { name: "Jane Doe" }).length, 1);
  const act = hnActivity(fx("hn-user-pg.json"), fx("hn-comments-pg.json"));
  assert.equal(act.karma > 100000, true);
  assert.equal(act.last, "2024-03-11");
  const res = await runMod(devCommunities, { name: "Paul Graham", company: "Y Combinator", handles: ["pg"] }, {
    routes: [
      [/api\.stackexchange\.com/, { body: { items: [] } }],
      [/hn\.algolia\.com\/api\/v1\/users\/pg/, { body: fx("hn-user-pg.json") }],
      [/search_by_date\?tags=comment,author_pg/, { body: fx("hn-comments-pg.json") }],
    ],
  });
  const row = res.rows.find((r) => r.var === "social.dev_activity");
  assert.equal(row.grade, "p");
  assert.match(row.value, /Hacker News @pg: karma \d+, 9985 comment\(s\), latest 2024-03-11/);
});

test("package-registries: crates.io under a given handle with a matching name; PyPI challenge is 'not checked'", async () => {
  const s = cratesSummary(fx("crates-user-burntsushi.json"), fx("crates-crates-burntsushi.json"));
  assert.equal(s.name, "Andrew Gallant");
  assert.ok(s.total > 10);
  assert.deepEqual(pypiUser("<title>Client Challenge</title>"), { challenge: true });
  assert.equal(gemsSummary([{ name: "g", downloads: 1 }])[0].name, "g");
  const res = await runMod(packageRegistries, { name: "Andrew Gallant", company: "Astral", handles: ["BurntSushi"] }, {
    routes: [
      [/crates\.io\/api\/v1\/users\/burntsushi$/, { body: fx("crates-user-burntsushi.json") }],
      [/crates\.io\/api\/v1\/crates\?user_id=/, { body: fx("crates-crates-burntsushi.json") }],
      [/rubygems\.org/, { body: [] }],
      [/pypi\.org\/user\//, { body: "<html><title>Client Challenge</title></html>" }],
    ],
  });
  const row = res.rows.find((r) => r.var === "career.code");
  assert.equal(row.grade, "p");
  assert.match(row.value, /crates\.io @BurntSushi \(Andrew Gallant\): \d+ crate/);
  assert.ok(res.misses.some((m) => /PyPI user burntsushi: not checked/.test(m.searched)));
  assert.ok(res.calls.find((c) => /crates\.io/.test(c.url)).headers["user-agent"].includes("diligence-rooms"), "crates.io wants a UA with a contact");
});

test("hobby-apis: Letterboxd feed and chess.com ratings read for a given handle", async () => {
  const rss = `<?xml version="1.0"?><rss xmlns:letterboxd="https://letterboxd.com"><channel><title>Letterboxd - Jane Doe</title>
  <item><title>Heat, 1995 - ★★★★</title><link>https://letterboxd.com/janedoe/film/heat/</link><pubDate>Sat, 01 Nov 2026 10:00:00 +0000</pubDate><letterboxd:watchedDate>2026-10-31</letterboxd:watchedDate><letterboxd:filmTitle>Heat</letterboxd:filmTitle><letterboxd:filmYear>1995</letterboxd:filmYear><letterboxd:memberRating>4.0</letterboxd:memberRating></item>
  <item><title>Ronin</title><link>https://letterboxd.com/janedoe/film/ronin/</link><letterboxd:watchedDate>2026-10-20</letterboxd:watchedDate><letterboxd:filmTitle>Ronin</letterboxd:filmTitle><letterboxd:memberRating>3.0</letterboxd:memberRating></item></channel></rss>`;
  const f = letterboxdFeed(rss);
  assert.equal(f.name, "Jane Doe");
  assert.equal(f.films[0].watched, "2026-10-31");
  assert.equal(f.films[0].rating, 4);
  const stats = { chess_rapid: { last: { rating: 1500, date: 1763000000 }, best: { rating: 1600 }, record: { win: 10, loss: 5, draw: 1 } }, tactics: { highest: { rating: 2000 } } };
  assert.deepEqual(chessRatings(stats).map((x) => [x.kind, x.rating]), [["rapid", 1500]]);
  const res = await runMod(hobbyApis, { name: "Jane Doe", company: "Acme Robotics", handles: ["janedoe"] }, {
    routes: [
      [/letterboxd\.com\/janedoe\/rss/, { body: rss }],
      [/api\.chess\.com\/pub\/player\/janedoe\/stats/, { body: stats }],
      [/api\.discogs\.com/, { status: 404, body: { message: "User does not exist" } }],
    ],
  });
  assert.equal(res.rows.find((r) => r.var === "hobby.media").grade, "p");
  assert.match(res.rows.find((r) => r.var === "hobby.games").value, /rapid 1500 \(best 1600\)/);
});

test("wikipedia: article accepted only when it names the company; pageview spikes become key dates", async () => {
  const SATYA = { name: "Satya Nadella", company: "Microsoft", title: "Chief Executive Officer" };
  assert.deepEqual(wikiTitles(fx("wikipedia-search-satya-nadella.json"), SATYA), ["Satya Nadella"]);
  assert.ok(wikiAnchors(fx("wikipedia-summary-satya-nadella.json"), SATYA).includes("company"));
  assert.deepEqual(wikiAnchors(fx("wikipedia-summary-satya-nadella.json"), { name: "Satya Nadella", company: "Acme Robotics" }), []);
  const items = Array.from({ length: 12 }, (_, i) => ({ timestamp: `2026${String(i + 1).padStart(2, "0")}0100`, views: i === 5 ? 500 : 100 }));
  const sp = viewSpikes(items);
  assert.equal(sp.median, 100);
  assert.deepEqual(sp.spikes.map((x) => x.month), ["2026-06"]);
  const res = await runMod(wikipedia, SATYA, {
    routes: [
      [/w\/api\.php\?action=query&list=search/, { body: fx("wikipedia-search-satya-nadella.json") }],
      [/page\/summary\/Satya_Nadella/, { body: fx("wikipedia-summary-satya-nadella.json") }],
      [/metrics\/pageviews/, { body: { items } }],
    ],
  });
  const bio = res.rows.find((r) => r.var === "bio.wikipedia");
  assert.equal(bio.grade, "p");
  assert.match(bio.detail.terms, /CC BY-SA/);
  assert.ok(res.rows.some((r) => r.var === "news.attention" && r.date === "2026-06-01"));
  assert.ok(res.calls.every((c) => /diligence-rooms/.test(c.headers["user-agent"] || "")), "Wikimedia wants a descriptive UA");
  const namesake = await runMod(wikipedia, { name: "Satya Nadella", company: "Acme Robotics" }, {
    routes: [
      [/w\/api\.php/, { body: fx("wikipedia-search-satya-nadella.json") }],
      [/page\/summary\/Satya_Nadella/, { body: fx("wikipedia-summary-satya-nadella.json") }],
    ],
  });
  assert.equal(namesake.rows.length, 0);
});

test("scholarly: authors and works accepted only with an affiliation naming the company", async () => {
  const UCB = { name: "Jennifer Doudna", company: "University of California, Berkeley" };
  const oa = openalexMatches(fx("openalex-jennifer-doudna.json"), UCB);
  assert.ok(oa.some((a) => a.anchored));
  assert.ok(!openalexMatches(fx("openalex-jennifer-doudna.json"), { name: "Jennifer Doudna", company: "Acme Robotics" }).some((a) => a.anchored));
  const works = crossrefWorks(fx("crossref-jennifer-doudna.json"), UCB);
  assert.ok(works.some((w) => w.anchored && /Berkeley/.test(w.affiliation)));
  assert.deepEqual(orcidEducation({ "affiliation-group": [{ summaries: [{ "education-summary": { organization: { name: "Pomona College" }, "role-title": "BA", "start-date": { year: { value: "1981" } }, "end-date": { year: { value: "1985" } } } }] }] }), [{ org: "Pomona College", role: "BA", department: null, start: "1981", end: "1985" }]);
  const routes = [
    [/pub\.orcid\.org/, { body: { "expanded-result": [] } }],
    [/api\.openalex\.org/, { body: fx("openalex-jennifer-doudna.json") }],
    [/semanticscholar/, { status: 429, body: "Too Many Requests" }],
    [/api\.crossref\.org/, { body: fx("crossref-jennifer-doudna.json") }],
  ];
  const res = await runMod(scholarly, UCB, { routes });
  assert.ok(res.rows.some((r) => r.var === "career.publications" && /^OpenAlex: Jennifer A\. Doudna/.test(r.value)));
  assert.equal(res.status.status, "partial");
  const none = await runMod(scholarly, { name: "Jennifer Doudna", company: "Acme Robotics" }, { routes });
  assert.equal(none.rows.length, 0);
  assert.match(none.misses.find((m) => m.var === "career.publications" && /namesakes/.test(m.searched)).searched, /OpenAlex 2, Semantic Scholar 0, Crossref works 5/);
});

test("feeds: Medium feed of a confirmed account; personal-site feed discovery; YouTube channel id", async () => {
  assert.deepEqual(feedUrlsFor({ site: "substack", handle: "jd" }), ["https://jd.substack.com/feed"]);
  assert.equal(discoverFeed('<link rel="alternate" type="application/rss+xml" href="/feed.xml">', "https://janedoe.dev/"), "https://janedoe.dev/feed.xml");
  assert.equal(channelIdFrom('{"externalId":"UCabcdefghijklmnopqrstuv"}'), "UCabcdefghijklmnopqrstuv");
  const rss = `<rss><channel><title>Stories by Jane Doe on Medium</title><item><title><![CDATA[Scaling ops at Acme]]></title><link>https://medium.com/@janedoe/scaling</link><pubDate>Mon, 03 Nov 2026 12:00:00 GMT</pubDate></item></channel></rss>`;
  const shared = { accounts: [{ site: "medium", handle: "janedoe", url: "https://medium.com/@janedoe", confirmed: true, anchors: ["name", "company"], source: "derived" }] };
  const res = await runMod(feeds, { name: "Jane Doe", company: "Acme Robotics" }, { shared, routes: [[/medium\.com\/feed\/@janedoe/, { body: rss }]] });
  const post = res.rows.find((r) => r.var === "voice.writing" && /Scaling ops/.test(r.value));
  assert.equal(post.date, "2026-11-03");
  assert.equal(post.grade, "p");
});

test("media-feeds: iTunes episodes that name the person; company named raises the grade; Podcast Index auth header", async () => {
  const it = { results: [
    { kind: "podcast-episode", collectionName: "Ops Talk", trackName: "Jane Doe on robots at Acme Robotics", releaseDate: "2026-10-01T00:00:00Z", trackViewUrl: "https://podcasts.apple.com/e1", trackTimeMillis: 1800000 },
    { kind: "podcast-episode", collectionName: "Other", trackName: "Jane Doe returns", releaseDate: "2026-09-01T00:00:00Z", trackViewUrl: "https://podcasts.apple.com/e2" },
    { kind: "podcast-episode", collectionName: "Noise", trackName: "Doe season", description: "Jane and John", trackViewUrl: "x" },
  ] };
  const eps = itunesEpisodes(it, { name: "Jane Doe", company: "Acme Robotics" });
  assert.equal(eps.length, 2);
  const h = podcastIndexHeaders("k", "s", 1700000000);
  assert.equal(h.Authorization, createHash("sha1").update("ks1700000000").digest("hex"));
  assert.equal(h["X-Auth-Date"], "1700000000");
  const res = await runMod(mediaFeeds, { name: "Jane Doe", company: "Acme Robotics" }, { routes: [[/itunes\.apple\.com\/search/, { body: it }]] });
  const rows = res.rows.filter((r) => r.var === "voice.talks");
  assert.equal(rows[0].grade, "p");
  assert.equal(rows[1].grade, "w");
  assert.ok(res.misses.some((m) => /PODCASTINDEX_API_KEY/.test(m.searched)));
});

test("books: Open Library author with the company in subjects graded p, works listed", async () => {
  const SATYA = { name: "Satya Nadella", company: "Microsoft" };
  assert.equal(olAuthors(fx("openlibrary-authors-satya-nadella.json"), SATYA)[0].key, "OL7404327A");
  const res = await runMod(books, SATYA, {
    routes: [
      [/search\/authors\.json/, { body: fx("openlibrary-authors-satya-nadella.json") }],
      [/authors\/OL7404327A\.json/, { body: { remote_ids: { wikidata: "Q7426870" } } }],
      [/authors\/OL7404327A\/works\.json/, { body: { entries: [{ title: "Hit Refresh", key: "/works/OL1W", first_publish_date: "2017" }] } }],
    ],
  });
  const summary = res.rows.find((r) => /^Open Library/.test(r.value));
  assert.equal(summary.grade, "p");
  assert.equal(summary.detail.remote_ids.wikidata, "Q7426870");
  assert.ok(res.rows.some((r) => r.value === '"Hit Refresh" (2017)'));
});
