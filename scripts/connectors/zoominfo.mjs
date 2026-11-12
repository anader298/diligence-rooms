// ZoomInfo (Enterprise API). UNVERIFIED ENDPOINT: the reference at docs.zoominfo.com sits behind
// a customer login. Implemented from the documented minimum:
//   POST https://api.zoominfo.com/authenticate  {username, password} -> {jwt} (valid 1 hour)
//   POST https://api.zoominfo.com/enrich/contact  {matchPersonInput[], outputFields[]}
//   POST https://api.zoominfo.com/enrich/company  {matchCompanyInput[], outputFields[]}
// Newer accounts may be on /data/v1/contacts/enrich with OAuth; set ZOOMINFO_ACCESS_TOKEN to
// skip the username/password step. 1 credit per new contact or company record (est.).
// With revealPersonal (default true) mobilePhone and street address are requested too; every
// email, phone and address that comes back is kept and labelled.
import { call } from "./util.mjs";
import { makePerson, makeCompany, makeSource, splitName } from "./schema.mjs";

const BASE = "https://api.zoominfo.com";
const PERSON_FIELDS = ["id", "firstName", "lastName", "jobTitle", "managementLevel", "jobFunction", "email", "phone", "city", "externalUrls", "companyName", "employmentHistory", "education"];
const PERSONAL_FIELDS = ["mobilePhone", "street", "state", "zipCode"];
const COMPANY_FIELDS = ["id", "name", "website", "primaryIndustry", "employeeCount", "revenue", "parentName", "techAttributes", "totalFundingAmount", "street", "city", "state", "zipCode"];

async function token(ctx) {
  if (ctx.env.ZOOMINFO_ACCESS_TOKEN) return ctx.env.ZOOMINFO_ACCESS_TOKEN;
  if (ctx.cache.zoominfo) return ctx.cache.zoominfo;
  const r = await call(ctx, "zoominfo", `${BASE}/authenticate`, { method: "POST", body: { username: ctx.env.ZOOMINFO_USERNAME, password: ctx.env.ZOOMINFO_PASSWORD } });
  if (!r?.jwt) throw new Error("zoominfo: authenticate returned no jwt");
  return (ctx.cache.zoominfo = r.jwt);
}

const first = (r) => r?.data?.result?.[0]?.data?.[0] || null;

export function normalisePerson(d, fetchedAt) {
  if (!d) return null;
  const hist = (d.employmentHistory || []).map((e) => ({ title: e.jobTitle, company: e.company?.companyName || e.companyName, from: e.fromDate, to: e.toDate }));
  return makePerson(
    {
      names: [[d.firstName, d.lastName].filter(Boolean).join(" ")],
      titles: hist.length ? hist : [{ title: d.jobTitle, company: d.companyName || d.company?.name, current: true }],
      education: (d.education || []).map((e) => ({ school: e.school, degree: [e.educationDegree?.degree, e.educationDegree?.areaOfStudy].filter(Boolean).join(", ") })),
      city: d.city,
      socials: (d.externalUrls || []).map((u) => ({ platform: u.type, url: u.url })),
      emails: d.email ? [{ email: d.email, type: "work" }] : [],
      phones: [...(d.phone ? [{ number: d.phone, type: "direct" }] : []), ...(d.mobilePhone ? [{ number: d.mobilePhone, type: "mobile" }] : [])],
      addresses: d.street ? [{ street: d.street, city: d.city, state: d.state, zip: d.zipCode }] : [],
      seniority: Array.isArray(d.managementLevel) ? d.managementLevel[0] : d.managementLevel,
      departments: (d.jobFunction || []).map((f) => f.department || f.name),
    },
    makeSource("zoominfo", d.id, fetchedAt),
  );
}

export function normaliseCompany(d, fetchedAt) {
  if (!d) return null;
  return makeCompany(
    {
      legalName: d.name,
      domains: [d.website],
      industry: d.primaryIndustry?.[0] || d.primaryIndustry,
      headcount: d.employeeCount,
      // ZoomInfo reports revenue in thousands of US dollars.
      revenue: typeof d.revenue === "number" ? d.revenue * 1000 : d.revenue,
      techStack: (d.techAttributes || []).map((t) => t.product || t.name),
      parent: d.parentName,
      funding: d.totalFundingAmount ? [{ round: "total", amount: d.totalFundingAmount * 1000 }] : [],
      addresses: d.street ? [{ street: d.street, city: d.city, state: d.state, zip: d.zipCode, role: "principal office" }] : [],
    },
    makeSource("zoominfo", d.id, fetchedAt),
  );
}

export default {
  id: "zoominfo",
  name: "ZoomInfo",
  kind: "api",
  envKeys: ["ZOOMINFO_USERNAME", "ZOOMINFO_PASSWORD"],
  optionalEnvKeys: ["ZOOMINFO_ACCESS_TOKEN"],
  fields: ["person.names", "person.titles", "person.education", "person.locationCity", "person.socials", "person.contacts", "person.seniority", "person.departments", "company.legalName", "company.domains", "company.industry", "company.headcount", "company.revenue", "company.techStack", "company.parent", "company.addresses"],
  docsUrl: "https://docs.zoominfo.com/reference/enrichinterface_enrichcontact",
  status: "unverified endpoint",
  configured(ctx) {
    return !!(ctx.env.ZOOMINFO_ACCESS_TOKEN || (ctx.env.ZOOMINFO_USERNAME && ctx.env.ZOOMINFO_PASSWORD));
  },
  estimateCredits(intake, opts = {}) {
    const n = (intake.people || []).length;
    return { credits: n + 1, calls: n + 2, note: `1 per new contact and 1 per company (est.; plan-dependent)${opts.revealPersonal !== false ? "; mobile and street requested in the same call (no extra credit on most plans, est.)" : ""}` };
  },
  async fetchPerson(person, company, ctx) {
    const { first: firstName, last: lastName } = splitName(person.name);
    const r = await call(ctx, "zoominfo", `${BASE}/enrich/contact`, {
      method: "POST",
      headers: { authorization: `Bearer ${await token(ctx)}` },
      body: { matchPersonInput: [{ firstName, lastName, companyName: company.name, ...(person.linkedin ? { externalURL: person.linkedin } : {}) }], outputFields: ctx.revealPersonal !== false ? [...PERSON_FIELDS, ...PERSONAL_FIELDS] : PERSON_FIELDS },
    });
    const d = first(r);
    if (d) ctx.spend(1);
    return normalisePerson(d, ctx.fetchedAt);
  },
  async fetchCompany(company, ctx) {
    const r = await call(ctx, "zoominfo", `${BASE}/enrich/company`, {
      method: "POST",
      headers: { authorization: `Bearer ${await token(ctx)}` },
      body: { matchCompanyInput: [{ companyName: company.name, ...(company.domain || ctx.hints.domain ? { companyWebsite: company.domain || ctx.hints.domain } : {}) }], outputFields: COMPANY_FIELDS },
    });
    const d = first(r);
    if (d) ctx.spend(1);
    return normaliseCompany(d, ctx.fetchedAt);
  },
};
