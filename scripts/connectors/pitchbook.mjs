// PitchBook API v2. UNVERIFIED ENDPOINT: the endpoint reference is visible only to contracted
// clients. Public material confirms the base URL https://api.pitchbook.com, the header
// "Authorization: PB-Token <key>", PitchBook ids like 51261-67, and HTTP 402 when credits run out.
// Paths below follow the v2 naming (search -> id -> bio / deals) and must be checked against the
// customer's Endpoints Overview before first use.
import { call } from "./util.mjs";
import { makePerson, makeCompany, makeSource } from "./schema.mjs";

const BASE = "https://api.pitchbook.com";
const headers = (ctx) => ({ authorization: `PB-Token ${ctx.env.PITCHBOOK_API_KEY}` });
const firstId = (r, key) => (r?.items || r?.results || r?.data || [])[0]?.[key] || null;

export function normaliseCompany(bio, deals, fetchedAt) {
  if (!bio) return null;
  return makeCompany(
    {
      legalName: bio.companyLegalName || bio.companyName,
      domains: [bio.website],
      industry: bio.primaryIndustryCode?.description || bio.primaryIndustry,
      headcount: bio.employees ?? bio.employeeCount,
      revenue: bio.revenue?.amount ?? bio.revenue,
      funding: (deals?.items || deals || []).map((d) => ({ round: d.dealType?.description || d.dealType, date: d.dealDate, amount: d.dealSize?.amount ?? d.dealSize, investors: (d.investors || []).map((i) => i.investorName || i.name || i) })),
      parent: bio.parentCompany?.name || bio.parentCompanyName,
      subsidiaries: (bio.subsidiaries || []).map((x) => x.name || x),
      addresses: [bio.hqLocation || bio.headquarters].filter(Boolean).map((a) => ({ ...(typeof a === "object" ? a : { value: a }), role: "principal office" })),
    },
    makeSource("pitchbook", bio.companyId || bio.pbId, fetchedAt),
  );
}

export function normalisePerson(bio, fetchedAt) {
  if (!bio) return null;
  return makePerson(
    {
      names: [bio.fullName, [bio.firstName, bio.lastName].filter(Boolean).join(" ")],
      titles: (bio.positions || []).map((p) => ({ title: p.title, company: p.entityName || p.companyName, from: p.startDate, to: p.endDate, current: p.isCurrent })),
      education: (bio.education || []).map((e) => ({ school: e.institution || e.school, degree: e.degree, to: e.graduationYear })),
      city: bio.primaryOffice?.city || bio.city,
      socials: [bio.linkedInUrl].filter(Boolean),
      // Every email and phone PitchBook returns is kept, labelled by its type.
      emails: bio.email ? [{ email: bio.email, type: "work" }] : [],
      phones: [...(bio.officePhone ? [{ number: bio.officePhone, type: "office" }] : []), ...(bio.homePhone ? [{ number: bio.homePhone, type: "home" }] : []), ...(bio.mobilePhone ? [{ number: bio.mobilePhone, type: "mobile" }] : [])],
      addresses: bio.primaryOffice?.address ? [{ value: bio.primaryOffice.address, type: "work" }] : [],
    },
    makeSource("pitchbook", bio.personId || bio.pbId, fetchedAt),
  );
}

export default {
  id: "pitchbook",
  name: "PitchBook",
  kind: "api",
  envKeys: ["PITCHBOOK_API_KEY"],
  fields: ["person.names", "person.titles", "person.education", "person.locationCity", "person.socials", "person.contacts", "company.legalName", "company.domains", "company.industry", "company.headcount", "company.revenue", "company.funding", "company.parent", "company.subsidiaries", "company.addresses"],
  docsUrl: "https://pitchbook.com/help/pitchbook-api",
  status: "unverified endpoint",
  estimateCredits(intake) {
    const n = (intake.people || []).length;
    return { credits: 2 * n + 3, calls: 2 * n + 3, note: "credit-metered per call on most contracts (est.: 1 per search, bio and deals call)" };
  },
  async fetchPerson(person, company, ctx) {
    const id = firstId(await call(ctx, "pitchbook", `${BASE}/people/search`, { headers: headers(ctx), query: { keywords: `${person.name} ${company.name}` } }), "personId");
    ctx.spend(1);
    if (!id) return null;
    const bio = await call(ctx, "pitchbook", `${BASE}/people/${encodeURIComponent(id)}/bio`, { headers: headers(ctx) });
    ctx.spend(1);
    return normalisePerson(bio, ctx.fetchedAt);
  },
  async fetchCompany(company, ctx) {
    const id = firstId(await call(ctx, "pitchbook", `${BASE}/companies/search`, { headers: headers(ctx), query: { keywords: company.name } }), "companyId");
    ctx.spend(1);
    if (!id) return null;
    const bio = await call(ctx, "pitchbook", `${BASE}/companies/${encodeURIComponent(id)}/bio`, { headers: headers(ctx) });
    const deals = await call(ctx, "pitchbook", `${BASE}/companies/${encodeURIComponent(id)}/deals`, { headers: headers(ctx) });
    ctx.spend(2);
    return normaliseCompany(bio, deals, ctx.fetchedAt);
  },
};
