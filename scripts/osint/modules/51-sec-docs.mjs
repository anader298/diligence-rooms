// Reads the filings themselves: segment note and revenue split from the latest 10-Q/10-K,
// headcount and legal proceedings from the 10-K, KPIs and theme shifts from the last two
// earnings releases (8-K item 2.02, exhibit 99.1). Slow lane: these documents are 1-4 MB.
import { SEC_UA } from "../core.mjs";
import { htmlText, htmlTables, tableRows, kpisFrom, themeCounts, titleWords, sentences, money, titleFor } from "../colib.mjs";
import { secBase } from "./50-sec.mjs";

const H = () => ({ "user-agent": SEC_UA() });
const ARCH = "https://www.sec.gov/Archives/edgar/data";
const N = (s) => {
  const t = String(s ?? "").replace(/[$,\s]/g, "");
  const n = /^\(.*\)$/.test(t) ? -Number(t.slice(1, -1)) : Number(t);
  return Number.isFinite(n) ? n : null;
};

const SCALE_RE = /\(?\s*(?:\$|dollars|amounts|usd)?\s*(?:are\s+)?in\s+(thousands|millions|billions)\b/i;
const SCALE = { thousands: 1e3, millions: 1e6, billions: 1e9 };

/**
 * Scale of a table: a header cell inside the table ("In millions", "(in thousands, except per
 * share)") wins; else the nearest statement in the text just before it. Returns { scale, how }.
 */
export function tableScale(html, at, rows = []) {
  for (const r of rows.slice(0, 6)) for (const c of r) {
    const m = String(c).match(SCALE_RE);
    if (m) return { scale: SCALE[m[1].toLowerCase()], how: `table header "${c.slice(0, 40)}"` };
  }
  const t = htmlText(html.slice(Math.max(0, at - 2500), at).replace(/^[^<]*>/, "")).toLowerCase();
  const hits = [...t.matchAll(/in (thousands|millions|billions)\b/g)];
  if (hits.length) {
    const m = hits.at(-1);
    return { scale: SCALE[m[1]], how: `text before the table "${t.slice(Math.max(0, m.index - 20), m.index + 20).trim()}"` };
  }
  return { scale: 1e3, how: "no unit stated near the table; assumed thousands (the EDGAR norm)", guessed: true };
}

/** The period the first number column covers, from the header rows: "Three months ended September 30, 2026". */
function periodOf(rows, firstData) {
  const head = rows.slice(0, firstData);
  const span = head.map((r) => r[0]).find((c) => /(three|six|nine|twelve) months|quarter|year ended|fiscal/i.test(c || ""));
  const year = head.flatMap((r) => r).find((c) => /^(19|20)\d\d$/.test(c));
  const date = head.map((r) => r[0]).find((c) => /^[A-Z][a-z]+ \d{1,2},?$/.test(c || ""));
  return [span, date && !span?.includes(date) ? date.replace(/,$/, "") : null, year].filter(Boolean).join(" ").replace(/\s+/g, " ").trim() || null;
}

/** Revenue split tables: a "Total revenue" row, no cost/expense rows, a few labelled lines. */
export function revenueSplits(html, { from = 0 } = {}) {
  const out = [];
  for (const t of htmlTables(html)) {
    if (t.at < from) continue;
    const rows = tableRows(t.html);
    const labels = rows.map((r) => r[0]);
    if (!labels.some((l) => /^total (net )?(revenues?|sales|net sales)\b/i.test(l))) continue;
    if (labels.some((l) => /cost of|operating expenses|gross profit|net income|income tax|deferred|contract liabilit|receivable|notes due|thereafter|amortiz/i.test(l))) continue;
    // header rows ("In millions 2026 2025", a lone year, "Three months ended") are not lines
    const isHeader = (r) => /^\(?\s*(?:\$\s*)?in (thousands|millions|billions)\b/i.test(r[0]) || /^\d{4}$/.test(r[0]) || r.slice(1).every((c) => /^(19|20)\d\d$/.test(c));
    // "Percentage of total revenue" and "% change" lines are ratios, not money
    const isRatio = (r) => /\b(percent(age)?|% of|% change|as a %|change)\b|%/i.test(r[0]) || r.slice(1, 3).some((c) => /%\s*$/.test(String(c || "")));
    const lines = rows.filter((r) => r.length >= 2 && !isHeader(r) && !isRatio(r) && N(r[1]) != null && !/^total/i.test(r[0]) && /[a-z]/i.test(r[0]) && r[0].length < 80);
    if (lines.length < 2 || lines.length > 12) continue;
    const { scale, how, guessed } = tableScale(html, t.at, rows);
    const firstData = rows.indexOf(lines[0]);
    const pre = html.slice(Math.max(0, t.at - 900), t.at).replace(/^[^<]*>/, "");
    const ctx = htmlText(pre).slice(-200);
    out.push({ at: t.at, context: ctx, period: periodOf(rows, firstData), scale, scaleFrom: how, scaleGuessed: !!guessed, rows: lines.map((r) => ({ label: r[0], value: N(r[1]) * scale })) });
    if (out.length >= 3) break;
  }
  return out;
}

async function primary(http, f) {
  const r = await http.get(f.url, { headers: H(), timeout: 25000 });
  return r.ok ? r.text : null;
}

async function exhibit991(http, cik, f) {
  const base = `${ARCH}/${Number(cik)}/${f.acc.replace(/-/g, "")}/`;
  const idx = await http.json(base + "index.json", { headers: H(), timeout: 10000 });
  const items = idx.data?.directory?.item || [];
  const cands = items.filter((i) => /\.htm/i.test(i.name) && i.name !== f.doc && !/index/i.test(i.name));
  cands.sort((a, b) => (/99[-_.]?0?1|ex991|earnings/i.test(b.name) ? 1 : 0) - (/99[-_.]?0?1|ex991|earnings/i.test(a.name) ? 1 : 0));
  let best = null;
  for (const ex of cands.slice(0, 3)) {
    const r = await http.get(base + ex.name, { headers: H(), timeout: 15000 });
    if (!r.ok) continue;
    const text = htmlText(r.text);
    const score = (text.match(/\b(quarter|revenue|fiscal)\b/gi) || []).length;
    if (!best || score > best.score) best = { url: base + ex.name, text, date: f.date, score };
  }
  return best;
}

export default {
  id: "sec-docs",
  /** The ledger variables this module fills (config/form buckets read them to say "no tool yet"). */
  vars: ["co.segments", "co.facts", "co.legal", "co.arr", "co.growth_line", "voice.priorities", "co.kpis"],
  label: "SEC filings read: segments, KPIs, themes, legal",
  lane: "slow",
  needs: ["company"],
  budgetMs: 40000,
  async run(ctx) {
    const { http, add, miss, shared, subject } = ctx;
    const b = await secBase(ctx);
    if (!b.cik) {
      for (const v of ["co.segments", "co.kpis", "co.growth_line", "co.legal"]) miss(v, `${subject.company} has no SEC filings to read (private or not matched)`);
      return;
    }
    const cik = b.cik;
    const fl = b.filings;
    const periodic = fl.find((f) => ["10-Q", "10-K"].includes(f.form));
    const tenK = fl.find((f) => f.form === "10-K");
    const rel = fl.filter((f) => f.form === "8-K" && f.items.includes("2.02")).slice(0, 2);

    const [pDoc, kDoc, rels] = await Promise.all([
      periodic ? primary(http, periodic) : null,
      tenK && tenK !== periodic ? primary(http, tenK) : null,
      Promise.all(rel.map((f) => exhibit991(http, cik, f))),
    ]);
    const k = tenK === periodic ? pDoc : kDoc;

    // ---- segments
    if (pDoc) {
      const text = htmlText(pDoc);
      const segI = text.search(/Segment (Information|Reporting)\b(?! \()/i);
      const near = segI >= 0 ? text.slice(segI, segI + 2500) : text;
      const count = near.match(/\b(one|single|two|three|four|five|six|seven|eight|\d+)\s+(?:operating and\s+)?(?:reportable|operating)\s+(?:and reportable\s+)?segments?/i);
      const names = near.match(/segments?(?: are|:)\s+([A-Z][^.]{10,240})\./);
      const splits = revenueSplits(pDoc, { from: Math.floor(pDoc.length * 0.25) });
      if (count || splits.length) {
        const split = splits[0];
        const WORDS = { one: 1, single: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
        const nSeg = count ? WORDS[count[1].toLowerCase()] || Number(count[1]) : null;
        // a table is the segment split only when its lines match the segment count; otherwise it is
        // a breakdown (by product type, market or country) and is labelled as such
        const kind = (s) => (nSeg && s.rows.length === nSeg && !s.rows.some((r) => /\b(revenues?|sales)$|\b(license|subscription|hardware|services?|products?)\b.*\brevenue/i.test(r.label)) ? "segment revenue" : "revenue breakdown");
        const line = (s) => `${kind(s)}${s.period ? ` (${s.period})` : ""}: ` + s.rows.slice(0, 6).map((r) => `${r.label} ${money(r.value)}`).join(", ") + (s.scaleGuessed ? " (units assumed thousands)" : "");
        const val = [count ? `${count[1].replace(/^single$/i, "one")} reportable segment${/^(one|single|1)$/i.test(count[1]) ? "" : "s"}` : null, names && !/^(one|single)$/i.test(count?.[1] || "") ? names[1].slice(0, 160) : null, split ? line(split) : null].filter(Boolean).join("; ");
        shared.segments = { count: count?.[1] || null, splits };
        add({ var: "co.segments", value: val, url: periodic.url, grade: split?.scaleGuessed ? "p" : "v", tier: "A", date: periodic.date, detail: { form: periodic.form, note: near.slice(0, 700), splits } });
        for (const s of splits.slice(1, 3)) add({ var: "co.segments", value: line(s), url: periodic.url, grade: s.scaleGuessed ? "p" : "v", tier: "A", date: periodic.date, detail: s });
      } else miss("co.segments", `no segment note or revenue split table found in ${periodic.form} ${periodic.date}`);
    } else miss("co.segments", periodic ? `${periodic.form} fetch failed` : "no 10-Q/10-K filed");

    // ---- 10-K: headcount, legal proceedings, litigation risk
    if (k) {
      const text = htmlText(k);
      const emp = text.match(/(?:approximately|about|had|employed|total of)\s+([\d,]{3,9})\s+(?:full[- ]time\s+)?(?:employees|people|team members|associates)/i);
      if (emp) {
        const n = Number(emp[1].replace(/,/g, ""));
        const mine = !shared.employees;
        if (mine) {
          shared.employees = n;
          shared.employeesSource = `10-K ${tenK.date}`;
        }
        // "approximately 167,000 full-time and 109,000 part-time associates": say both, never one as the total
        const near = text.slice(emp.index, emp.index + 260);
        const pt = /full[- ]time/i.test(emp[0]) ? near.match(/(?:and|plus|with)\s+(?:approximately\s+|about\s+)?([\d,]{3,9})\s+part[- ]time/i) : null;
        const label = /full[- ]time/i.test(emp[0]) ? `${n.toLocaleString()} full-time${pt ? ` and ${pt[1]} part-time` : ""} employees` : `${n.toLocaleString()} employees`;
        const erow = add({ var: "co.facts", value: `${label} (10-K ${tenK.date})`, url: tenK.url, grade: "v", tier: "A", date: tenK.date, detail: { quote: text.slice(Math.max(0, emp.index - 120), emp.index + 120) } });
        if (mine && erow?.id) (shared.refs ||= {}).employees = erow.id;
      }
      const i3 = [...text.matchAll(/Item\s*3\.?\s*Legal Proceedings/gi)].map((m) => m.index).at(-1);
      const i3body = (i) => text.slice(i, i + 1500).replace(/Item\s*4\.[\s\S]*$/i, "");
      // the table of contents also says "Item 3. Legal Proceedings 19": skip a body that is only a page number
      if (i3 != null && i3body(i3).replace(/^Item\s*3\.?\s*Legal Proceedings\s*/i, "").trim().length >= 40) {
        const body = i3body(i3);
        add({ var: "co.legal", value: `10-K Item 3: ${body.replace(/^Item\s*3\.?\s*Legal Proceedings\s*/i, "").slice(0, 300)}`, url: tenK.url, grade: "v", tier: "A", date: tenK.date, detail: { text: body } });
      }
      const ia = text.search(/Item\s*1A\.?\s*Risk Factors(?!\s*\d)/i);
      const ib = ia >= 0 ? text.slice(ia + 50).search(/Item\s*1B\.?|Item\s*2\.?\s*Properties/i) : -1;
      if (ia >= 0) {
        const rf = text.slice(ia, ib > 0 ? ia + 50 + ib : ia + 200000);
        const lit = sentences(rf).filter((s) => /(litigation|lawsuit|class action|investigation|subpoena|regulatory proceeding|enforcement)/i.test(s) && s.length < 500);
        lit.sort((a, b) => (b.match(/litigation|lawsuit|class action|investigation/gi) || []).length - (a.match(/litigation|lawsuit|class action|investigation/gi) || []).length);
        add({ var: "co.legal", value: `Risk factors: ${lit.length} sentences on litigation or investigations${lit[0] ? `, e.g. "${lit[0].slice(0, 180)}"` : ""}`, url: tenK.url, grade: "p", tier: "A", date: tenK.date, detail: { sample: lit.slice(0, 6) } });
      }
    } else miss("co.legal", "no 10-K to read");

    // ---- earnings releases: KPIs, themes now vs the release before
    const [now, prev] = rels;
    if (now) {
      const kp = kpisFrom(now.text, { company: subject.company });
      for (const x of kp) add({ var: x.kpi === "ARR" ? "co.arr" : "co.kpis", value: `${x.kpi}: ${x.value} (${now.date} release)`, url: now.url, grade: "v", tier: "A", date: now.date, detail: { context: x.context } });
      if (!kp.some((x) => x.kpi === "ARR")) miss("co.arr", `no ARR figure in the ${now.date} earnings release`);
      const words = titleWords(titleFor(shared, subject)?.title);
      const a = themeCounts(now.text, words);
      const p = prev ? themeCounts(prev.text, words) : null;
      const top = Object.entries(a).filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1]);
      const deltas = p ? Object.keys(a).map((t) => [t, a[t] - p[t], p[t], a[t]]).filter(([, d]) => d > 0).sort((x, y) => y[1] - x[1]) : [];
      if (deltas.length) add({ var: "co.growth_line", value: `Release language rising: ${deltas.slice(0, 4).map(([t, , x, y]) => `${t} ${x}→${y}`).join(", ")} (${prev.date} → ${now.date})`, url: now.url, grade: "i", tier: "C", date: now.date, detail: { now: a, before: p, prevUrl: prev.url } });
      add({ var: "voice.priorities", value: `Most-used themes in the ${now.date} earnings release: ${top.slice(0, 5).map(([t, n]) => `${t} (${n})`).join(", ")}`, url: now.url, grade: "i", tier: "C", date: now.date, detail: { counts: a } });
      const guide = sentences(now.text).filter((s) => /(expect|outlook|guidance|priorit|focus|strategy|invest)/i.test(s) && /(AI|growth|platform|acqui|integrat|efficien|margin)/.test(s) && !/forward-looking|safe harbor|risks and uncertainties/i.test(s) && s.length < 400).slice(0, 2);
      for (const s of guide) add({ var: "co.growth_line", value: s, url: now.url, grade: "p", tier: "A", date: now.date });
    } else miss("co.kpis", rel.length ? "earnings release exhibit not found" : "no 8-K item 2.02 (earnings) in recent filings");
  },
};
