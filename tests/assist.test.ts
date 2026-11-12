// Companion functions with the model mocked: no paid API is called.
// Run with: npm test   (Node 23.6+ runs the .ts files directly)
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setClientFactory, setCorpus, cleanFed, systemFor, knows, FED_MAX_TOTAL, type Corpus } from "../netlify/functions/_assist.ts";
import suggest, { shapeFast } from "../netlify/functions/assist-suggest.ts";
import steer from "../netlify/functions/assist-steer.ts";
import deep from "../netlify/functions/assist-deep.ts";
import know from "../netlify/functions/assist-know.ts";
import feed from "../netlify/functions/assist-feed.ts";

const ROOM: Corpus = {
  room: "testroom", title: "Northwind Logistics", asOf: "2026-03-02",
  people: [{ name: "Ines Carvalho", title: "Finance" }],
  personas: [{ name: "Dan Ellison", title: "COO", page: "persona-coo.html" }],
  entries: [
    { title: "Background / Filings bank", source: "filings-bank.html", kind: "bank", text: "9 Property records Tailspin leases all three. [grade: partly]" },
    { title: "People / Persona: Dan Ellison, COO", source: "persona-coo.html", kind: "persona", text: "How he judges: a number first." },
  ],
};
setCorpus(ROOM);

// A mock Anthropic client: records every request body, replies with canned text.
let calls: any[] = [];
function mock(reply: string) {
  calls = [];
  setClientFactory(() => ({
    beta: {
      messages: {
        create: async (body: any) => { calls.push(body); return { model: body.model, stop_reason: "end_turn", content: [{ type: "text", text: reply }], usage: { cache_read_input_tokens: 1234 } }; },
        stream: (body: any) => {
          calls.push(body);
          const events = [{ type: "message_start", message: { model: body.model } }, ...reply.match(/.{1,40}/gs)!.map((t) => ({ type: "content_block_delta", delta: { type: "text_delta", text: t } }))];
          return { async *[Symbol.asyncIterator]() { for (const e of events) yield e; }, finalMessage: async () => ({ model: body.model, stop_reason: "end_turn", usage: { cache_read_input_tokens: 99 } }) };
        },
      },
    },
  }));
}
beforeEach(() => { calls = []; });
const ctx = { params: { room: "testroom" } } as any;
const post = (body: unknown) => new Request("http://x/testroom/api/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const systemText = (body: any) => body.system.map((b: any) => b.text).join("\n");

const FED = [{ title: "Pricing notes", text: "Floor $750,000. Walk away below it.", kind: "notes" }];

test("fed items are included in the cached context, after the room, for both lanes", async () => {
  mock(JSON.stringify({ lines: [], stage: "numbers", speaker: "Ines Carvalho", question: { detected: false }, cards: [] }));
  await suggest(post({ segments: [{ id: 1, text: "what is your floor" }], fed: FED }), ctx);
  const fast = calls[0];
  assert.match(systemText(fast), /FED BY THE USER/);
  assert.match(systemText(fast), /Floor \$750,000/);
  assert.equal(fast.system.length, 3, "role, room, fed");
  assert.match(fast.system[1].text, /Tailspin leases all three/, "the room comes before the fed items");
  assert.deepEqual(fast.system[2].cache_control, { type: "ephemeral" }, "fed block is cached too");
  assert.equal(fast.model, "claude-opus-5-5", "fast lane default model");

  mock(JSON.stringify({ cards: [{ type: "SUGGEST", say: "Hold the price at $900,000.", ask: "Who signs?" }] }));
  await steer(post({ stage: "push-back", speaker: "Ines Carvalho", fed: FED }), ctx);
  assert.match(systemText(calls[0]), /Floor \$750,000/);
  assert.equal(calls[0].model, "claude-fable-5-2", "deep lane default model");
  assert.deepEqual(calls[0].thinking, { type: "adaptive" });

  mock("BEST ANSWER\nHold.\n\nEVIDENCE\n- x (y)");
  const r = await deep(post({ question: "Too high?", fed: FED }), ctx);
  await r.text();
  assert.match(systemText(calls[0]), /Floor \$750,000/);
});

test("no fed items: two system blocks; fed items are capped and cleaned", () => {
  assert.equal(systemFor("role", ROOM, []).length, 2);
  const big = Array.from({ length: 10 }, (_, i) => ({ title: "n" + i, text: "x".repeat(15000) }));
  const fed = cleanFed([...big, { text: "" }, null, { title: 5, text: 7 }]);
  assert.ok(fed.reduce((n, f) => n + f.text.length, 0) <= FED_MAX_TOTAL);
  assert.ok(fed.every((f) => typeof f.text === "string" && f.text.length));
  assert.deepEqual(cleanFed("nope"), []);
});

test("fast lane: valid cards kept, invalid dropped, CALC recomputed, repeats removed", async () => {
  mock(JSON.stringify({
    lines: [{ id: 1, speaker: "Ines Carvalho", text: "Your fee is $900,000 and saves $400,000 a year?" }],
    stage: "numbers", speaker: "Ines Carvalho",
    question: { detected: true, kind: "question", text: "Is the fee worth it?", asker: "Ines Carvalho" },
    cards: [
      { type: "FACT", q: "Is the fee worth it?", text: "Tailspin leases all three overlap buildings.", source: "Filings bank row 9", grade: "partly" },
      { type: "FACT", text: "No source given" },
      { type: "CALC", title: "Payback", op: "payback", args: { cost: 900000, annual: 400000 }, inputs: [{ label: "fee", value: "$900,000", source: "heard" }, { label: "saving", value: "$400,000", source: "heard" }], result: "5 years" },
      { type: "SUGGEST", say: "The fast lane does not write these." },
      { type: "NOTE", kind: "number", text: "Fee $900,000", who: "Ines Carvalho" },
      { type: "NOTE", kind: "number", text: "Fee $900,000", who: "Ines Carvalho" },
    ],
  }));
  const shown = [{ type: "NOTE", kind: "name", text: "Ines Carvalho" }];
  const j = await (await suggest(post({ segments: [{ id: 1, text: "your fee is 900 and saves 400 a year" }], shown }), ctx)).json();
  assert.deepEqual(j.cards.map((c: any) => c.type), ["FACT", "CALC", "NOTE"]);
  assert.equal(j.cards[1].result, "2.3 years", "the server's arithmetic, not the model's");
  assert.equal(j.dropped, 3);
  assert.equal(j.stage, "numbers");
  assert.equal(j.question.detected, true);
  assert.equal(j.cache, 1234);
});

test("fast lane: a card already shown is not shown again", () => {
  const fact = { type: "FACT", text: "Tailspin leases all three overlap buildings.", source: "Filings bank row 9", grade: "partly" };
  const out = shapeFast({ cards: [fact] }, [fact]);
  assert.equal(out.cards.length, 0);
  assert.equal(out.dropped, 1);
});

test("fast lane: a reply without JSON or a refusal returns no cards, not an error page", async () => {
  mock("sorry, no json here");
  const j = await (await suggest(post({ segments: [] }), ctx)).json();
  assert.deepEqual(j.cards, []);
  assert.match(j.error, /no JSON/);
});

test("steer: returns validated SUGGEST cards only", async () => {
  mock(JSON.stringify({ cards: [{ type: "SUGGEST", say: "Hold the price.", ask: "Who signs?", persona: "Ines Carvalho", pushback: "none" }, { type: "SUGGEST", steer: "no say or ask" }] }));
  const j = await (await steer(post({ stage: "push-back", speaker: "Ines Carvalho", question: "Too high", kind: "pushback" }), ctx)).json();
  assert.equal(j.cards.length, 1);
  assert.equal(j.cards[0].pushback, "none");
  assert.match(calls[0].messages[0].content, /STAGE: push-back/);
});

test("know: page count, personas and room numbers, no model call", async () => {
  mock("unused");
  const j = await (await know(new Request("http://x/testroom/api/know"), ctx)).json();
  assert.equal(j.pages, 2);
  assert.deepEqual(j.personas.map((p: any) => p.name), ["Dan Ellison"]);
  assert.ok(j.numbers.includes(9));
  assert.equal(calls.length, 0);
  assert.equal(knows(ROOM).kinds.persona, 1);
});

test("feed: off by default; when on, writes rooms/<room>/work/fed/<date>-<title>.md", async () => {
  const off = await feed(post({ title: "x", text: "y" }), ctx);
  assert.equal(off.status, 403);
  const repo = mkdtempSync(join(tmpdir(), "feed-"));
  mkdirSync(join(repo, "rooms", "testroom"), { recursive: true });
  writeFileSync(join(repo, "rooms", "testroom", "room.json"), "{}");
  process.env.ASSIST_FEED_SAVE = "on";
  process.env.ASSIST_REPO_DIR = repo;
  try {
    const j = await (await feed(post({ title: "Pricing notes", text: "Floor $750,000.", kind: "notes" }), ctx)).json();
    assert.match(j.saved, /^rooms\/testroom\/work\/fed\/\d{4}-\d{2}-\d{2}-pricing-notes\.md$/);
    const files = readdirSync(join(repo, "rooms", "testroom", "work", "fed"));
    assert.equal(files.length, 1);
    assert.match(readFileSync(join(repo, "rooms", "testroom", "work", "fed", files[0]), "utf8"), /# Pricing notes[\s\S]*Floor \$750,000/);
    assert.equal((await feed(post({ title: "x", text: "y" }), { params: { room: "../etc" } } as any)).status, 400);
  } finally {
    delete process.env.ASSIST_FEED_SAVE;
    delete process.env.ASSIST_REPO_DIR;
  }
});
