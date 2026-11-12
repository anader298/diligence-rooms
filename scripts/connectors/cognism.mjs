// Cognism. UNVERIFIED ENDPOINT: the request and response schemas sit in the Cognism developer
// portal, which needs an API entitlement. Implemented from the help-centre description:
//   POST https://app.cognism.com/api/search/contact/enrich   preview + redeemId, no credits
//   POST https://app.cognism.com/api/search/contact/redeem   full record, spends 1 credit
//   POST https://app.cognism.com/api/search/account/enrich, /account/redeem   the same for companies
// Auth: Authorization: Bearer <COGNISM_API_KEY>. Direct, office and mobile numbers (Cognism's
// "Diamond" phone data) are all kept, labelled by type; so is any address returned.
import { call } from "./util.mjs";
import { makePerson, makeCompany, makeSource, splitName } from "./schema.mjs";

const BASE = "https://app.cognism.com/api/search";
const headers = (ctx) => ({ authorization: `Bearer ${ctx.env.COGNISM_API_KEY}` });
const firstResult = (r) => r?.results?.[0] || r?.data?.[0] || null;

export function normalisePerson(c, fetchedAt) {
  if (!c) return null;
  return makePerson(
    {
      names: [c.fullName, [c.firstName, c.lastName].filter(Boolean).join(" ")],
      titles: [
        ...(c.jobTitle ? [{ title: c.jobTitle, company: c.account?.name || c.companyName, from: c.startDate, current: true }] : []),
        ...(c.experience || []).map((e) => ({ title: e.jobTitle || e.title, company: e.companyName || e.account?.name, from: e.startDate, to: e.endDate })),
      ],
      education: (c.education || []).map((e) => ({ school: e.school || e.institution, degree: e.degree, from: e.startDate, to: e.endDate })),
      city: c.city || c.location?.city,
      socials: [c.linkedinUrl, c.twitterUrl].filter(Boolean),
      emails: [...(c.email ? [{ email: c.email?.address || c.email, type: "work" }] : []), ...(c.emails || []).map((e) => ({ email: e.address || e.email, type: e.type }))],
      phones: [
        ...(c.directPhoneNumbers || c.direct || []).map((n) => ({ number: n.number || n, type: "direct" })),
        ...(c.officePhoneNumbers || []).map((n) => ({ number: n.number || n, type: "office" })),
        ...(c.mobilePhoneNumbers || []).map((n) => ({ number: n.number || n, type: "mobile" })),
      ],
      addresses: [...(c.homeAddress ? [{ value: c.homeAddress, type: "home" }] : []), ...(c.address ? [c.address] : [])],
      seniority: c.seniority,
      departments: [c.department, ...(c.departments || [])].filter(Boolean),
    },
    makeSource("cognism", c.id || c.redeemId, fetchedAt),
  );
}

export function normaliseCompany(a, fetchedAt) {
  if (!a) return null;
  return makeCompany(
    {
      legalName: a.name,
      domains: [a.domain, a.website],
      industry: a.industry,
      headcount: a.size || a.employees,
      revenue: a.revenue,
      techStack: a.technologies || [],
      funding: (a.fundingRounds || []).map((f) => ({ round: f.type, date: f.date, amount: f.amount, investors: f.investors })),
      addresses: a.address ? [{ value: a.address, role: "principal office" }] : [],
    },
    makeSource("cognism", a.id || a.redeemId, fetchedAt),
  );
}

async function enrichThenRedeem(ctx, kind, body) {
  const pre = firstResult(await call(ctx, "cognism", `${BASE}/${kind}/enrich`, { method: "POST", headers: headers(ctx), body }));
  if (!pre?.redeemId) return null;
  const full = firstResult(await call(ctx, "cognism", `${BASE}/${kind}/redeem`, { method: "POST", headers: headers(ctx), body: { redeemIds: [pre.redeemId] } }));
  if (full) ctx.spend(1);
  return full;
}

export default {
  id: "cognism",
  name: "Cognism",
  kind: "api",
  envKeys: ["COGNISM_API_KEY"],
  fields: ["person.names", "person.titles", "person.education", "person.locationCity", "person.socials", "person.contacts", "person.seniority", "person.departments", "company.legalName", "company.domains", "company.industry", "company.headcount", "company.revenue", "company.funding", "company.techStack", "company.addresses"],
  docsUrl: "https://help.cognism.com/hc/en-gb/articles/34673553578514",
  status: "unverified endpoint",
  estimateCredits(intake) {
    const n = (intake.people || []).length;
    return { credits: n + 1, calls: 2 * (n + 1), note: "enrich previews are free; 1 per redeemed contact or account (est.)" };
  },
  async fetchPerson(person, company, ctx) {
    const { first, last } = splitName(person.name);
    const c = await enrichThenRedeem(ctx, "contact", { firstName: first, lastName: last, companyName: company.name, ...(company.domain || ctx.hints.domain ? { companyDomain: company.domain || ctx.hints.domain } : {}), ...(person.linkedin ? { linkedinUrl: person.linkedin } : {}) });
    return normalisePerson(c, ctx.fetchedAt);
  },
  async fetchCompany(company, ctx) {
    const a = await enrichThenRedeem(ctx, "account", { name: company.name, ...(company.domain || ctx.hints.domain ? { domain: company.domain || ctx.hints.domain } : {}) });
    return normaliseCompany(a, ctx.fetchedAt);
  },
};
