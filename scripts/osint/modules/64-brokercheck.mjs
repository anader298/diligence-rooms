// brokercheck-iapd: FINRA BrokerCheck and the SEC's Investment Adviser Public Disclosure (one
// backend, two scopes). A registered rep or adviser has a CRD number, current and past firms with
// dates, exams passed, state registrations and disclosure events (customer disputes, regulatory
// actions, terminations). Keyless, undocumented JSON, about 0.3 s a call.
// Grades: v when a current or past firm is the company; p when the branch city is a known place;
// w for a name match only (common names have dozens of namesakes, so those stay a count).

import { nameParts, firstForms, normName, companyIn, placeIn, blockedMiss, isBlocked } from "../person-lib.mjs";

const TERMS = "FINRA BrokerCheck permitted uses: investor protection, compliance and research; not for marketing or solicitation (finra.org/investors/investing/working-with-investment-professional/about-brokercheck/permitted-uses).";
const BC = "https://api.brokercheck.finra.org/search/individual";
const IA = "https://api.adviserinfo.sec.gov/search/individual";

/** True when a search hit is the subject's name: surname equal and a first-name form in the first or other names. */
export function hitNamesSubject(s, subject) {
  const { first, last } = nameParts(subject.name);
  const forms = firstForms(first);
  const names = [`${s.ind_firstname || ""} ${s.ind_lastname || ""}`, ...(s.ind_other_names || [])];
  return names.some((n) => {
    const p = normName(n).split(" ").filter(Boolean);
    return p.length >= 2 && p.at(-1) === last && forms.includes(p[0]);
  });
}

/** Merge BrokerCheck and IAPD hits by CRD; keep those naming the subject, with anchors and grade. */
export function matchHits(bcJson, iaJson, subject, shared = {}) {
  const by = new Map();
  for (const [src, j] of [["bc", bcJson], ["ia", iaJson]]) {
    for (const h of j?.hits?.hits || []) {
      const s = h._source || {};
      if (!s.ind_source_id || !hitNamesSubject(s, subject)) continue;
      const prev = by.get(s.ind_source_id) || { crd: s.ind_source_id, sources: [], firms: [] };
      prev.sources.push(src);
      prev.name = [s.ind_firstname, s.ind_middlename, s.ind_lastname].filter(Boolean).join(" ");
      prev.otherNames = s.ind_other_names || [];
      prev.bcScope = s.ind_bc_scope || prev.bcScope;
      prev.iaScope = s.ind_ia_scope || prev.iaScope;
      prev.disclosure = prev.disclosure || s.ind_bc_disclosure_fl === "Y" || s.ind_ia_disclosure_fl === "Y";
      prev.since = s.ind_industry_cal_date || prev.since || null;
      for (const e of s.ind_current_employments || []) if (!prev.firms.some((f) => f.firm === e.firm_name)) prev.firms.push({ firm: e.firm_name, city: e.branch_city, state: e.branch_state });
      by.set(s.ind_source_id, prev);
    }
  }
  return [...by.values()].map((m) => grade(m, subject, shared));
}

function grade(m, subject, shared, past = []) {
  const anchors = ["name"];
  const all = [...m.firms.map((f) => f.firm), ...past.map((p) => p.firm)];
  if (all.some((f) => companyIn(f, subject))) anchors.push("company");
  if (m.firms.some((f) => placeIn(`${f.city || ""} ${f.state || ""}`, subject, shared))) anchors.push("place");
  return { ...m, anchors, grade: anchors.includes("company") ? "v" : anchors.includes("place") ? "p" : "w" };
}

/** The detail record (exams, registrations, previous firms, disclosures) from the CRD endpoint. */
export function parseDetail(json) {
  let c;
  try {
    c = JSON.parse(json?.hits?.hits?.[0]?._source?.content || "null");
  } catch {
    c = null;
  }
  if (!c) return null;
  const emp = (list) => (list || []).map((e) => ({ firm: e.firmName, from: e.registrationBeginDate || null, to: e.registrationEndDate || null, city: e.branchOfficeLocations?.[0]?.city || null, state: e.branchOfficeLocations?.[0]?.state || null }));
  return {
    current: emp([...(c.currentEmployments || []), ...(c.currentIAEmployments || [])]),
    previous: emp([...(c.previousEmployments || []), ...(c.previousIAEmployments || [])]),
    exams: [...(c.stateExamCategory || []), ...(c.principalExamCategory || []), ...(c.productExamCategory || [])].map((x) => `${x.examCategory}${x.examTakenDate ? ` (${x.examTakenDate})` : ""}`),
    states: (c.registeredStates || []).map((s) => s.state),
    disclosures: (c.disclosures || []).map((d) => ({ type: d.disclosureType, date: d.eventDate || d.disclosureDate || null, resolution: d.disclosureResolution || null, detail: d.disclosureDetail ? JSON.stringify(d.disclosureDetail).slice(0, 400) : null })),
  };
}

export default {
  id: "brokercheck-iapd",
  label: "FINRA BrokerCheck and SEC IAPD: registrations, firms, exams, disclosures",
  lane: "fast",
  needs: ["name"],
  budgetMs: 12000,
  async run(ctx) {
    const { subject, http, shared } = ctx;
    const q = encodeURIComponent(subject.name);
    const [bc, ia] = await Promise.all([
      http.json(`${BC}?query=${q}&hl=true&nrows=50&start=0&wt=json`, { timeout: 8000 }),
      http.json(`${IA}?query=${q}&hl=true&nrows=50&start=0&wt=json`, { timeout: 8000 }),
    ]);
    if (!bc.ok && !ia.ok) {
      if (isBlocked(bc)) return blockedMiss(ctx, "career.licenses", "FINRA BrokerCheck / IAPD", bc, "retry later");
      return ctx.miss("career.licenses", `BrokerCheck / IAPD: HTTP ${bc.status || bc.error}`);
    }
    const search = `https://brokercheck.finra.org/search/genericsearch/grid?query=${q}`;
    const matches = matchHits(bc.data, ia.data, subject, shared);
    if (!matches.length) {
      return ctx.add({ var: "career.licenses", value: `No FINRA-registered representative or SEC investment adviser named ${subject.name} (BrokerCheck and IAPD, current and past registrations)`, url: search, grade: "v", tier: "A", detail: { checked: ["BrokerCheck", "IAPD"], terms: TERMS } });
    }
    // anchored first; detail records for at most three
    matches.sort((a, b) => b.anchors.length - a.anchors.length);
    const strong = matches.filter((m) => m.anchors.length > 1);
    const pick = (strong.length ? strong : matches.length <= 3 ? matches : []).slice(0, 3);
    const details = await Promise.all(pick.map((m) => http.json(`${BC}/${m.crd}?hl=true&includePrevious=true&nrows=12&start=0&wt=json`, { timeout: 8000 })));
    pick.forEach((m, i) => {
      const d = parseDetail(details[i].data);
      const g = d ? grade(m, subject, shared, [...d.previous, ...d.current]) : m;
      const url = `https://brokercheck.finra.org/individual/summary/${m.crd}`;
      const firms = d?.current?.length ? d.current : m.firms;
      ctx.add({
        var: "career.licenses",
        value: `${m.name}, CRD ${m.crd}: ${[m.bcScope && `broker ${m.bcScope.toLowerCase()}`, m.iaScope && m.iaScope !== "NotInScope" && `adviser ${m.iaScope.toLowerCase()}`].filter(Boolean).join(", ")}${firms.length ? `; current: ${firms.map((f) => `${f.firm}${f.city ? ` (${f.city}, ${f.state})` : ""}${f.from ? ` since ${f.from}` : ""}`).join("; ")}` : ""}${d?.previous?.length ? `; previously ${d.previous.slice(0, 4).map((f) => `${f.firm} ${f.from || "?"}–${f.to || "?"}`).join("; ")}` : ""}${d?.exams?.length ? `; exams ${d.exams.slice(0, 6).join(", ")}` : ""}`,
        url,
        grade: g.grade,
        tier: "A",
        anchors: g.anchors,
        date: m.since || null,
        detail: { crd: m.crd, otherNames: m.otherNames, sources: m.sources, ...(d || {}), terms: TERMS },
      });
      if (m.disclosure || d?.disclosures?.length) {
        ctx.add({ var: "rec.disclosures", value: `${m.name}, CRD ${m.crd}: ${d?.disclosures?.length || "one or more"} disclosure event(s)${d?.disclosures?.length ? `: ${d.disclosures.slice(0, 4).map((x) => `${x.type}${x.date ? ` ${x.date}` : ""}${x.resolution ? ` (${x.resolution})` : ""}`).join("; ")}` : ""}`, url, grade: g.grade, tier: "A", anchors: g.anchors, detail: { crd: m.crd, disclosures: d?.disclosures || [], terms: TERMS } });
      }
      if (g.anchors.includes("company") && d?.current?.[0]?.city) shared.places = [...(shared.places || []), { place: d.current[0].city, from: url }];
    });
    const rest = matches.length - pick.length;
    if (rest > 0) ctx.add({ var: "career.licenses", value: `${matches.length} registered individuals named ${subject.name} in BrokerCheck / IAPD; ${pick.length ? `${rest} more without an employer or place tie to the subject` : "none tied to the company or a known place (likely namesakes)"}`, url: search, grade: "w", tier: "A", anchors: ["name"], detail: { crds: matches.map((m) => ({ crd: m.crd, name: m.name, firms: m.firms.map((f) => f.firm) })).slice(0, 20), terms: TERMS } });
  },
};
