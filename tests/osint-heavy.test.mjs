// Heavy lane (opt-in Python sidecars and exiftool). No network and no Python needed: a fake
// "python" (a Node script) answers each sidecar from recorded fixtures, and a fake exiftool prints
// recorded JSON. One test runs the real imagehash sidecar when OSINT_PYTHON (or python3) has it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runOsint } from "../scripts/osint/run.mjs";
import { runSidecar, pythonHas, depMiss } from "../scripts/osint/sidecar.mjs";
import { parseFeed } from "../scripts/osint/xml.mjs";
import headshot, { verdictOf, avatarsOf, referenceOf } from "../scripts/osint/modules/90-headshot-match.mjs";
import article, { articleUrls, readArticle, refused } from "../scripts/osint/modules/91-article-extract.mjs";
import transcripts, { videoId, mediaOf, summarize } from "../scripts/osint/modules/92-transcripts.mjs";
import docmeta, { readExif, listDocs } from "../scripts/osint/modules/93-doc-metadata.mjs";
import proxy, { splitName, byExecutive } from "../scripts/osint/modules/94-sec-proxy.mjs";
import identity from "../scripts/osint/modules/30-identity.mjs";
import { osintChecks } from "../scripts/lib/doctor.mjs";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "osint-part2", "heavy");
const JANE = { name: "Jane Doe", company: "Acme Robotics", domain: "acmerobotics.com", handles: [], aliases: [] };
const tmp = () => mkdtempSync(join(tmpdir(), "osint-heavy-"));

/** A fake python: prints the JSON in $FAKE_SIDECAR_DIR/<sidecar name>.json (exit code from .code). */
function fakePython(answers) {
  const dir = tmp();
  for (const [name, body] of Object.entries(answers)) writeFileSync(join(dir, `${name}.json`), typeof body === "string" ? body : JSON.stringify(body));
  const bin = join(dir, "python");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const name = path.basename(process.argv[3] || "", ".py");
let input = ""; process.stdin.on("data", (d) => (input += d)); process.stdin.on("end", () => {
  fs.writeFileSync(path.join(${JSON.stringify(dir)}, name + ".request.json"), input);
  const f = path.join(${JSON.stringify(dir)}, name + ".json");
  if (!fs.existsSync(f)) { console.error("no fixture for " + name); process.exit(1); }
  const body = fs.readFileSync(f, "utf8");
  process.stdout.write(body + "\\n");
  process.exit(JSON.parse(body).missing ? 3 : 0);
});
`,
  );
  chmodSync(bin, 0o755);
  return { bin, dir, request: (name) => JSON.parse(readFileSync(join(dir, `${name}.request.json`), "utf8")) };
}

function fakeFetch(routes) {
  return async (url) => {
    for (const [re, r] of routes) if (re.test(url)) return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status || 200 });
    return new Response("not found", { status: 404 });
  };
}

/** A fast-lane module that seeds shared state, as the sweep and talk modules would. */
const seed = (fn) => ({ id: "seed", label: "seed", lane: "fast", needs: [], async run(ctx) { await fn(ctx); } });

async function withEnv(vars, fn) {
  const old = {};
  for (const k of Object.keys(vars)) {
    old[k] = process.env[k];
    if (vars[k] == null) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (old[k] == null) delete process.env[k];
      else process.env[k] = old[k];
    }
  }
}

const run = (subject, modules, extra = {}) => runOsint(subject, { outDir: tmp(), modules, log: () => {}, fetchImpl: extra.fetchImpl || fakeFetch([]), heavy: extra.heavy ?? "all", opts: extra.opts || {} });

// ---------------------------------------------------------------- runner

test("heavy lane is opt-in: skipped with the flag to add, runs when named", async () => {
  const r = await runOsint(JANE, { outDir: tmp(), modules: [docmeta], log: () => {}, fetchImpl: fakeFetch([]) });
  const m = r.modules.find((x) => x.id === "doc-metadata");
  assert.equal(m.status, "skipped");
  assert.match(m.why, /--heavy doc-metadata/);
  const r2 = await run(JANE, [docmeta], { heavy: ["doc-metadata"] });
  assert.notEqual(r2.modules.find((x) => x.id === "doc-metadata").status, "skipped");
});

test("missing Python: error status and a 'not run' miss with the fix, never a stall", async () => {
  await withEnv({ OSINT_PYTHON: "/nonexistent/python3" }, async () => {
    const r = await run({ ...JANE, photo: "https://example.com/h.jpg" }, [seed((ctx) => (ctx.shared.accounts = [{ site: "github", handle: "janedoe", url: "https://github.com/janedoe", avatar: "https://example.com/a.png" }])), headshot]);
    const m = r.modules.find((x) => x.id === "headshot-match");
    assert.equal(m.status, "error");
    const miss = r.misses.find((x) => x.module === "headshot-match");
    assert.match(miss.searched, /not run, Python 3 not found · fix: install Python 3 \(or set OSINT_PYTHON/);
    assert.match(miss.searched, /pip install imagehash pillow/);
  });
});

test("missing library reported by the sidecar: error status and the pip line", async () => {
  const py = fakePython({ extract_text: { missing: ["trafilatura"] } });
  await withEnv({ OSINT_PYTHON: py.bin }, async () => {
    const f = fakeFetch([[/example\.org\/story/, { body: "<html><body><p>Jane Doe of Acme Robotics said things.</p></body></html>" }]]);
    const r = await run(JANE, [article], { fetchImpl: f, opts: { articles: ["https://example.org/story"] } });
    assert.equal(r.modules.find((x) => x.id === "article-extract").status, "error");
    assert.match(r.misses.find((x) => x.module === "article-extract").searched, /missing trafilatura · fix: pip install trafilatura/);
  });
});

test("runSidecar: no Python resolves with missing python3", async () => {
  const r = await runSidecar("imagehash_match", {}, { env: { ...process.env, OSINT_PYTHON: "/nonexistent/py" } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["python3"]);
});

test("depMiss writes one miss per variable and sets status error", () => {
  const misses = [];
  let st = null;
  const ctx = { miss: (v, s) => misses.push([v, s]), status: (s, why) => (st = [s, why]) };
  depMiss(ctx, ["a", "b"], "thing", ["edgar"]);
  assert.equal(misses.length, 2);
  assert.equal(st[0], "error");
  assert.match(misses[0][1], /pip install edgartools/);
});

// ---------------------------------------------------------------- H1 headshot-match

test("headshot verdicts follow the 3.4 thresholds", () => {
  assert.equal(verdictOf({ phash: 0 }), "match");
  assert.equal(verdictOf({ phash: 6 }), "match");
  assert.equal(verdictOf({ phash: 7 }), "possible");
  assert.equal(verdictOf({ phash: 10 }), "possible");
  assert.equal(verdictOf({ phash: 11 }), "no match");
  assert.equal(verdictOf({ phash: null }), null);
});

test("headshot reference: --photo, then the company bio photo, then a profile photo; avatars skip the reference and defaults", () => {
  assert.equal(referenceOf({ photo: "p.jpg" }, {}).from, "--photo");
  assert.equal(referenceOf({}, {}, [{ var: "pic.headshot", image: "bio.jpg", grade: "v", id: "L-0003" }]).url, "bio.jpg");
  assert.equal(referenceOf({}, { headshot: "gh.png", headshotFrom: "github @x" }).official, false);
  const av = avatarsOf({ accounts: [{ site: "a", avatar: "ref.jpg" }, { site: "b", avatar: "https://www.gravatar.com/avatar/00000000000000000000000000000000" }, { site: "c", handle: "jd", avatar: "c.png" }, { site: "d", avatar: "c.png" }] }, { url: "ref.jpg" });
  assert.deepEqual(av.map((x) => x.url), ["c.png"]);
});

test("headshot match registers with identity through reverseHits (existing signal, no new weight)", async () => {
  const py = fakePython({ imagehash_match: { reference: { ok: true, w: 400, h: 400 }, results: [{ id: "github|janedoe", phash: 2, dhash: 3, crop: [0.9, 0.5, 0.25] }, { id: "x|jdoe", phash: 30, dhash: 28 }] } });
  await withEnv({ OSINT_PYTHON: py.bin }, async () => {
    const accounts = [
      { site: "github", handle: "janedoe", url: "https://github.com/janedoe", name: "Jane Doe", avatar: "https://avatars.example/1.png", source: "derived" },
      { site: "x", handle: "jdoe", url: "https://x.com/jdoe", name: "Jane Doe", avatar: "https://pbs.example/2.jpg", source: "derived" },
    ];
    const r = await run({ ...JANE, photo: "https://acmerobotics.com/team/jane.jpg" }, [seed((ctx) => (ctx.shared.accounts = accounts)), headshot, identity]);
    const rows = r.rows.filter((x) => x.var === "pic.avatar_matches");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].grade, "p");
    assert.match(rows[0].value, /pHash 2\/64/);
    assert.equal(py.request("imagehash_match").reference, "https://acmerobotics.com/team/jane.jpg");
    const gh = r.rows.find((x) => x.module === "identity" && x.url === "https://github.com/janedoe");
    assert.ok(gh, "github candidate scored");
    assert.match(gh.value, /headshot reused \+3/);
    const xr = r.rows.find((x) => x.module === "identity" && x.url === "https://x.com/jdoe");
    assert.ok(!xr || !/headshot reused/.test(xr.value));
  });
});

test("headshot match without a headshot or avatars never starts Python", async () => {
  await withEnv({ OSINT_PYTHON: "/nonexistent/python3" }, async () => {
    const r = await run(JANE, [headshot]);
    assert.equal(r.modules.find((x) => x.id === "headshot-match").status, "ok");
    assert.match(r.misses.find((x) => x.module === "headshot-match").searched, /no headshot/);
  });
});

test("real imagehash sidecar on synthetic crops (skipped without imagehash)", async (t) => {
  const has = await pythonHas(["imagehash", "PIL"]);
  if (!has?.imagehash || !has?.PIL) return t.skip("imagehash/Pillow not installed for " + (process.env.OSINT_PYTHON || "python3"));
  const dir = tmp();
  // draw a synthetic "headshot", a centre-square crop of it (an avatar) and a different picture
  const { runProgram, pythonBin } = await import("../scripts/osint/sidecar.mjs");
  const code = `from PIL import Image, ImageDraw
import random, sys
random.seed(7)
im = Image.new("RGB", (400, 500), (200, 210, 220)); d = ImageDraw.Draw(im)
for i in range(40):
    x, y = random.randint(0, 380), random.randint(0, 480); d.ellipse([x, y, x + random.randint(20, 120), y + random.randint(20, 120)], fill=(random.randint(0,255), random.randint(0,255), random.randint(0,255)))
im.save(sys.argv[1] + "/ref.png"); im.crop((40, 90, 360, 410)).resize((96, 96)).save(sys.argv[1] + "/avatar.png")
o = Image.new("RGB", (300, 300), (30, 30, 30)); d = ImageDraw.Draw(o)
for i in range(30):
    x, y = random.randint(0, 280), random.randint(0, 280); d.rectangle([x, y, x + random.randint(10, 90), y + random.randint(10, 90)], fill=(random.randint(0,255), random.randint(0,255), random.randint(0,255)))
o.save(sys.argv[1] + "/other.png")`;
  const g = await runProgram(pythonBin(), ["-I", "-c", code, dir], { timeoutMs: 20000 });
  assert.ok(g.ok, g.stderr);
  const r = await runSidecar("imagehash_match", { reference: join(dir, "ref.png"), candidates: [{ id: "same", url: join(dir, "avatar.png") }, { id: "other", url: join(dir, "other.png") }] }, { timeoutMs: 30000 });
  assert.ok(r.ok, r.error);
  const by = Object.fromEntries(r.data.results.map((x) => [x.id, x]));
  assert.ok(by.same.phash <= 6, `same photo, cropped: ${by.same.phash}`);
  assert.ok(by.other.phash > 10, `different picture: ${by.other.phash}`);
});

// ---------------------------------------------------------------- H2 article-extract

test("article URLs: --articles first, else ledger rows that name the subject, no video or social pages", () => {
  assert.deepEqual(articleUrls({ articles: ["https://a.example/x", "nope"] }, [], JANE).map((x) => x.url), ["https://a.example/x"]);
  const rows = [
    { id: "L-1", var: "news.articles", url: "https://news.example/1", grade: "w", value: "Jane Doe joins board" },
    { id: "L-2", var: "news.articles", url: "https://www.youtube.com/watch?v=abcdefghijk", grade: "p", value: "Jane Doe talk" },
    { id: "L-3", var: "voice.quotes", url: "https://pr.example/2", grade: "v", value: "\"We ship\" said Jane Doe" },
    { id: "L-4", var: "news.articles", url: "https://news.example/3", grade: "p", value: "Someone else entirely" },
  ];
  assert.deepEqual(articleUrls({}, rows, JANE).map((x) => x.url), ["https://pr.example/2", "https://news.example/1"]);
});

test("article refusal: a full article mentioning a captcha library is not a refusal; a short challenge page is", () => {
  assert.equal(refused({ ok: true, status: 200, text: "<head>wgConfirmEditCaptcha</head>" + "x".repeat(40000) }), false);
  assert.equal(refused({ ok: true, status: 200, text: "<title>Just a moment...</title>" }), true);
  assert.equal(refused({ ok: false, status: 403, text: "" }), true);
});

test("article extract: rows for articles that name the subject, quotes split out", async () => {
  const py = fakePython({
    extract_text: {
      results: [
        { url: "https://news.example/a", title: "Acme Robotics names Jane Doe COO", author: "A. Writer", date: "2026-10-02", sitename: "Example News", text: "Acme Robotics named Jane Doe chief operating officer on Monday. \"We will double output in Austin within two years,\" said Jane Doe. Doe joined in 2019 from Initech." },
        { url: "https://news.example/b", title: "Unrelated", text: "Nothing about her here at all." },
      ],
    },
  });
  await withEnv({ OSINT_PYTHON: py.bin }, async () => {
    const f = fakeFetch([[/news\.example/, { body: "<html><body>article</body></html>" }]]);
    const r = await run(JANE, [article], { fetchImpl: f, opts: { articles: ["https://news.example/a", "https://news.example/b"] } });
    const rows = r.rows.filter((x) => x.var === "news.article_text");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].grade, "p");
    assert.equal(rows[0].date, "2026-10-02");
    assert.match(rows[0].value, /Example News, 2026-10-02, by A\. Writer/);
    const q = r.rows.filter((x) => x.var === "voice.quotes");
    assert.equal(q.length, 1);
    assert.match(q[0].value, /double output in Austin/);
    assert.ok(r.misses.some((m) => /does not name Jane Doe/.test(m.searched)));
  });
});

test("readArticle: sentences about the subject, surname-only follow-ups included", () => {
  const a = readArticle({ text: "Jane Doe leads operations at Acme Robotics. Doe started in 2019. The weather was fine." }, JANE);
  assert.equal(a.named, true);
  assert.equal(a.about.length, 2);
  assert.equal(a.company, true);
});

// ---------------------------------------------------------------- H3 transcripts

test("video ids from every YouTube URL shape", () => {
  assert.equal(videoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(videoId("https://youtu.be/dQw4w9WgXcQ?t=3"), "dQw4w9WgXcQ");
  assert.equal(videoId("https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(videoId("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(videoId("https://vimeo.com/123"), null);
});

test("media to transcribe: talks rows, shared.talks and --articles, audio only from talk rows", () => {
  const m = mediaOf(
    [
      { id: "L-1", var: "voice.talks", url: "https://www.youtube.com/watch?v=AAAAAAAAAAA", value: "Keynote — Conf", date: "2026-01-01" },
      { id: "L-2", var: "voice.talks", url: "https://podcasts.example/ep1", value: "Ep 1", detail: { episodeUrl: "https://cdn.example/ep1.mp3" } },
      { id: "L-3", var: "co.filings", url: "https://www.youtube.com/watch?v=BBBBBBBBBBB", value: "x" },
    ],
    { talks: [{ url: "https://youtu.be/CCCCCCCCCCC", title: "Panel" }] },
    { articles: ["https://www.youtube.com/watch?v=AAAAAAAAAAA", "https://www.youtube.com/watch?v=DDDDDDDDDDD"] },
  );
  assert.deepEqual(m.videos.map((v) => v.id), ["AAAAAAAAAAA", "CCCCCCCCCCC", "DDDDDDDDDDD"]);
  assert.deepEqual(m.audio.map((a) => a.url), ["https://cdn.example/ep1.mp3"]);
});

test("transcript summary: minutes, words, company mentions with timestamps", () => {
  const s = summarize([[0, "welcome everyone"], [65, "at acme robotics we build arms"], [130, "robots robots robots everywhere"], [190, "acme robotics is hiring robots engineers"]], JANE);
  assert.equal(s.minutes, 3);
  assert.equal(s.companyMentions, 2);
  assert.deepEqual(s.mentionAt.map((m) => m.t), [65, 190]);
  assert.ok(s.terms.includes("robots"));
});

test("transcripts: captions become rows; blocked videos are unknown, not none; audio waits for --transcribe", async () => {
  const py = fakePython({
    transcript: {
      videos: [
        { id: "AAAAAAAAAAA", language: "en", generated: false, segments: [[0, "hello from acme robotics"], [600, "robots robots ship"]] },
        { id: "BBBBBBBBBBB", error: "RequestBlocked: YouTube is blocking requests from your IP", segments: [] },
      ],
      audio: [],
    },
  });
  await withEnv({ OSINT_PYTHON: py.bin }, async () => {
    const r = await run(JANE, [
      seed((ctx) => {
        ctx.add({ var: "voice.talks", value: "Keynote — Conf", url: "https://www.youtube.com/watch?v=AAAAAAAAAAA", grade: "p" });
        ctx.add({ var: "voice.talks", value: "Panel — Conf", url: "https://www.youtube.com/watch?v=BBBBBBBBBBB", grade: "p" });
        ctx.add({ var: "voice.talks", value: "Podcast ep", url: "https://pod.example/1", grade: "w", detail: { episodeUrl: "https://cdn.example/1.mp3" } });
      }),
      transcripts,
    ]);
    const rows = r.rows.filter((x) => x.var === "voice.transcripts");
    assert.equal(rows.length, 1);
    assert.match(rows[0].value, /Keynote: 10 min, 7 words of published captions; Acme Robotics at 0:00/);
    const ms = r.misses.filter((m) => m.module === "transcripts").map((m) => m.searched).join(" | ");
    assert.match(ms, /blocked \(RequestBlocked\), unknown/);
    assert.match(ms, /add --transcribe/);
    assert.equal(py.request("transcript").whisper, false);
  });
});

// ---------------------------------------------------------------- H4 doc-metadata

const EXIF = JSON.parse(readFileSync(join(FIX, "exiftool-public-pdfs.json"), "utf8"));

test("readExif: people, tools (deduplicated), ISO dates; software names are not people", () => {
  const r = readExif(EXIF, "DOCS");
  const fed = r.find((x) => x.file === "fed-statement.pdf");
  assert.deepEqual(fed.people, ["Federal Reserve"]);
  assert.equal(fed.tool, "Microsoft® Word for Microsoft 365");
  assert.equal(fed.created, "2024-01-31");
  const tex = r.find((x) => x.file === "arxiv-attention.pdf");
  assert.deepEqual(tex.people, []);
  assert.equal(tex.tool, "pdfTeX-1.40.25");
});

test("doc-metadata runs a fake exiftool over a docs folder; missing exiftool is an error row", async () => {
  const docs = tmp();
  mkdirSync(join(docs, "sub"));
  for (const f of ["a.pdf", "sub/b.docx", "notes.txt"]) writeFileSync(join(docs, f), "x");
  assert.equal(listDocs(docs).length, 2);
  const binDir = tmp();
  const bin = join(binDir, "exiftool");
  const fake = EXIF.map((x, i) => ({ ...x, SourceFile: join(docs, i ? "sub/b.docx" : "a.pdf") })).slice(0, 2);
  fake[1] = { ...fake[1], Author: "Jane Doe", Company: "Acme Robotics" };
  writeFileSync(bin, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(fake))});\n`);
  chmodSync(bin, 0o755);
  await withEnv({ OSINT_EXIFTOOL: bin }, async () => {
    const r = await run(JANE, [docmeta], { opts: { docs } });
    const rows = r.rows.filter((x) => x.var === "doc.metadata");
    assert.equal(rows.length, 2); // the docx with an author, plus the summary (the TeX PDF has no people)
    const own = rows.find((x) => /b\.docx/.test(x.value));
    assert.deepEqual(own.anchors, ["name", "company"]);
    assert.equal(own.grade, "w");
    assert.match(rows.at(-1).value, /2 corpus file\(s\) read/);
  });
  await withEnv({ OSINT_EXIFTOOL: "/nonexistent/exiftool" }, async () => {
    const r = await run(JANE, [docmeta], { opts: { docs } });
    assert.equal(r.modules.find((x) => x.id === "doc-metadata").status, "error");
    assert.match(r.misses.find((m) => m.module === "doc-metadata").searched, /not run, missing \/nonexistent\/exiftool · fix: brew install exiftool/);
  });
});

// ---------------------------------------------------------------- H5 sec-proxy

const PROXY = JSON.parse(readFileSync(join(FIX, "edgar_proxy-msft.json"), "utf8"));

test("proxy names: the title edgartools leaves in the name cell is moved back", () => {
  assert.deepEqual(splitName("Amy E. Hood Executive Vice President and", "CFO"), { name: "Amy E. Hood", title: "Executive Vice President and CFO" });
  assert.deepEqual(splitName("Judson B. Althoff", "CEO"), { name: "Judson B. Althoff", title: "CEO" });
  const ex = byExecutive(PROXY.sct);
  assert.equal(ex[0].name, "Satya Nadella");
  assert.deepEqual(ex[0].years.map((y) => y.year), [2026, 2025, 2024]);
});

test("sec-proxy: whole pay table, pay versus performance, ratio; the subject's own pay when sec-person has none", async () => {
  const py = fakePython({ edgar_proxy: PROXY });
  const f = fakeFetch([
    [/company_tickers\.json/, { body: { 0: { cik_str: 789019, ticker: "MSFT", title: "MICROSOFT CORP" } } }],
    [/submissions\/CIK0000789019/, { body: { name: "MICROSOFT CORP", filings: { recent: { form: [], filingDate: [], accessionNumber: [], primaryDocument: [] } }, addresses: {} } }],
  ]);
  await withEnv({ OSINT_PYTHON: py.bin }, async () => {
    const r = await run({ name: "Amy Hood", company: "Microsoft" }, [proxy], { fetchImpl: f });
    assert.equal(py.request("edgar_proxy").cik, 789019);
    const pay = r.rows.filter((x) => x.var === "co.exec_pay");
    assert.ok(pay.some((x) => /^Amy E\. Hood, Executive Vice President and CFO: FY2026 total \$33\.7M/.test(x.value)));
    assert.ok(pay.some((x) => /CEO pay ratio 421:1/.test(x.value)));
    assert.ok(pay.some((x) => /TSR \$143 vs peer group \$260/.test(x.value)));
    const own = r.rows.find((x) => x.var === "money.comp");
    assert.match(own.value, /FY2026 total \$33\.7M/);
    assert.equal(own.grade, "v");
    assert.ok(r.rows.some((x) => x.var === "voice.priorities" && /Azure/.test(x.value)));
  });
});

test("sec-proxy on a private company: a miss, Python never started", async () => {
  await withEnv({ OSINT_PYTHON: "/nonexistent/python3" }, async () => {
    const f = fakeFetch([[/company_tickers\.json/, { body: { 0: { cik_str: 1, ticker: "ZZZ", title: "OTHER CO" } } }]]);
    const r = await run(JANE, [proxy], { fetchImpl: f });
    assert.equal(r.modules.find((x) => x.id === "sec-proxy").status, "ok");
    assert.match(r.misses.find((m) => m.module === "sec-proxy").searched, /not an SEC registrant/);
  });
});

// ---------------------------------------------------------------- shared pieces

test("parseFeed reads RSS and Atom (YouTube) items", () => {
  const rss = `<rss><channel><title>Blog</title><item><title><![CDATA[Post & one]]></title><link>https://b.example/1</link><pubDate>Tue, 04 Nov 2026 10:00:00 GMT</pubDate><dc:creator>Jane Doe</dc:creator><description>&lt;p&gt;Hello&lt;/p&gt;</description></item></channel></rss>`;
  const r = parseFeed(rss);
  assert.equal(r.title, "Blog");
  assert.deepEqual([r.items[0].title, r.items[0].url, r.items[0].date, r.items[0].author, r.items[0].summary], ["Post & one", "https://b.example/1", "2026-11-04", "Jane Doe", "Hello"]);
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Chan</title><entry><title>Talk</title><link rel="alternate" href="https://www.youtube.com/watch?v=AAAAAAAAAAA"/><published>2026-10-01T00:00:00+00:00</published><author><name>Jane</name></author><yt:videoId>AAAAAAAAAAA</yt:videoId></entry></feed>`;
  const a = parseFeed(atom);
  assert.equal(a.isAtom, true);
  assert.deepEqual([a.items[0].url, a.items[0].date, a.items[0].author, a.items[0].extra["yt:videoId"]], ["https://www.youtube.com/watch?v=AAAAAAAAAAA", "2026-10-01", "Jane", "AAAAAAAAAAA"]);
});

test("doctor lists every heavy module with its install line and every optional key", async () => {
  const c = await osintChecks({ PATH: "/nonexistent", OSINT_PYTHON: "/nonexistent/python3" });
  for (const id of ["headshot-match", "article-extract", "transcripts", "doc-metadata", "sec-proxy"]) {
    const x = c.find((k) => k.id === `osint-heavy-${id}`);
    assert.ok(x, id);
    assert.equal(x.ok, false);
    assert.equal(x.required, false);
  }
  assert.match(c.find((k) => k.id === "osint-heavy-doc-metadata").fix, /brew install exiftool/);
  assert.ok(c.find((k) => k.id === "osint-key-FEC_API_KEY"));
  assert.ok(c.every((k) => k.required === false));
});
