// sec-proxy (heavy, opt-in: --heavy sec-proxy). The latest DEF 14A read by edgartools (MIT, pinned
// in scripts/osint/py/requirements.txt) in a Python sidecar: every named executive's pay table
// (3 years, by component), pay versus performance (compensation actually paid, TSR against the
// peer group, the company-selected measure), the CEO pay ratio, director pay and audit fees.
// US registrants only (CIK from the sec module). The sec-person module already reads the subject's
// own row from the proxy in Node; this adds the whole table and cross-checks it.

import { runSidecar, depMiss } from "../sidecar.mjs";
import { SEC_UA, nameIn, nameForms } from "../core.mjs";
import { money } from "../colib.mjs";
import { secBase } from "./50-sec.mjs";

const TITLE_START = /\b(Chairman|Chair|Chief|Executive|Senior|Vice|President|Former|General|Group|Corporate|Co-Founder|Founder|Director|Treasurer|Secretary|EVP|SVP|CEO|CFO|COO|CTO)\b/;

/** edgartools puts the start of the title in the name cell ("Amy E. Hood Executive Vice President and" | "CFO"): split it back. */
export function splitName(name, title) {
  const s = String(name || "").replace(/\s+/g, " ").trim();
  const m = s.match(TITLE_START);
  if (!m || m.index < 3) return { name: s, title: String(title || "").trim() || null };
  return { name: s.slice(0, m.index).replace(/[,\s]+$/, ""), title: `${s.slice(m.index)} ${title || ""}`.replace(/\s+/g, " ").trim() };
}

/** Summary Compensation Table rows grouped by executive, newest year first. */
export function byExecutive(sct = []) {
  const out = new Map();
  for (const r of sct) {
    const { name, title } = splitName(r.name, r.title);
    if (!name || !r.year) continue;
    if (!out.has(name)) out.set(name, { name, title, years: [] });
    const e = out.get(name);
    if (!e.years.some((y) => y.year === r.year)) e.years.push({ year: r.year, salary: r.salary, bonus: r.bonus, stock: r.stock_awards, options: r.option_awards, incentive: r.non_equity_incentive, pension: r.pension_change, other: r.other_compensation, total: r.total });
  }
  for (const e of out.values()) e.years.sort((a, b) => b.year - a.year);
  return [...out.values()].sort((a, b) => (b.years[0]?.total || 0) - (a.years[0]?.total || 0));
}

const parts = (y) => [["salary", y.salary], ["bonus", y.bonus], ["stock", y.stock], ["options", y.options], ["incentive", y.incentive], ["other", y.other]].filter(([, v]) => v).map(([k, v]) => `${k} ${money(v)}`).join(", ");

export default {
  id: "sec-proxy",
  /** The ledger variables this module fills (config/form buckets read them to say "no tool yet"). */
  vars: ["co.exec_pay", "money.comp", "voice.priorities"],
  label: "Proxy pay tables: every NEO, pay vs performance, pay ratio (opt-in, edgartools)",
  lane: "heavy",
  flag: "--heavy sec-proxy",
  needs: ["company"],
  deps: { python: ["edgar"] },
  budgetMs: 90000,
  async run(ctx) {
    const { subject } = ctx;
    const b = await secBase(ctx).catch(() => ({}));
    if (!b?.cik) return ctx.miss("co.exec_pay", b?.error ? `proxy pay not read: SEC lookup failed (${b.error}), not checked` : `proxy pay not read: "${subject.company}" is not an SEC registrant`, { blocked: !!b?.error });
    const r = await runSidecar("edgar_proxy", { cik: b.cik, ticker: b.ticker || null, identity: SEC_UA() }, { timeoutMs: 85000, env: ctx.env });
    if (r.missing) return depMiss(ctx, ["co.exec_pay"], "proxy pay (edgartools)", r.missing, null, ["edgar"]);
    if (!r.ok || r.data?.error) {
      ctx.status("error", `sidecar: ${r.error || r.data?.error}`);
      return ctx.miss("co.exec_pay", `proxy pay not read: ${r.error || r.data?.error}`, { blocked: true });
    }
    const d = r.data;
    if (!d.filing) return ctx.miss("co.exec_pay", `no DEF 14A on EDGAR for CIK ${b.cik}`);
    const f = d.filing;
    const base = { url: f.url, date: f.date, tier: "A" };
    const execs = byExecutive(d.sct);
    const forms = nameForms(subject);
    for (const e of execs.slice(0, 10)) {
      const y = e.years[0];
      const isSubject = forms.some((n) => nameIn(e.name, n));
      ctx.add({
        ...base,
        var: "co.exec_pay",
        value: `${e.name}${e.title ? `, ${e.title}` : ""}: FY${y.year} total ${money(y.total)} (${parts(y)})${e.years[1] ? `; FY${e.years[1].year} ${money(e.years[1].total)}` : ""}${e.years[2] ? `, FY${e.years[2].year} ${money(e.years[2].total)}` : ""}`,
        grade: "v",
        anchors: isSubject ? ["name", "proxy-neo"] : ["proxy-neo"],
        detail: { ...e, source: "DEF 14A summary compensation table (edgartools)", accession: f.accession },
      });
      // the subject's own pay, when the Node proxy reader in sec-person did not already find it
      if (isSubject && !(ctx.rows || []).some((x) => x.var === "money.comp" && x.module === "sec-person")) {
        ctx.add({ ...base, var: "money.comp", value: `FY${y.year} total ${money(y.total)} (${parts(y)}) — ${f.form} ${f.date}`, grade: "v", anchors: ["name", "proxy-neo"], detail: { ...e, source: "edgartools" } });
      }
    }
    if (!execs.length) ctx.miss("co.exec_pay", `${f.form} ${f.date}: the summary compensation table could not be parsed`);
    const p = d.pvp || {};
    if (p.peo_total_comp || p.peo_actually_paid_comp) {
      ctx.add({
        ...base,
        var: "co.exec_pay",
        value: `Pay versus performance (${f.form} ${f.date}): CEO pay ${money(p.peo_total_comp)} reported, ${money(p.peo_actually_paid_comp)} actually paid; other NEOs average ${money(p.neo_avg_total_comp)} / ${money(p.neo_avg_actually_paid_comp)}${p.tsr != null ? `; TSR $${p.tsr} vs peer group $${p.peer_tsr ?? "?"} (value of $100 invested)` : ""}${p.selected_measure ? `; company-selected measure: ${p.selected_measure}${p.selected_measure_value ? ` ${money(p.selected_measure_value)}` : ""}` : ""}`,
        grade: "v",
        detail: { ...p, source: "XBRL ecd: pay-versus-performance tags (edgartools)" },
      });
      if (p.measures?.length) ctx.add({ ...base, var: "voice.priorities", value: `Pay is tied to: ${p.measures.join("; ")} (${f.form} ${f.date} pay-versus-performance measures)`, grade: "v", detail: { measures: p.measures } });
    }
    if (d.pay_ratio?.ratio) ctx.add({ ...base, var: "co.exec_pay", value: `CEO pay ratio ${Math.round(d.pay_ratio.ratio)}:1${d.pay_ratio.median ? ` (median employee ${money(d.pay_ratio.median)})` : ""}`, grade: "v", detail: d.pay_ratio });
    if (d.directors?.length) {
      const tot = d.directors.map((x) => x.total).filter((x) => x > 0).sort((a, c) => a - c);
      ctx.add({ ...base, var: "co.exec_pay", value: `Director pay: ${d.directors.length} directors, median total ${money(tot[Math.floor(tot.length / 2)] || 0)}, range ${money(tot[0] || 0)}–${money(tot.at(-1) || 0)}`, grade: "v", detail: { directors: d.directors } });
    }
    const a = d.audit_fees;
    if (a?.total_current) ctx.add({ ...base, var: "co.exec_pay", value: `Audit fees FY${a.current_year || ""}: ${money(a.total_current)} total (audit ${money(a.audit_fees_current)}, audit-related ${money(a.audit_related_current || 0)}, tax ${money(a.tax_fees_current || 0)})${a.total_prior ? `; prior year ${money(a.total_prior)}` : ""}`, grade: "v", detail: a });
    if (d.proposals?.length) ctx.add({ ...base, var: "co.exec_pay", value: `${f.form} ${f.date} ballot: ${d.proposals.join("; ")}`, grade: "v", detail: { proposals: d.proposals } });
    ctx.log(`${f.form} ${f.date}: ${execs.length} executives, ${r.ms} ms`);
  },
};
