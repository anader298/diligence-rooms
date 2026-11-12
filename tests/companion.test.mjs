// Companion core: calc extraction and arithmetic, stage, notes, card schema, dedupe.
// Plain code, no model. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import * as C from "../templates/assist/core.js";

const titles = (cards) => cards.map((c) => `${c.title} = ${c.result}`);
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} is not ${b}`);

// ---------------------------------------------------------------- numbers

test("numbers: money with scale, percents, multiples, units, spelled-out counts, years skipped", () => {
  const n = C.parseNumbers("They paid 8x EBITDA of $12 million in 2025, 70% full, nine terminals, 180,000 sq ft, $2.4m").nums;
  const by = (raw) => n.find((x) => x.raw === raw);
  assert.equal(by("8x").kind, "multiple");
  assert.equal(by("$12 million").value, 12e6);
  assert.equal(by("2025").kind, "year");
  assert.equal(by("70%").kind, "pct");
  assert.equal(by("9 terminals").kind, "count");
  assert.equal(by("180,000 sq ft").unit, "sq ft");
  assert.equal(by("$2.4m").value, 2.4e6);
  assert.deepEqual(C.parseNumbers("Q3 results").nums, [], "Q3 is a word, not a number");
  assert.equal(C.parseNumbers("a one-off fee").nums.length, 0, "one-off is not 1");
});

// ---------------------------------------------------------------- calc extraction on transcript lines

test("calc: percent of, share, growth with CAGR, change on a base, multiples, per unit", () => {
  assert.deepEqual(titles(C.calcsFor("About 30% of the $2.4 million is labour.")), ["30% of $2.4M = $720,000"]);
  assert.deepEqual(titles(C.calcsFor("Would you keep six of the nine terminals?")), ["6 of 9 terminals = 66.7%"]);
  assert.deepEqual(titles(C.calcsFor("Cost per shipment went from $14.20 to $16.50 over two years.")), [
    "$14.20 to $16.50 = +16.2% (1.16x)",
    "Growth a year, $14.20 to $16.50 over 2 years = 7.8% a year",
  ]);
  assert.deepEqual(titles(C.calcsFor("Revenue is up 12% on $40m.")), ["$40M up 12% = $44.8M"]);
  assert.deepEqual(titles(C.calcsFor("They paid 8x EBITDA of $12 million.")), ["8x EBITDA = $96M"]);
  assert.deepEqual(titles(C.calcsFor("We spent $2.4m across 9 terminals.")), ["$2.4M per terminal = $266,667 per terminal"]);
});

test("calc: utilisation of two buildings, and whether one fits in the other's spare space", () => {
  const cards = C.calcsFor("We own a 180,000 sq ft warehouse at 70% utilisation, and Tailspin leases a 60,000 sq ft cross-dock at 90%.");
  assert.deepEqual(cards.map((c) => c.result), ["126,000 sq ft used, 54,000 sq ft spare", "54,000 sq ft used, 6,000 sq ft spare", "Fits: needs 100% of the spare"]);
  for (const c of cards) assert.ok(c.inputs.length >= 2 && c.formula, "every CALC shows its inputs and formula");
});

test("calc: unit conversions only when asked", () => {
  assert.deepEqual(C.calcsFor("The Chicago lane is 420 miles."), []);
  assert.deepEqual(titles(C.calcsFor("The Chicago lane is 420 miles, what's that in kilometres?")), ["420 miles in km = 676 km"]);
  assert.deepEqual(titles(C.calcsFor("Convert 2,000 lbs please")), ["2,000 lb in kg = 907 kg"]);
});

test("calc: payback, IRR and NPV from inputs heard across lines", () => {
  const mem = {};
  assert.deepEqual(titles(C.calcsFor("Your fee is $900,000 one-off, and you claim $400,000 a year in savings.", mem)), ["Payback = 2.3 years (27 months)"]);
  const next = C.calcsFor("Over three years at a 9% cost of capital, does that clear our hurdle?", mem);
  const npv = next.find((c) => c.op === "npv"), irr = next.find((c) => c.op === "irr");
  assert.equal(npv.result, "$112,518");
  assert.equal(irr.result, "15.9%");
  // A growth horizon ("over two years") is not an investment horizon.
  const later = C.calcsFor("Cost per shipment went from $14.20 to $16.50 over two years.", mem);
  assert.ok(!later.some((c) => c.op === "npv" && /2\)/.test(c.formula)));
  // A per-unit price is not a one-off cost.
  assert.ok(!C.calcsFor("Cost per shipment is $14.20 and the lease is $1.1 million a year.", {}).some((c) => c.op === "payback"));
});

test("compute: the arithmetic behind every op", () => {
  near(C.compute("pct_of", { pct: 15, base: 1.2e9 }), 1.8e8);
  near(C.compute("share", { part: 6, whole: 9 }), 66.6666666667, 1e-6);
  near(C.compute("change_pct", { from: 50, to: 75 }), 50);
  near(C.compute("cagr", { from: 100, to: 121, years: 2 }), 10, 1e-9);
  near(C.compute("payback", { cost: 2.4e6, annual: 1.1e6 }), 2.4 / 1.1);
  near(C.compute("npv", { cost: 1000, annual: 0, years: 1, rate: 10 }), -1000);
  near(C.compute("irr", { cost: 1000, annual: 1100, years: 1 }), 10, 1e-6);
  near(C.compute("convert", { value: 1, from: "miles", to: "km" }), 1.609344);
  assert.equal(C.compute("payback", { cost: 100, annual: 0 }), null);
  assert.equal(C.compute("irr", { cost: 1000, annual: 100, years: 5 }), null, "never pays back: no IRR");
  assert.equal(C.compute("nonsense", {}), null);
});

test("our side's numbers must be in the facts file", () => {
  const [card] = C.calcsFor("We spent $2.4m across 9 terminals.");
  assert.equal(C.checkOurSide(card, "us", [2400000, 9]).check, undefined, "both inputs known: no warning");
  assert.match(C.checkOurSide(card, "us", [9]).check, /Not in the facts file: \$2\.4M/);
  assert.equal(C.checkOurSide(card, "Ines Carvalho", []).check, undefined, "their numbers are what they said");
});

// ---------------------------------------------------------------- stage, speaker, notes

test("stage: opening, discovery, numbers, push-back (a moment), close (sticky)", () => {
  let s = "opening";
  s = C.stageOf("Thanks for joining us, nice to meet you.", s, "Dan", 0); assert.equal(s, "opening");
  s = C.stageOf("Walk me through where you would start?", s, "Dan", 2); assert.equal(s, "discovery");
  s = C.stageOf("The lease is $1.1 million a year.", s, "Ines", 3); assert.equal(s, "numbers");
  s = C.stageOf("But that's too high, our last consultant charged half.", s, "Ines", 4); assert.equal(s, "push-back");
  s = C.stageOf("Fair question. Here is how I would think about it.", s, "us", 5); assert.equal(s, "push-back", "our answer stays in push-back");
  s = C.stageOf("Okay. And who would own it?", s, "Ines", 6); assert.equal(s, "discovery");
  s = C.stageOf("We're nearly out of time, next steps then.", s, "Dan", 7); assert.equal(s, "close");
  s = C.stageOf("How do you price a pilot?", s, "Dan", 8); assert.equal(s, "close", "close only moves forward");
});

test("speaker from self-introductions", () => {
  const people = [{ name: "Dan Ellison" }, { name: "Ines Carvalho" }];
  assert.equal(C.speakerFromText("Hi, I'm Dan, I run operations.", people), "Dan Ellison");
  assert.equal(C.speakerFromText("Ines here, from Finance.", people), "Ines Carvalho");
  assert.equal(C.speakerFromText("Dan asked about this earlier.", people), null);
});

test("notes: commitments, numbers they gave, names, open questions, follow-ups", () => {
  const people = [{ name: "Dan Ellison" }, { name: "Ines Carvalho" }];
  const kinds = (line, who) => C.notesFor(line, who, people).map((n) => n.kind + ":" + (n.kind === "name" ? n.text : ""));
  assert.deepEqual(kinds("I'll send you a one-page definition by Friday.", "us"), ["commitment:"]);
  assert.deepEqual(kinds("Your fee is $900,000 one-off.", "Ines Carvalho"), ["number:"]);
  assert.deepEqual(kinds("Our fee is $900,000.", "us"), [], "our own numbers are not 'numbers they gave'");
  assert.deepEqual(kinds("Who signs off on this?", "Dan Ellison"), ["question:"]);
  assert.deepEqual(kinds("Let's reconvene next week.", "Dan Ellison"), ["followup:"]);
  assert.deepEqual(kinds("Ines and Peter Walsh from procurement will join.", "Dan Ellison"), ["name:Ines Carvalho", "name:Peter Walsh"]);
});

// ---------------------------------------------------------------- card schema

test("card schema: valid cards of all four types pass and are normalised", () => {
  const fact = C.validateCard({ type: "fact", text: "Tailspin leases all 3 overlap buildings.", source: "Filings bank row 9", grade: "Partly verified" });
  assert.ok(fact.ok); assert.equal(fact.card.type, "FACT"); assert.equal(fact.card.grade, "partly");
  const calc = C.validateCard({ type: "CALC", title: "Payback", result: "2.3 years", inputs: [{ label: "cost", value: "$900,000" }], op: "payback" });
  assert.ok(calc.ok, calc.errors.join());
  assert.ok(C.validateCard({ type: "SUGGEST", ask: "Who signs?" }).ok);
  assert.ok(C.validateCard({ type: "NOTE", kind: "commitment", text: "Send definition by Friday", who: "us" }).ok);
  assert.ok(C.validateCard({ type: "FACT", text: "Not in room. Bridge: I would check that.", source: "" }).ok, "not-in-room needs no page");
  for (const c of C.calcsFor("Cost per shipment went from $14.20 to $16.50 over two years.")) assert.ok(C.validateCard(c).ok, "computed cards pass the schema");
});

test("card schema: broken cards fail with a reason", () => {
  const bad = (c, re) => { const v = C.validateCard(c); assert.equal(v.ok, false); assert.match(v.errors.join("; "), re); };
  bad({ type: "FACT", text: "31 warehouses" }, /page it came from/);
  bad({ type: "FACT", text: "x", source: "p", grade: "probably" }, /not a room grade/);
  bad({ type: "CALC", title: "Payback", result: "2 years" }, /inputs/);
  bad({ type: "CALC", title: "t", result: "r", inputs: [{ value: "1" }], op: "magic" }, /op "magic"/);
  bad({ type: "SUGGEST", steer: "somewhere" }, /say or ask/);
  bad({ type: "NOTE", kind: "gossip", text: "x" }, /kind/);
  bad({ type: "QUOTE", text: "x" }, /unknown type/);
  assert.equal(C.validateCard(null).ok, false);
});

// ---------------------------------------------------------------- dedupe

test("dedupe: repeated and near-repeated cards are dropped, different ones kept", () => {
  const shown = [];
  const fact = { type: "FACT", text: "Tailspin leases all 3 overlap buildings.", source: "Filings bank row 9", grade: "partly" };
  assert.equal(C.mergeCards(shown, [fact]).length, 1);
  assert.equal(C.mergeCards(shown, [{ ...fact }]).length, 0, "exact repeat");
  assert.equal(C.mergeCards(shown, [{ ...fact, text: "Tailspin leases all three overlap buildings" }]).length, 1, "three vs 3: different words, kept");
  assert.equal(C.mergeCards(shown, [{ ...fact, text: "Tailspin leases all 3 of the overlap buildings!" }]).length, 0, "same words, dropped");
  assert.equal(C.mergeCards(shown, [{ type: "NOTE", kind: "name", text: "Tailspin leases all 3 overlap buildings" }]).length, 1, "another type is not a repeat");

  // The same calculation from two lines is one card; the same op with other inputs is another.
  const mem = {};
  const a = C.calcsFor("Your fee is $900,000 one-off, and you claim $400,000 a year in savings.", mem);
  const b = C.calcsFor("Over three years at a 9% cost of capital?", mem);
  const list = [];
  C.mergeCards(list, a);
  const added = C.mergeCards(list, b);
  assert.deepEqual(added.map((c) => c.op).sort(), ["irr", "npv"], "payback is not shown twice");
  assert.equal(C.mergeCards(list, C.calcsFor("Your fee is $800,000 one-off, and you claim $400,000 a year in savings.", {})).length, 1);
});

test("recheckCalc: a model's CALC is recomputed from its op and args", () => {
  const card = { type: "CALC", title: "Payback", op: "payback", result: "9 years", inputs: [{ label: "cost", value: "$900,000" }] };
  assert.equal(C.recheckCalc(card, { cost: 900000, annual: 400000 }).result, "2.3 years");
  assert.match(C.recheckCalc(card, { cost: "lots" }).check, /recompute/);
});
