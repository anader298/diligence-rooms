// Estimates from the facts the other modules published: team size, budget, pay, growth,
// deal size and decision window. Ranges only, tier D, grade i, with every input and the ledger
// row it came from, and the formula, in detail. These are reasoning aids, never facts.
import { estimates, titleFor } from "../colib.mjs";

export default {
  id: "estimates",
  label: "Estimates: team, budget, pay, growth, deal size, timing",
  lane: "late",
  needs: [],
  budgetMs: 5000,
  async run(ctx) {
    const { add, miss, shared, subject } = ctx;
    // strongest title evidence: proxy or leadership page > Form 4 > --title > search
    const t = titleFor(shared, subject);
    const refs = { ...(shared.refs || {}) };
    if (t?.ref) refs.title = t.ref;
    const usedFallback = shared.employees == null && shared.employeesFallback != null;
    if (usedFallback && shared.refs?.employeesFallback) refs.employees = shared.refs.employeesFallback;
    const rows = estimates({
      title: t?.title || null,
      titleSource: t ? { proxy: "proxy", leadership: "company site", form4: "Form 4", given: "--title", search: "search" }[t.source] || t.source : null,
      revenue: shared.revenue,
      revenueYoY: shared.quarterYoY ?? shared.revenueYoY,
      employees: shared.employees ?? shared.employeesFallback,
      employeesSource: shared.employees ? shared.employeesSource : shared.employeesFallbackSource,
      proxyComp: shared.proxyComp,
      jobs: shared.jobs,
      fiscalYearEnd: shared.fiscalYearEnd,
      refs,
    });
    for (const r of rows) add({ ...r, grade: "i", tier: "D", url: null, anchors: r.detail.ledgerIds, detail: { ...r.detail, note: "estimate: a range from the inputs shown, not a reported fact" } });
    if (!t && !shared.proxyComp) miss("est.comp", "no title from the proxy, the company site, a Form 4 or --title, and no proxy pay: no pay estimate rather than a guessed band");
    if (shared.departures?.length) miss("est.team_size", "the subject appears to have left the company (see alerts): estimates describe the seat, not the person");
  },
};
