// Lusha. Checked against docs.lusha.com on 2026-11-12:
//   POST https://api.lusha.com/v3/contacts/search   {contacts:[{clientReferenceId, firstName, lastName, companyDomain, linkedinUrl}]}
//                                                   finds the contact id; no reveal, no credits
//   POST https://api.lusha.com/v3/contacts/enrich   {ids[], reveal[]}; the reveal spends credits and the
//                                                   response says how many (billing.creditsCharged)
// Auth: header api_key. We reveal emails, and phones too when revealPersonal is on (default true);
// every email and phone that comes back is kept with Lusha's type (work, private, mobile, direct).
// The search response shape (results[] with id and clientReferenceId) is not fully documented.
// Company: GET https://api.lusha.com/v2/company?domain= is the legacy v2 call. UNVERIFIED ENDPOINT
// (the v3 company enrich path was not in the public reference).
import { call } from "./util.mjs";
import { makePerson, makeCompany, makeSource, splitName } from "./schema.mjs";

const BASE = "https://api.lusha.com";
const headers = (ctx) => ({ api_key: ctx.env.LUSHA_API_KEY });

export function normalisePerson(c, fetchedAt) {
  if (!c) return null;
  return makePerson(
    {
      names: [c.fullName, [c.firstName, c.lastName].filter(Boolean).join(" ")],
      titles: [
        ...(c.jobTitle?.title || c.company?.name ? [{ title: c.jobTitle?.title, company: c.company?.name, from: c.jobTitle?.startDate, current: true }] : []),
        ...(c.previousEmployment || []).map((e) => ({ title: e.jobTitle?.title || e.title, company: e.company?.name || e.companyName, from: e.startDate, to: e.endDate })),
      ],
      city: c.location?.city,
      socials: [c.socialLinks?.linkedin, c.socialLinks?.xUrl].filter(Boolean),
      emails: (c.emails || []).map((e) => ({ email: e.email, type: e.type })),
      phones: (c.phones || []).map((p) => ({ number: p.number, type: p.type })),
      seniority: c.jobTitle?.seniority,
      departments: c.jobTitle?.departments || [],
      education: (c.profile?.education || []).map((e) => ({ school: e.school || e.name, degree: e.degree, from: e.startDate, to: e.endDate })),
    },
    makeSource("lusha", c.id, fetchedAt),
  );
}

export function normaliseCompany(d, fetchedAt) {
  const c = d?.data || d;
  if (!c || !(c.name || c.companyName)) return null;
  return makeCompany(
    {
      legalName: c.name || c.companyName,
      domains: [c.domain, c.fqdn, c.website].filter(Boolean),
      industry: c.mainIndustry || c.industry,
      headcount: c.employees || c.companySize?.join?.("-") || c.employeeCount,
      revenue: c.revenueRange?.join?.("-") || c.revenue,
      addresses: c.address ? [{ value: typeof c.address === "string" ? c.address : c.address.fullAddress || c.address, role: "principal office" }] : [],
      funding: (c.funding?.rounds || []).map((r) => ({ round: r.roundType, date: r.roundDate, amount: r.roundAmount, investors: r.investors })),
      techStack: (c.technologies || []).map((t) => t.name || t),
    },
    makeSource("lusha", c.id, fetchedAt),
  );
}

export default {
  id: "lusha",
  name: "Lusha",
  kind: "api",
  envKeys: ["LUSHA_API_KEY"],
  fields: ["person.names", "person.titles", "person.education", "person.locationCity", "person.socials", "person.contacts", "person.seniority", "person.departments", "company.legalName", "company.domains", "company.industry", "company.headcount", "company.revenue", "company.funding", "company.techStack", "company.addresses"],
  docsUrl: "https://docs.lusha.com/apis/openapi",
  status: "verified (person); unverified endpoint (company)",
  estimateCredits(intake, opts = {}) {
    const n = (intake.people || []).length;
    const phones = opts.revealPersonal !== false;
    return { credits: n * (phones ? 6 : 1) + 1, calls: 2 * n + 1, note: `search is free; 1 per email reveal${phones ? " + 5 per phone reveal" : ""} and 1 per company (est.); the reveal response reports the actual charge` };
  },
  async fetchPerson(person, company, ctx) {
    const { first, last } = splitName(person.name);
    const companyDomain = company.domain || ctx.hints.domain;
    if (!companyDomain && !person.linkedin) {
      ctx.note(`search for ${person.name} needs the company domain or a LinkedIn URL; pass --domain`);
      return null;
    }
    const s = await call(ctx, "lusha", `${BASE}/v3/contacts/search`, {
      method: "POST",
      headers: headers(ctx),
      body: { contacts: [{ clientReferenceId: person.slug, firstName: first, lastName: last, ...(companyDomain ? { companyDomain } : {}), ...(person.linkedin ? { linkedinUrl: person.linkedin } : {}) }], options: { includePartialProfiles: false } },
    });
    const hit = (s?.results || s?.contacts || s?.data || []).find((x) => x.id && (!x.clientReferenceId || x.clientReferenceId === person.slug));
    if (!hit) return null;
    const e = await call(ctx, "lusha", `${BASE}/v3/contacts/enrich`, { method: "POST", headers: headers(ctx), body: { ids: [hit.id], reveal: ctx.revealPersonal !== false ? ["emails", "phones"] : ["emails"], waterfallEnabled: false } });
    ctx.spend(e?.billing?.creditsCharged ?? 1);
    return normalisePerson((e?.results || [])[0], ctx.fetchedAt);
  },
  async fetchCompany(company, ctx) {
    const d = company.domain || ctx.hints.domain;
    const r = await call(ctx, "lusha", `${BASE}/v2/company`, { headers: headers(ctx), query: d ? { domain: d } : { company: company.name } });
    const out = normaliseCompany(r, ctx.fetchedAt);
    if (out) ctx.spend(1);
    return out;
  },
};
