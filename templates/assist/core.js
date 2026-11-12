// Companion core: the parts of the live companion that are plain code, not a model.
// Shared by the phone page (site/<room>/assist/core.js) and the functions
// (netlify/functions/assist-*.ts import it), and tested in tests/companion.test.mjs.
//
//   numbersIn / parseNumbers   numbers heard in a line, with money, %, multiples and units
//   calcsFor                   CALC cards computed from a line (+ a small memory of recent lines)
//   compute                    the arithmetic behind every CALC op (the server recomputes model CALCs with it)
//   checkOurSide               our side's numbers must come from the facts file (room or fed items)
//   stageOf                    opening, discovery, numbers, push-back, close
//   notesFor                   NOTE cards: commitments, numbers they gave, names, open questions, follow-ups
//   validateCard / cardKey / isDuplicate / mergeCards   the card schema and dedupe
//
// No dependencies, no network, no DOM. Plain ES module.

// ---------------------------------------------------------------- numbers

const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALE = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };
const UNIT_ALIASES = [
  [/^(sq\.? ?ft|square f(ee|oo)t)$/i, "sq ft"], [/^(m2|m²|sq\.? ?m|square met(er|re)s?)$/i, "m²"],
  [/^(miles?|mi)$/i, "miles"], [/^(km|kilomet(er|re)s?)$/i, "km"],
  [/^(kg|kilos?|kilograms?)$/i, "kg"], [/^(lbs?|pounds?)$/i, "lb"],
  [/^tonnes?$/i, "tonnes"], [/^tons?$/i, "tons"],
  [/^(gallons?|gal)$/i, "gallons"], [/^lit(er|re)s?$/i, "litres"],
  [/^(years?|yrs?)$/i, "years"], [/^months?$/i, "months"], [/^weeks?$/i, "weeks"], [/^days?$/i, "days"],
];
const NUM_RE = /(?:([$€£])\s?)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s?(%|percent\b|per ?cent\b|k\b|thousand\b|mm\b|mn\b|m\b|million\b|bn\b|b\b|billion\b|x\b|times\b))?(?:\s?(dollars|euros|pounds sterling|sq\.? ?ft|square f(?:ee|oo)t|square met(?:er|re)s?|sq\.? ?m\b|m2|m²|miles?\b|mi\b|km\b|kilomet(?:er|re)s?|kg\b|kilos?\b|kilograms?|lbs?\b|pounds?\b|tonnes?|tons?\b|gallons?|gal\b|lit(?:er|re)s?|years?\b|yrs?\b|months?\b|weeks?\b|days?\b|[a-z][a-z-]{2,20}))?/gi;
const TIME_UNITS = new Set(["years", "months", "weeks", "days"]);
const MEASURE_UNITS = new Set(["sq ft", "m²", "miles", "km", "kg", "lb", "tonnes", "tons", "gallons", "litres"]);
// Words after a number that are not a counted noun.
const NOT_NOUN = new Set(["across", "over", "into", "than", "more", "less", "when", "while", "since", "until", "plus", "minus", "now", "then", "up", "down", "a", "an", "the", "and", "or", "to", "of", "in", "on", "at", "for", "per", "is", "was", "are", "were", "with", "from", "by", "over", "but", "so", "that", "this", "it", "one-off", "off", "cost", "costs", "each", "every", "annually", "yearly", "utilisation", "utilization", "full", "capacity", "percent", "times", "ebitda", "earnings", "revenue", "sales"]);

/** Spelled-out small numbers become digits ("nine terminals" -> "9 terminals"), not before a hyphen ("one-off"). */
export function digitize(text) {
  return String(text || "").replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b(?!-)/gi, (w) => String(WORDS[w.toLowerCase()]));
}

function unitOf(u) {
  if (!u) return "";
  for (const [re, name] of UNIT_ALIASES) if (re.test(u)) return name;
  return u.toLowerCase();
}

/**
 * Every number in a line: { value, raw, index, end, kind, unit, cur }.
 * kind: money | pct | multiple | count | measure | duration | year | number
 */
export function parseNumbers(line) {
  const text = digitize(line);
  const out = [];
  for (const m of text.matchAll(NUM_RE)) {
    let [raw, cur, num, scale, unit] = m;
    if (!num) continue;
    const prev = text[m.index - 1] || "";
    if (/[a-z]/i.test(prev)) continue; // "Q3", "H1": part of a word
    let value = Number(num.replace(/,/g, ""));
    let kind = "number";
    const s = (scale || "").toLowerCase().replace(/\s/g, "");
    if (s === "%" || s === "percent" || s === "percent") kind = "pct";
    else if (s === "x" || s === "times") kind = "multiple";
    else if (s && SCALE[s]) value *= SCALE[s];
    let u = unit || "";
    if (/^(dollars)$/i.test(u)) { cur = cur || "$"; u = ""; }
    else if (/^euros$/i.test(u)) { cur = cur || "€"; u = ""; }
    else if (/^pounds sterling$/i.test(u)) { cur = cur || "£"; u = ""; }
    u = unitOf(u);
    const counted = /^(staff|people|headcount|freight|stock)$/.test(u) || (/[a-z]s$/.test(u) && !/ss$/.test(u));
    if (u && (NOT_NOUN.has(u) || (!MEASURE_UNITS.has(u) && !TIME_UNITS.has(u) && !counted))) {
      // Not a unit: give the word back so the next match and the context see it.
      raw = raw.slice(0, raw.toLowerCase().lastIndexOf(u)).trimEnd();
      u = "";
    }
    if (cur) kind = "money";
    else if (kind === "number") {
      if (MEASURE_UNITS.has(u)) kind = "measure";
      else if (TIME_UNITS.has(u)) kind = "duration";
      else if (!s && /^(19|20)\d{2}$/.test(num) && !u) kind = "year";
      else if (u) kind = "count";
    }
    out.push({ value, raw: raw.trim(), index: m.index, end: m.index + raw.length, kind, unit: kind === "pct" || kind === "multiple" || kind === "money" ? "" : u, cur: cur || "" });
  }
  return { text, nums: out };
}

/** Plain numeric values in a text, for "is this number in the facts file?" checks. */
export function numbersIn(text) {
  return [...new Set(parseNumbers(text).nums.filter((n) => n.kind !== "year").map((n) => n.value))];
}

// ---------------------------------------------------------------- formatting

const trim0 = (s) => s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
export function fmt(v, opts = {}) {
  if (v == null || !Number.isFinite(v)) return "n/a";
  const { cur = "", unit = "", pct = false, dp } = opts;
  if (pct) return trim0((v).toFixed(dp ?? 1)) + "%";
  const a = Math.abs(v);
  let s;
  if (cur && a >= 1e9) s = trim0((v / 1e9).toFixed(2)) + "B";
  else if (cur && a >= 1e6) s = trim0((v / 1e6).toFixed(2)) + "M";
  else if (a >= 1e9) s = trim0((v / 1e9).toFixed(2)) + " billion";
  else if (a >= 1e6 && !unit) s = trim0((v / 1e6).toFixed(2)) + " million";
  else if (cur && a < 1000 && a !== Math.round(a)) s = Math.abs(v).toFixed(2);
  else s = (a >= 100 ? Math.round(v) : Number(v.toFixed(dp ?? 2))).toLocaleString("en-US");
  if (cur) s = (v < 0 ? "-" + cur + s.replace("-", "") : cur + s);
  return unit ? s + " " + unit : s;
}
const show = (n) => (n.kind === "pct" ? fmt(n.value, { pct: true }) : n.kind === "multiple" ? trim0(n.value.toFixed(2)) + "x" : fmt(n.value, { cur: n.cur, unit: n.unit }));

// ---------------------------------------------------------------- arithmetic

const CONV = {
  "miles>km": 1.609344, "km>miles": 1 / 1.609344, "lb>kg": 0.45359237, "kg>lb": 1 / 0.45359237,
  "sq ft>m²": 0.09290304, "m²>sq ft": 1 / 0.09290304, "gallons>litres": 3.785411784, "litres>gallons": 1 / 3.785411784,
  "tons>tonnes": 0.90718474, "tonnes>tons": 1 / 0.90718474,
};
export const OTHER_UNIT = { miles: "km", km: "miles", lb: "kg", kg: "lb", "sq ft": "m²", "m²": "sq ft", gallons: "litres", litres: "gallons", tons: "tonnes", tonnes: "tons" };

export function npv(rate, cost, annual, years) {
  let v = -cost;
  for (let t = 1; t <= years; t++) v += annual / Math.pow(1 + rate, t);
  return v;
}
export function irr(cost, annual, years) {
  if (!(cost > 0 && annual > 0 && years > 0)) return null;
  if (annual * years <= cost) return null;
  let lo = 0, hi = 10;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (npv(mid, cost, annual, years) > 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The arithmetic for every CALC op. Inputs are plain numbers (rates as percents).
 * Returns a number, or null when the inputs do not allow it.
 */
export function compute(op, x = {}) {
  const n = (k) => (typeof x[k] === "number" && Number.isFinite(x[k]) ? x[k] : null);
  switch (op) {
    case "pct_of": return n("pct") != null && n("base") != null ? (n("pct") / 100) * n("base") : null;
    case "share": return n("part") != null && n("whole") ? (n("part") / n("whole")) * 100 : null;
    case "change_pct": return n("from") && n("to") != null ? ((n("to") - n("from")) / Math.abs(n("from"))) * 100 : null;
    case "ratio": return n("a") != null && n("b") ? n("a") / n("b") : null;
    case "cagr": return n("from") > 0 && n("to") > 0 && n("years") > 0 ? (Math.pow(n("to") / n("from"), 1 / n("years")) - 1) * 100 : null;
    case "apply_pct": return n("base") != null && n("pct") != null ? n("base") * (1 + n("pct") / 100) : null;
    case "times": return n("multiple") != null && n("base") != null ? n("multiple") * n("base") : null;
    case "per_unit": return n("total") != null && n("units") ? n("total") / n("units") : null;
    case "payback": return n("cost") > 0 && n("annual") > 0 ? n("cost") / n("annual") : null;
    case "npv": return n("cost") != null && n("annual") != null && n("years") > 0 && n("rate") != null ? npv(n("rate") / 100, n("cost"), n("annual"), n("years")) : null;
    case "irr": { const r = n("cost") != null && n("annual") != null && n("years") ? irr(n("cost"), n("annual"), n("years")) : null; return r == null ? null : r * 100; }
    case "convert": { const f = CONV[`${x.from}>${x.to}`]; return f && n("value") != null ? n("value") * f : null; }
    case "add": return Array.isArray(x.values) && x.values.every((v) => typeof v === "number") ? x.values.reduce((a, b) => a + b, 0) : null;
    case "subtract": return n("a") != null && n("b") != null ? n("a") - n("b") : null;
    case "multiply": return n("a") != null && n("b") != null ? n("a") * n("b") : null;
    case "divide": return n("a") != null && n("b") ? n("a") / n("b") : null;
    default: return null;
  }
}
export const CALC_OPS = ["pct_of", "share", "change_pct", "ratio", "cagr", "apply_pct", "times", "per_unit", "payback", "npv", "irr", "convert", "add", "subtract", "multiply", "divide"];

// ---------------------------------------------------------------- calc extraction

const between = (text, a, b) => text.slice(a.end, b.index);
const before = (text, a, len = 45) => text.slice(Math.max(0, a.index - len), a.index).toLowerCase();
const after = (text, a, len = 30) => text.slice(a.end, a.end + len).toLowerCase();
const isAmount = (n) => n.kind === "money" || n.kind === "count" || n.kind === "measure" || n.kind === "number";
const sameKind = (a, b) => (a.kind === b.kind || (isAmount(a) && isAmount(b))) && a.kind !== "year" && b.kind !== "year";

function calc(title, op, ins, result, resultText, extra = {}) {
  return { type: "CALC", title, op, inputs: ins.map(([label, value]) => ({ label, value })), result: resultText, value: result, formula: extra.formula || "", ...extra };
}

/** Annual / one-off / rate / horizon tags for money and percents in a line, for payback and NPV across lines. */
export function tagLine(text, nums) {
  const tags = {};
  for (const n of nums) {
    const b = before(text, n), a = after(text, n);
    if (n.kind === "money") {
      const perYear = /^\s*(a|per|each|every)\s+(year|yr|annum)|^\s*annually|^\s*\/\s*(yr|year)|^\s*yearly/.test(a) || /(annual|yearly|per year)\s*(\w+\s*){0,2}$/.test(b);
      const perMonth = /^\s*(a|per|each|every)\s+month|^\s*monthly/.test(a);
      if (perYear || perMonth) {
        const label = /(sav|lease|rent|return|cash|benefit|profit|ebitda|cost)/.exec(b + " " + a)?.[1] || "cash";
        tags.annual = { value: perMonth ? n.value * 12 : n.value, raw: n.raw + (perMonth ? " a month" : " a year"), cur: n.cur, label: { sav: "saving", lease: "lease", rent: "rent", return: "return", cash: "cash", benefit: "benefit", profit: "profit", ebitda: "EBITDA", cost: "cost" }[label] };
      } else if (!/\bper\s+\w+(\s+\w+)?\s*(is|was|went|of|from|at)?\s*(from\s*)?$/.test(b.slice(-28)) && (/(invest(ment)?|capex|one-off|one off|upfront|up-front|outlay|fit-?out)/.test(b.slice(-30) + " " + a.slice(0, 14)) || /\b(costs?|cost us|spend|spent|pay|paid)\s+(about|around|roughly|us|~|some)?\s*$/.test(b))) {
        tags.cost = { value: n.value, raw: n.raw, cur: n.cur };
      }
    }
    if (n.kind === "pct" && /^\s*(cost of capital|discount|hurdle|wacc|required return)/.test(a) || n.kind === "pct" && /(discount rate|cost of capital|hurdle rate|wacc)\s*(of|at|is|=)?\s*$/.test(b)) tags.rate = { value: n.value, raw: n.raw };
    if (n.kind === "duration" && n.unit === "years" && /(over|for|across|in|within|next)\s*$/.test(b)) tags.years = { value: n.value, raw: n.raw };
  }
  return tags;
}

/**
 * CALC cards for one line. `memory` (optional, mutated) keeps the last cost, annual
 * cash, rate and horizon heard, so payback and NPV work when the inputs come in
 * over two or three lines. Each card: {type:"CALC", title, op, inputs[{label,value}], result, value, formula}.
 */
export function calcsFor(line, memory = null) {
  const { text, nums } = parseNumbers(line);
  const out = [];
  const lower = text.toLowerCase();

  for (let i = 0; i < nums.length; i++) {
    const a = nums[i], b = nums[i + 1];
    const mid = b ? between(text, a, b).toLowerCase() : "";

    // 30% of 2.4M
    if (a.kind === "pct" && b && isAmount(b) && /^\s*of\s+(the\s+|our\s+|their\s+|a\s+|an\s+|its\s+)?$/.test(mid)) {
      const v = compute("pct_of", { pct: a.value, base: b.value });
      out.push(calc(`${show(a)} of ${show(b)}`, "pct_of", [["share", show(a)], ["of", show(b)]], v, fmt(v, { cur: b.cur, unit: b.unit }), { formula: `${show(a)} x ${show(b)}` }));
    }
    // 6 of the 9 terminals
    if (a.kind !== "pct" && b && (b.kind === "count" || b.kind === "number") && !a.cur && /^\s*(out of|of)\s+(the\s+|our\s+|their\s+|its\s+)?$/.test(mid) && b.value > a.value && a.value > 0) {
      const v = compute("share", { part: a.value, whole: b.value });
      out.push(calc(`${a.value} of ${show(b)}`, "share", [["part", String(a.value)], ["whole", show(b)]], v, fmt(v, { pct: true }), { formula: `${a.value} / ${b.value}` }));
    }
    // from A to B (over N years)
    if (b && sameKind(a, b) && a.kind !== "duration" && /(from|was|were)\s*$/.test(before(text, a, 12)) && /^\s*(to|up to|down to|now|->|→)\s*$/.test(mid)) {
      const ch = compute("change_pct", { from: a.value, to: b.value });
      const yrs = /^\s*(over|in|across)\s+(\d+(?:\.\d+)?)\s*(years?|yrs?)/.exec(text.slice(b.end, b.end + 30).toLowerCase());
      const fa = show(a), fb = show({ ...b, cur: b.cur || a.cur });
      out.push(calc(`${fa} to ${fb}`, "change_pct", [["from", fa], ["to", fb]], ch, (ch >= 0 ? "+" : "") + fmt(ch, { pct: true }) + (a.value ? ` (${trim0((b.value / a.value).toFixed(2))}x)` : ""), { formula: `(${fb} - ${fa}) / ${fa}` }));
      if (yrs) {
        const n = Number(yrs[2]);
        const c = compute("cagr", { from: a.value, to: b.value, years: n });
        if (c != null) out.push(calc(`Growth a year, ${fa} to ${fb} over ${n} years`, "cagr", [["from", fa], ["to", fb], ["years", String(n)]], c, fmt(c, { pct: true }) + " a year", { formula: `(${fb} / ${fa})^(1/${n}) - 1` }));
      }
    }
    // up 12% on 40M  /  down 5% from 1,200
    if (a.kind === "pct" && b && isAmount(b) && /(up|down|grew|grow|fell|fall|rise|rose|increase[sd]?|decrease[sd]?|cut|drop(ped)?)\s*(by\s*)?$/.test(before(text, a, 20)) && /^\s*(on|from)\s+(the\s+)?$/.test(mid)) {
      const down = /(down|fell|fall|decrease|cut|drop)/.test(before(text, a, 20));
      const v = compute("apply_pct", { base: b.value, pct: down ? -a.value : a.value });
      out.push(calc(`${show(b)} ${down ? "down" : "up"} ${show(a)}`, "apply_pct", [["base", show(b)], ["change", (down ? "-" : "+") + show(a)]], v, fmt(v, { cur: b.cur, unit: b.unit }), { formula: `${show(b)} x (1 ${down ? "-" : "+"} ${show(a)})` }));
    }
    // 8x EBITDA of $12M  /  8 times earnings
    if (a.kind === "multiple") {
      const m = /^\s*(ebitda|earnings|revenue|sales|ebit|profit)/.exec(after(text, a, 20));
      const base = m && nums.slice(i + 1).find((x) => x.kind === "money");
      if (base) {
        const v = compute("times", { multiple: a.value, base: base.value });
        out.push(calc(`${show(a)} ${m[1].toUpperCase() === "EBITDA" ? "EBITDA" : m[1]}`, "times", [["multiple", show(a)], [m[1], show(base)]], v, fmt(v, { cur: base.cur }), { formula: `${show(a)} x ${show(base)}` }));
      }
    }
    // $2.4M across 9 terminals
    if (a.kind === "money" && b && (b.kind === "count" || b.kind === "measure") && /^\s*(for|across|over|spread over|on|per)\s+(the\s+|our\s+|their\s+|all\s+|its\s+)?$/.test(mid)) {
      const v = compute("per_unit", { total: a.value, units: b.value });
      const unit = (b.unit || "unit").replace(/s$/, "");
      out.push(calc(`${show(a)} per ${unit}`, "per_unit", [["total", show(a)], ["units", show(b)]], v, fmt(v, { cur: a.cur }) + " per " + unit, { formula: `${show(a)} / ${b.value}` }));
    }
    // 180,000 sq ft at 70% (utilisation)
    if (b && (a.kind === "measure" || a.kind === "count") && b.kind === "pct" && /^\s*([a-z-]+\s+){0,2}(at|is at|running at|which is at|runs at|about|around)\s*$/.test(mid)) {
      const used = compute("pct_of", { pct: b.value, base: a.value });
      const spare = a.value - used;
      out.push(calc(`${show(a)} at ${show(b)}`, "pct_of", [["size", show(a)], ["used", show(b)]], used, `${fmt(used, { unit: a.unit })} used, ${fmt(spare, { unit: a.unit })} spare`, { formula: `${show(a)} x ${show(b)}`, used, spare, unit: a.unit }));
    }
  }

  // Two sizes at a utilisation, same unit: does the second one's used space fit in the first's spare?
  const util = out.filter((c) => c.used != null);
  if (util.length >= 2 && util[0].unit === util[1].unit) {
    const [x, y] = util;
    const v = compute("divide", { a: y.used, b: x.spare });
    out.push(calc("Does the second fit in the first's spare space?", "divide", [["spare in first", fmt(x.spare, { unit: x.unit })], ["used in second", fmt(y.used, { unit: y.unit })]], v,
      v <= 1 ? `Fits: needs ${fmt(v * 100, { pct: true, dp: 0 })} of the spare` : `Does not fit: ${fmt((v - 1) * 100, { pct: true, dp: 0 })} short (${fmt(y.used - x.spare, { unit: x.unit })})`,
      { formula: `${fmt(y.used, { unit: y.unit })} / ${fmt(x.spare, { unit: x.unit })}` }));
  }

  // Conversions, only when asked ("in kilometres", "convert", "metric").
  if (/(convert|in metric|in imperial|\bin (km|kilomet|miles|kg|kilos|pounds|lbs|tonnes|tons|litres|liters|gallons|square met|sq m|m2|square feet|sq ft)|what'?s that in)/.test(lower)) {
    for (const n of nums) {
      if (n.kind !== "measure" || !OTHER_UNIT[n.unit]) continue;
      const to = OTHER_UNIT[n.unit];
      const v = compute("convert", { value: n.value, from: n.unit, to });
      out.push(calc(`${show(n)} in ${to}`, "convert", [["value", show(n)]], v, fmt(v, { unit: to, dp: 1 }), { formula: `${show(n)} x ${trim0(CONV[`${n.unit}>${to}`].toFixed(4))}` }));
    }
  }

  // Multi-line: payback, NPV and IRR from the memory of recent lines.
  if (memory) {
    const tags = tagLine(text, nums);
    if (out.some((c) => c.op === "change_pct")) delete tags.years; // "from A to B over 2 years" is growth, not a horizon
    memory.age = (memory.age || 0) + 1;
    for (const k of ["cost", "annual", "rate", "years"]) if (tags[k]) memory[k] = { ...tags[k], at: memory.age };
    for (const k of ["cost", "annual", "rate", "years"]) if (memory[k] && memory.age - memory[k].at > 6) delete memory[k];
    const { cost, annual, rate, years } = memory;
    const fresh = Object.keys(tags).length > 0;
    if (fresh && cost && annual) {
      const pb = compute("payback", { cost: cost.value, annual: annual.value });
      const fc = fmt(cost.value, { cur: cost.cur }), fa = fmt(annual.value, { cur: annual.cur || cost.cur });
      out.push(calc("Payback", "payback", [["one-off cost", fc], [`${annual.label} a year`, fa]], pb, `${trim0(pb.toFixed(1))} years (${Math.round(pb * 12)} months)`, { formula: `${fc} / ${fa}` }));
      if (years) {
        const r = compute("irr", { cost: cost.value, annual: annual.value, years: years.value });
        if (r != null) out.push(calc(`IRR over ${years.value} years`, "irr", [["cost", fc], ["a year", fa], ["years", String(years.value)]], r, fmt(r, { pct: true }), { formula: `rate where NPV = 0` }));
        if (rate) {
          const v = compute("npv", { cost: cost.value, annual: annual.value, years: years.value, rate: rate.value });
          out.push(calc(`NPV at ${fmt(rate.value, { pct: true })}`, "npv", [["cost", fc], ["a year", fa], ["years", String(years.value)], ["rate", fmt(rate.value, { pct: true })]], v, fmt(v, { cur: cost.cur }), { formula: `-${fc} + ${fa} x annuity(${fmt(rate.value, { pct: true })}, ${years.value})` }));
        }
      }
    }
  }
  return out;
}

/**
 * Our side's numbers come only from the facts file. When the line was spoken by us
 * (speaker "us"), every input must appear in the known numbers (room + fed items);
 * otherwise the card is kept but marked to check, and never shown as a result to say.
 */
export function checkOurSide(card, speaker, known) {
  if (speaker !== "us" || !card || card.type !== "CALC") return card;
  const vals = Array.isArray(known) ? known : [];
  const missing = (card.inputs || []).filter((inp) => {
    const v = parseNumbers(String(inp.value)).nums[0];
    if (!v) return false;
    return !vals.some((k) => Math.abs(k - v.value) <= Math.max(0.005 * Math.abs(v.value), 1e-9));
  });
  if (!missing.length) return { ...card, side: "us" };
  return { ...card, side: "us", check: `Not in the facts file: ${missing.map((m) => m.value).join(", ")}. Check before you say it.` };
}

// ---------------------------------------------------------------- stage

export const STAGES = ["opening", "discovery", "numbers", "push-back", "close"];
const RE = {
  close: /\b(next steps?|wrap (it |this |things )?up|out of time|nearly time|thank(s| you)( so much)? for (your|the) time|we'?ll be in touch|timeline (for|to) (a )?decision|any (final|last) questions|before we (finish|close|end))\b/i,
  push: /(\bbut\b|\bhowever\b|i'?m not (sure|convinced)|\breally\?|that seems|i disagree|how do you know|whose definition|that'?s not (true|right|what)|too (high|low|optimistic|aggressive)|why should|\bwe already\b|quarter of our size|i'?d push back|i don'?t buy|prove it|not what we)/i,
  numbers: /(\bper\b|%|\$|€|£|\b(revenue|margin|cost|costs|price|ebitda|percent|million|billion|payback|utili[sz]ation|sq ft|irr|npv|cagr|volume|headcount)\b)/i,
  discovery: /\b(walk me through|tell me (about|how|why)|how (do|would|did|will) you|why (do|would|did)|what (is|are|would|does|did)|where (do|would) you start|talk (me|us) through|who (wins|decides|owns))\b/i,
  opening: /\b(hi|hello|good (morning|afternoon|evening)|nice to (meet|see)|thanks for (joining|coming|making|having)|introduc\w*|let'?s get started|how are you)\b/i,
};

/**
 * The conversation stage after this line. Push-back is a moment: the next line from
 * them that is not a push-back returns to the stage before it. Close only moves forward.
 */
export function stageOf(text, prev = "opening", speaker = "", lineNo = 0) {
  const t = String(text || "");
  const them = speaker !== "us";
  if (RE.close.test(t)) return "close";
  if (prev === "close") return "close";
  if (them && RE.push.test(t)) return "push-back";
  if (RE.numbers.test(t) && parseNumbers(t).nums.some((n) => n.kind !== "year")) return "numbers";
  if (them && (RE.discovery.test(t) || /\?\s*$/.test(t))) return "discovery";
  if (RE.opening.test(t) && lineNo < 8) return "opening";
  if (prev === "push-back") return speaker === "us" ? "push-back" : "discovery";
  return prev || "opening";
}

// ---------------------------------------------------------------- speaker

/**
 * A speaker guess from the words alone: self-introductions ("I'm Dan", "Ines here",
 * "this is Theo") name a person in `people`. Otherwise null; the fast lane decides.
 */
export function speakerFromText(text, people = []) {
  const t = String(text || "");
  for (const p of people) {
    const first = String(p.name || "").split(/\s+/)[0];
    if (!first) continue;
    const re = new RegExp(`\\b(i'?m|i am|this is|it'?s|my name is)\\s+${first}\\b|\\b${first}\\s+here\\b`, "i");
    if (re.test(t)) return p.name;
  }
  return null;
}

// ---------------------------------------------------------------- notes

const COMMIT = /\b(i'?ll|i will|we'?ll|we will|let me|i can|i'?m going to|we'?re going to|i'?d be happy to|will)\b[^.?!]{0,60}\b(send|share|get|follow|come back|check|circulate|introduce|set up|book|confirm|draft|write|look into|find out|loop in|schedule)\b/i;
const FOLLOW = /\b(follow[- ]?up|next steps?|send (me|us|over|it)|circle back|by (monday|tuesday|wednesday|thursday|friday|the end of|end of|next week|tomorrow)|next week|reconvene|second (call|meeting|round))\b/i;
const NAME_STOP = new Set(["The", "This", "That", "We", "I", "It", "And", "But", "So", "Our", "Their", "They", "You", "Your", "If", "When", "What", "Where", "Who", "How", "Why", "Thanks", "Thank", "Yes", "No", "Okay", "OK", "Well", "Right", "Sure", "Hi", "Hello", "Good", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December", "Finance", "Before", "After", "Over", "Ballpark", "City", "Next"]);

/**
 * NOTE cards for one line: commitments made, numbers they gave, names mentioned,
 * open questions (from them), follow-ups. {type:"NOTE", kind, text, who}.
 */
export function notesFor(line, speaker = "", people = []) {
  const t = String(line || "").trim();
  if (!t) return [];
  const who = speaker || "";
  const out = [];
  const short = (s) => (s.length > 120 ? s.slice(0, 117).trimEnd() + "..." : s);
  if (COMMIT.test(t)) out.push({ type: "NOTE", kind: "commitment", text: short(t), who });
  else if (FOLLOW.test(t)) out.push({ type: "NOTE", kind: "followup", text: short(t), who });
  if (who !== "us") {
    const nums = parseNumbers(t).nums.filter((n) => n.kind !== "year" && n.kind !== "duration");
    if (nums.length) out.push({ type: "NOTE", kind: "number", text: nums.map((n) => n.raw).join(", ") + ": " + short(t), who });
    if (/\?/.test(t)) out.push({ type: "NOTE", kind: "question", text: short(t.slice(0, t.lastIndexOf("?") + 1).split(/(?<=[.!])\s+/).pop()), who, open: true });
  }
  const names = new Set();
  for (const p of people) {
    const full = String(p.name || ""), first = full.split(/\s+/)[0];
    if (full && (t.includes(full) || (first && new RegExp(`\\b${first}\\b`).test(t)))) names.add(full);
  }
  for (const m of t.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g)) {
    const words = m[1].split(/\s+/).filter((w) => !NAME_STOP.has(w));
    if (words.length >= 2 && ![...names].some((n) => n.includes(words[0]))) names.add(words.join(" "));
  }
  for (const n of names) if (n !== who) out.push({ type: "NOTE", kind: "name", text: n, who });
  return out;
}

// ---------------------------------------------------------------- card schema

export const CARD_TYPES = ["FACT", "CALC", "SUGGEST", "NOTE"];
export const NOTE_KINDS = ["commitment", "number", "name", "question", "followup"];
export const GRADES = ["verified", "partly", "weak", "inference", "none", "not-public", "unknown", "fed", ""];
const GRADE_WORDS = { "verified": "verified", "partly verified": "partly", "partly": "partly", "weak": "weak", "inference": "inference", "none found": "none", "none": "none", "not public": "not-public", "not-public": "not-public", "unknown": "unknown", "fed": "fed", "fed by you": "fed", "": "" };
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "");

/**
 * Validate and normalise one card. Returns { ok, errors, card }.
 * FACT    {text, source, grade, q?, pushback?: "new"|"none"}
 * CALC    {title, result, formula?, inputs: [{label, value, source?}], op?, check?}
 * SUGGEST {say? , ask?, steer?, why?, persona?, pushback?}  (say or ask required)
 * NOTE    {kind: commitment|number|name|question|followup, text, who?}
 */
export function validateCard(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object") return { ok: false, errors: ["not an object"], card: null };
  const type = String(raw.type || "").toUpperCase();
  if (!CARD_TYPES.includes(type)) return { ok: false, errors: [`unknown type "${raw.type}"`], card: null };
  const c = { type };
  if (type === "FACT") {
    c.text = str(raw.text, 240);
    c.source = str(raw.source, 80);
    const g = GRADE_WORDS[String(raw.grade || "").toLowerCase().trim()];
    c.grade = g ?? "unknown";
    if (raw.grade && g == null) errors.push(`grade "${raw.grade}" is not a room grade`);
    if (raw.q) c.q = str(raw.q, 140);
    if (raw.pushback === "new" || raw.pushback === "none") c.pushback = raw.pushback;
    if (!c.text) errors.push("FACT needs text");
    if (!c.source && !/not in room/i.test(c.text)) errors.push("FACT needs the room page it came from");
  } else if (type === "CALC") {
    c.title = str(raw.title, 100);
    c.result = str(raw.result, 120);
    c.formula = str(raw.formula, 160);
    c.inputs = (Array.isArray(raw.inputs) ? raw.inputs : []).slice(0, 6).map((i) => ({ label: str(i?.label, 40), value: str(i?.value, 40), ...(i?.source ? { source: str(i.source, 60) } : {}) })).filter((i) => i.value);
    if (raw.op) { if (CALC_OPS.includes(raw.op)) c.op = raw.op; else errors.push(`op "${raw.op}" is not known`); }
    if (raw.check) c.check = str(raw.check, 160);
    if (raw.side === "us" || raw.side === "them") c.side = raw.side;
    if (typeof raw.value === "number" && Number.isFinite(raw.value)) c.value = raw.value;
    if (!c.title) errors.push("CALC needs a title");
    if (!c.result) errors.push("CALC needs a result");
    if (!c.inputs.length) errors.push("CALC needs its inputs");
  } else if (type === "SUGGEST") {
    c.say = str(raw.say, 220);
    c.ask = str(raw.ask, 200);
    c.steer = str(raw.steer, 160);
    c.why = str(raw.why, 200);
    c.persona = str(raw.persona, 60);
    if (raw.pushback === "new" || raw.pushback === "none") c.pushback = raw.pushback;
    if (!c.say && !c.ask) errors.push("SUGGEST needs say or ask");
  } else {
    c.kind = NOTE_KINDS.includes(raw.kind) ? raw.kind : "";
    c.text = str(raw.text, 200);
    c.who = str(raw.who, 60);
    if (raw.open) c.open = true;
    if (!c.kind) errors.push(`NOTE kind must be one of ${NOTE_KINDS.join(", ")}`);
    if (!c.text) errors.push("NOTE needs text");
  }
  return { ok: errors.length === 0, errors, card: c };
}

// ---------------------------------------------------------------- dedupe

const STOP = new Set("a an the and or of to in on at for is are was were be it this that with from by as we you they i our their your its about just so very".split(" "));
const tokens = (s) => String(s || "").toLowerCase().replace(/[$€£,]/g, "").replace(/[^a-z0-9.%\s-]/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w));

/** What makes a card the same card: type plus its main words (or its op and inputs for a CALC). */
export function cardKey(c) {
  if (!c) return "";
  if (c.type === "CALC") return "CALC|" + (c.op || "") + "|" + (c.inputs || []).map((i) => String(i.value).toLowerCase().replace(/\s+/g, "")).join(",") + "|" + (c.op ? "" : tokens(c.title).join(" "));
  if (c.type === "NOTE") return "NOTE|" + c.kind + "|" + tokens(c.text).join(" ");
  if (c.type === "FACT") return "FACT|" + tokens(c.text).join(" ");
  return "SUGGEST|" + tokens((c.say || "") + " " + (c.ask || "")).join(" ");
}

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / (A.size + B.size - n);
}

/** True when `card` repeats one in `shown` (same key, or 70% of the same words for the same type). */
export function isDuplicate(card, shown = []) {
  const k = cardKey(card);
  const words = k.split("|").pop().split(" ").filter(Boolean);
  for (const s of shown) {
    if (!s || s.type !== card.type) continue;
    const sk = cardKey(s);
    if (sk === k) return true;
    if (card.type === "CALC" && card.op && s.op) continue; // computed cards are only the same when op and inputs match
    if (card.type === "NOTE" && card.kind !== s.kind) continue;
    const sw = sk.split("|").pop().split(" ").filter(Boolean);
    if (words.length >= 2 && jaccard(words, sw) >= 0.7) return true;
  }
  return false;
}

/** Add new cards to a list, skipping repeats. Returns the cards that were new. */
export function mergeCards(list, incoming) {
  const added = [];
  for (const c of incoming || []) {
    if (!c || isDuplicate(c, list)) continue;
    list.push(c);
    added.push(c);
  }
  return added;
}

/** Recompute a model CALC card with `compute` when it carries op + numeric args; drops it when the numbers disagree badly. */
export function recheckCalc(card, args) {
  if (!card || card.type !== "CALC" || !card.op || !args || typeof args !== "object") return card;
  const v = compute(card.op, args);
  if (v == null) return { ...card, check: card.check || "Could not recompute; treat as rough." };
  const pct = ["share", "change_pct", "cagr", "irr"].includes(card.op);
  return { ...card, value: v, result: pct ? fmt(v, { pct: true }) : card.op === "payback" ? `${trim0(v.toFixed(1))} years` : fmt(v, { cur: args.cur || "" }) };
}
