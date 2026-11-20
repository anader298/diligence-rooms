// Estimates from the facts the other modules published: team size, budget, pay, growth,
// deal size and decision window. Ranges only, tier D, grade i, with inputs and formula in
// detail. These are reasoning aids, never facts.
import { estimates } from "../colib.mjs";

export default {
  id: "estimates",
  label: "Estimates: team, budget, pay, growth, deal size, timing",
  lane: "late",
  needs: [],
  budgetMs: 5000,
  async run(ctx) {
    const { add, shared, subject } = ctx;
    const rows = estimates({
      title: shared.roleTitle || subject.title,
      revenue: shared.revenue,
      revenueYoY: shared.quarterYoY ?? shared.revenueYoY,
      employees: shared.employees ?? shared.employeesFallback,
      employeesSource: shared.employees ? shared.employeesSource : shared.employeesFallbackSource,
      proxyComp: shared.proxyComp,
      jobs: shared.jobs,
      fiscalYearEnd: shared.fiscalYearEnd,
    });
    for (const r of rows) add({ ...r, grade: "i", tier: "D", url: null, detail: { ...r.detail, note: "estimate: a range from the inputs shown, not a reported fact" } });
  },
};
