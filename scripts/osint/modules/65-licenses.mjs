// licenses: professional licences and registrations by name, all keyless public registers.
//   NPI registry (CMS): clinicians, with credential, specialty (taxonomy) and practice address
//   New York attorney registry (data.ny.gov, Socrata): employer, law school, year admitted
//   Colorado DORA professional licences (data.colorado.gov): CPAs, engineers, clinicians and more
//   Texas TDLR licences (data.texas.gov): trades and occupations
// Grades: v when the employer on the record is the company; p when the city or state is a known
// place; w for the name alone (shown only when few; otherwise counted as possible namesakes).

import { nameParts, firstForms, normName, companyIn, placeIn, isBlocked, blockedMiss } from "../person-lib.mjs";

const up = (s) => String(s || "").toUpperCase().replace(/'/g, "''");
const cap = (s) => String(s || "").toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, a, b) => a + b.toUpperCase());

/** Socrata IN-list of first-name forms, upper-cased. */
const inList = (forms) => forms.map((f) => `'${up(f)}'`).join(",");

export function sources(subject) {
  const { first, last } = nameParts(subject.name);
  const forms = firstForms(first).filter((f) => f.length > 1).slice(0, 6);
  const q = (s) => encodeURIComponent(s);
  return [
    {
      id: "npi",
      label: "NPI registry (CMS)",
      url: `https://npiregistry.cms.hhs.gov/api/?version=2.1&enumeration_type=NPI-1&first_name=${q(first)}&last_name=${q(last)}&limit=50`,
      web: `https://npiregistry.cms.hhs.gov/search?firstName=${q(first)}&lastName=${q(last)}`,
      parse: (j) =>
        (j?.results || []).map((r) => {
          const loc = (r.addresses || []).find((a) => a.address_purpose === "LOCATION") || r.addresses?.[0] || {};
          const tax = (r.taxonomies || []).find((t) => t.primary) || r.taxonomies?.[0] || {};
          return { name: cap([r.basic?.first_name, r.basic?.middle_name, r.basic?.last_name].filter(Boolean).join(" ")), first: r.basic?.first_name, last: r.basic?.last_name, id: `NPI ${r.number}`, what: [r.basic?.credential, tax.desc].filter(Boolean).join(", ") || "clinician", since: r.basic?.enumeration_date || null, city: loc.city, state: loc.state, employer: r.basic?.organization_name || null, status: r.basic?.status === "A" ? "active" : r.basic?.status, url: `https://npiregistry.cms.hhs.gov/provider-view/${r.number}`, license: tax.license ? `${tax.state} licence ${tax.license}` : null };
        }),
    },
    {
      id: "ny-attorney",
      label: "New York attorney registry",
      url: `https://data.ny.gov/resource/eqw2-r5nb.json?$limit=50&$where=${q(`upper(last_name)='${up(last)}' AND upper(first_name) in(${inList(forms)})`)}`,
      web: "https://iapps.courts.state.ny.us/attorneyservices/search",
      parse: (j) =>
        (Array.isArray(j) ? j : []).map((r) => ({ name: cap([r.first_name, r.middle_name, r.last_name].filter(Boolean).join(" ")), first: r.first_name, last: r.last_name, id: `NY registration ${r.registration_number}`, what: "attorney", since: r.year_admitted || null, city: r.city, state: r.state, employer: r.company_name || null, status: r.status, lawSchool: r.law_school || null, url: `https://data.ny.gov/resource/eqw2-r5nb.json?registration_number=${r.registration_number}` })),
    },
    {
      id: "co-dora",
      label: "Colorado DORA professional licences",
      url: `https://data.colorado.gov/resource/7s5z-vewr.json?$limit=50&$where=${q(`upper(lastname)='${up(last)}' AND upper(firstname) in(${inList(forms)})`)}`,
      web: "https://apps.colorado.gov/dora/licensing/Lookup/LicenseLookup.aspx",
      parse: (j) =>
        (Array.isArray(j) ? j : []).map((r) => ({ name: cap([r.firstname, r.middlename, r.lastname].filter(Boolean).join(" ")), first: r.firstname, last: r.lastname, id: `CO ${r.licensetype} ${r.licensenumber}`, what: `licence type ${r.licensetype}`, since: String(r.licensefirstissuedate || "").slice(0, 10) || null, city: r.city, state: r.state, employer: null, status: r.licensestatusdescription, url: r.linktoverifylicense?.url || "https://apps.colorado.gov/dora/licensing/Lookup/LicenseLookup.aspx" })),
    },
    {
      id: "tx-tdlr",
      label: "Texas TDLR licences",
      url: `https://data.texas.gov/resource/7358-krk7.json?$limit=50&$where=${q(`starts_with(upper(owner_name), '${up(last)}, ')`)}`,
      web: "https://www.tdlr.texas.gov/LicenseSearch/",
      parse: (j) =>
        (Array.isArray(j) ? j : []).map((r) => {
          const [l, f = ""] = String(r.owner_name || "").split(",");
          return { name: cap(`${f.trim()} ${l.trim()}`), first: f.trim().split(" ")[0], last: l.trim(), id: `TX ${r.license_type} ${r.license_number}`, what: r.license_type, since: null, city: null, state: "TX", county: r.business_county, employer: r.business_name && normName(r.business_name) !== normName(r.owner_name) ? r.business_name : null, status: `expires ${r.license_expiration_date_mmddccyy}`, url: "https://www.tdlr.texas.gov/LicenseSearch/" };
        }),
    },
  ];
}

/** Keep records naming the subject (surname equal, first-name form), with anchors and grade. */
export function matchRecords(recs, subject, shared = {}) {
  const { first, last } = nameParts(subject.name);
  const forms = firstForms(first);
  return recs
    .filter((r) => normName(r.last) === last && forms.includes(normName(r.first).split(" ")[0]))
    .map((r) => {
      const anchors = ["name"];
      if (r.employer && companyIn(r.employer, subject)) anchors.push("company");
      if (placeIn(`${r.city || ""} ${r.state || ""}`, subject, shared) && (r.city || subject.state)) anchors.push("place");
      return { ...r, anchors, grade: anchors.includes("company") ? "v" : anchors.includes("place") ? "p" : "w" };
    });
}

export default {
  id: "licenses",
  label: "Professional licences: NPI, NY attorneys, Colorado DORA, Texas TDLR",
  lane: "fast",
  needs: ["name"],
  budgetMs: 12000,
  async run(ctx) {
    const { subject, http, shared } = ctx;
    const src = sources(subject);
    const res = await Promise.all(src.map((s) => http.json(s.url, { timeout: 8000 })));
    let anyOk = false;
    src.forEach((s, i) => {
      const r = res[i];
      if (!r.ok) {
        if (isBlocked(r)) blockedMiss(ctx, "career.licenses", s.label, r, "retry later", { partial: true });
        else ctx.miss("career.licenses", `${s.label}: HTTP ${r.status || r.error}, not checked`);
        return;
      }
      anyOk = true;
      const m = matchRecords(s.parse(r.data), subject, shared);
      if (!m.length) return ctx.miss("career.licenses", `${s.label}: no record for ${subject.name}`);
      const strong = m.filter((x) => x.anchors.length > 1);
      const show = strong.length ? strong : m.length <= 3 ? m : [];
      for (const x of show.slice(0, 5)) {
        ctx.add({ var: "career.licenses", value: `${s.label}: ${x.name}, ${x.what}, ${x.id}${x.status ? `, ${x.status}` : ""}${x.since ? `, since ${x.since}` : ""}${x.employer ? `; employer ${x.employer}` : ""}${x.city || x.state ? `; ${[x.city, x.state].filter(Boolean).join(", ")}` : ""}`, url: x.url, grade: x.grade, tier: "A", anchors: x.anchors, date: x.since && /^\d{4}/.test(x.since) ? x.since : null, detail: { source: s.id, ...x } });
        if (x.lawSchool) ctx.add({ var: "career.education", value: `${x.lawSchool} (law; admitted to the New York bar ${x.since || "?"})`, url: x.url, grade: x.grade, tier: "A", anchors: x.anchors, date: x.since || null, detail: { source: s.id, registration: x.id } });
      }
      if (!show.length) ctx.add({ var: "career.licenses", value: `${s.label}: ${m.length} records named ${subject.name}, none tied to ${subject.company || "the company"} or a known place (likely namesakes)`, url: s.web, grade: "w", tier: "A", anchors: ["name"], detail: { source: s.id, records: m.slice(0, 15).map((x) => ({ id: x.id, what: x.what, city: x.city, state: x.state, employer: x.employer })) } });
    });
    if (!anyOk) ctx.status("blocked", "every licence register refused");
  },
};
