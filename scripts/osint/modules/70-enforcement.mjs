// enforcement: EPA ECHO (Enforcement and Compliance History Online) facilities registered under
// the company's name: current compliance status, significant violators, formal enforcement
// actions and penalties in the last five years, across Clean Air, Clean Water, RCRA hazardous
// waste and drinking water. Two calls: get_facilities (builds a query, 0.5 s) and get_qid (up to
// 1,000 facilities, about 1 MB, 1-4 s). Slow lane. Keyless, public.
// Facility names are matched locally: a name must start with the company's name (or carry
// "dba <company>"), so "10045 Tesla Road" or "Everson Tesla" are not the company.

import { normCompany } from "../colib.mjs";

const ECHO = "https://echodata.epa.gov/echo/echo_rest_services";
const money = (n) => "$" + Math.round(n).toLocaleString("en-US");
export const penalty = (f) => Number(String(f.FacTotalPenalties || 0).replace(/[$,]/g, "")) || 0;

/** Facilities that are the company's: the normalised name starts with the company's, or says "dba <company>". */
export function companyFacilities(facilities, names) {
  const want = names.filter(Boolean).map(normCompany).filter((w) => w.length > 2);
  return (facilities || []).filter((f) => {
    const n = normCompany(f.FacName || "");
    return want.some((w) => n === w || n.startsWith(w + " ") || n.includes(" dba " + w));
  });
}

/** Totals and the facilities worth naming (penalties, formal actions, current violations). */
export function summarize(fac) {
  const bad = fac.filter((f) => penalty(f) > 0 || Number(f.FacFormalActionCount) > 0 || /violation/i.test(f.FacComplianceStatus || "") && !/no violation/i.test(f.FacComplianceStatus || ""));
  bad.sort((a, b) => penalty(b) - penalty(a) || Number(b.FacFormalActionCount || 0) - Number(a.FacFormalActionCount || 0));
  return {
    facilities: fac.length,
    states: [...new Set(fac.map((f) => f.FacState).filter(Boolean))].length,
    penalties: fac.reduce((a, f) => a + penalty(f), 0),
    formalActions: fac.reduce((a, f) => a + (Number(f.FacFormalActionCount) || 0), 0),
    significant: fac.filter((f) => f.FacSNCFlg === "Y" || /significant/i.test(f.FacComplianceStatus || "")).length,
    inViolation: fac.filter((f) => /violation/i.test(f.FacComplianceStatus || "") && !/no violation/i.test(f.FacComplianceStatus || "")).length,
    lastPenalty: fac.map((f) => f.FacDateLastPenalty).filter(Boolean).map((d) => d.replace(/(\d\d)\/(\d\d)\/(\d{4})/, "$3-$1-$2")).sort().at(-1) || null,
    worst: bad.slice(0, 8).map((f) => ({ name: f.FacName, city: f.FacCity, state: f.FacState, status: f.FacComplianceStatus, penalties: penalty(f), formalActions: Number(f.FacFormalActionCount) || 0, lastPenalty: f.FacDateLastPenalty || null, snc: f.FacSNCFlg === "Y", registryId: f.RegistryID })),
  };
}

export default {
  id: "enforcement",
  label: "EPA ECHO: environmental compliance, enforcement and penalties",
  lane: "slow",
  needs: ["company"],
  budgetMs: 25000,
  async run(ctx) {
    const { subject, http, shared } = ctx;
    const names = [subject.company, shared.secName].filter(Boolean);
    const q = await http.json(`${ECHO}.get_facilities?output=JSON&p_fn=${encodeURIComponent(subject.company)}&responseset=1000`, { timeout: 10000 });
    const R = q.data?.Results;
    if (!q.ok || !R?.QueryID) {
      if (Number(R?.QueryRows) === 0 || /no facilities/i.test(R?.Message || q.text || "")) return ctx.add({ var: "co.enforcement", value: `No EPA-regulated facilities named "${subject.company}" in ECHO`, url: `https://echo.epa.gov/facilities/facility-search/results?p_fn=${encodeURIComponent(subject.company)}`, grade: "v", tier: "A" });
      if ([403, 429, 503].includes(q.status) || q.status === 0) ctx.status("blocked", `EPA ECHO ${q.status || q.error}`);
      return ctx.miss("co.enforcement", `EPA ECHO facility search: ${q.status ? `HTTP ${q.status}` : q.error || R?.Message || "no answer"}, not checked`);
    }
    const page = await http.json(`${ECHO}.get_qid?output=JSON&qid=${R.QueryID}&pageno=1`, { timeout: 15000 });
    const all = page.data?.Results?.Facilities || [];
    if (!page.ok || !all.length) return ctx.miss("co.enforcement", `EPA ECHO facility list (query ${R.QueryID}): HTTP ${page.status || page.error}, not read`);
    const mine = companyFacilities(all, names);
    const web = `https://echo.epa.gov/facilities/facility-search/results?p_fn=${encodeURIComponent(subject.company)}`;
    if (!mine.length) return ctx.add({ var: "co.enforcement", value: `EPA ECHO: ${R.QueryRows} facilities contain "${subject.company}" in their name, none named as the company itself (streets and other businesses)`, url: web, grade: "p", tier: "A", detail: { queryRows: Number(R.QueryRows) } });
    const s = summarize(mine);
    const truncated = Number(R.QueryRows) > all.length;
    ctx.add({
      var: "co.enforcement",
      value: `EPA ECHO: ${s.facilities} facilities named ${subject.company} in ${s.states} state(s); ${s.inViolation} in violation now (${s.significant} significant), ${s.formalActions} formal enforcement action(s) and ${money(s.penalties)} in penalties over 5 years${s.lastPenalty ? `, latest penalty ${s.lastPenalty}` : ""}${truncated ? ` (first ${all.length} of ${R.QueryRows} name matches read)` : ""}`,
      url: web,
      grade: "v",
      tier: "A",
      date: s.lastPenalty,
      anchors: ["company"],
      detail: { ...s, worst: undefined, queryRows: Number(R.QueryRows), read: all.length },
    });
    for (const f of s.worst.filter((x) => x.penalties > 0 || x.formalActions > 0 || x.snc).slice(0, 5)) {
      ctx.add({ var: "co.enforcement", value: `${f.name}, ${f.city}, ${f.state}: ${f.status || "status unknown"}${f.snc ? " (significant non-complier)" : ""}; ${f.formalActions} formal action(s), ${money(f.penalties)} penalties${f.lastPenalty ? `, last ${f.lastPenalty}` : ""}`, url: `https://echo.epa.gov/detailed-facility-report?fid=${f.registryId}`, grade: "v", tier: "A", date: f.lastPenalty ? f.lastPenalty.replace(/(\d\d)\/(\d\d)\/(\d{4})/, "$3-$1-$2") : null, anchors: ["company"], detail: f });
    }
  },
};
