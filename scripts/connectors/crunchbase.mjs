// Crunchbase API v4. Checked against data.crunchbase.com on 2026-11-12:
//   base https://api.crunchbase.com/v4/data/, auth header X-cb-user-key
//   GET entities/organizations/{permalink}?field_ids=...&card_ids=...   (verified path)
// Partly unverified: the autocompletes call used to find the permalink, the people entity path,
// and the card ids (raised_funding_rounds, parent_organization, sub_organizations, jobs, degrees)
// follow the v4 reference but were not readable in the public pages.
// Billing is a subscription with rate limits, not per-call credits.
import { call } from "./util.mjs";
import { makePerson, makeCompany, makeSource } from "./schema.mjs";

const BASE = "https://api.crunchbase.com/v4/data";
const headers = (ctx) => ({ "X-cb-user-key": ctx.env.CRUNCHBASE_API_KEY });
const val = (x) => (x && typeof x === "object" ? x.value ?? x.name ?? x.permalink : x);

const EMPLOYEES = /^c_0*(\d+)_0*(\d+|max)$/;
function employees(e) {
  const m = String(e || "").match(EMPLOYEES);
  return m ? (m[2] === "max" ? `${m[1]}+` : `${m[1]}-${m[2]}`) : null;
}

async function permalink(ctx, query, collection) {
  const r = await call(ctx, "crunchbase", `${BASE}/autocompletes`, { headers: headers(ctx), query: { query, collection_ids: collection, limit: 1 } });
  return r?.entities?.[0]?.identifier?.permalink || null;
}

export function normaliseCompany(r, fetchedAt) {
  const p = r?.properties;
  if (!p) return null;
  const cards = r.cards || {};
  return makeCompany(
    {
      legalName: p.legal_name || val(p.identifier),
      domains: [p.website_url || val(p.website)],
      industry: (p.categories || []).map(val).filter(Boolean).join(", ") || null,
      headcount: employees(p.num_employees_enum),
      revenue: p.revenue_range ? String(p.revenue_range).replace(/^r_/, "") : null,
      funding: (cards.raised_funding_rounds || []).map((f) => ({
        round: f.investment_type || val(f.identifier),
        date: f.announced_on,
        amount: f.money_raised?.value_usd ?? f.money_raised?.value,
        investors: (f.lead_investor_identifiers || f.investor_identifiers || []).map(val),
      })),
      parent: val((cards.parent_organization || [])[0]?.identifier),
      subsidiaries: (cards.sub_organizations || []).map((x) => val(x.identifier || x.subsidiary_identifier)),
    },
    makeSource("crunchbase", p.identifier?.permalink || p.identifier?.uuid, fetchedAt),
  );
}

export function normalisePerson(r, fetchedAt) {
  const p = r?.properties;
  if (!p) return null;
  const cards = r.cards || {};
  const jobs = (cards.jobs || []).map((j) => ({ title: j.title, company: val(j.organization_identifier), from: j.started_on?.value || j.started_on, to: j.is_current ? null : j.ended_on?.value || j.ended_on }));
  return makePerson(
    {
      names: [val(p.identifier), [p.first_name, p.last_name].filter(Boolean).join(" ")],
      titles: jobs.length ? jobs : [{ title: p.primary_job_title, company: val(p.primary_organization), current: true }],
      education: (cards.degrees || []).map((d) => ({ school: val(d.school_identifier), degree: [d.type_name, d.subject].filter(Boolean).join(", "), from: d.started_on?.value || d.started_on, to: d.completed_on?.value || d.completed_on })),
      city: val((p.location_identifiers || []).find((l) => l.location_type === "city")),
      socials: [val(p.linkedin), val(p.twitter), val(p.facebook)].filter(Boolean),
    },
    makeSource("crunchbase", p.identifier?.permalink || p.identifier?.uuid, fetchedAt),
  );
}

export default {
  id: "crunchbase",
  name: "Crunchbase",
  kind: "api",
  envKeys: ["CRUNCHBASE_API_KEY"],
  fields: ["person.names", "person.titles", "person.education", "person.locationCity", "person.socials", "company.legalName", "company.domains", "company.industry", "company.headcount", "company.revenue", "company.funding", "company.parent", "company.subsidiaries"],
  docsUrl: "https://data.crunchbase.com/docs/using-the-api",
  status: "verified (organization lookup); unverified endpoint (autocomplete, people, card ids)",
  estimateCredits(intake) {
    const n = (intake.people || []).length;
    return { credits: 0, calls: 2 * (n + 1), note: "subscription, no per-call credits; counts against the plan's rate limit" };
  },
  async fetchPerson(person, company, ctx) {
    const id = await permalink(ctx, person.name, "people");
    if (!id) return null;
    const r = await call(ctx, "crunchbase", `${BASE}/entities/people/${encodeURIComponent(id)}`, {
      headers: headers(ctx),
      query: { field_ids: "identifier,first_name,last_name,primary_job_title,primary_organization,location_identifiers,linkedin,twitter,facebook", card_ids: "jobs,degrees" },
    });
    return normalisePerson(r, ctx.fetchedAt);
  },
  async fetchCompany(company, ctx) {
    const id = await permalink(ctx, company.name, "organizations");
    if (!id) return null;
    const r = await call(ctx, "crunchbase", `${BASE}/entities/organizations/${encodeURIComponent(id)}`, {
      headers: headers(ctx),
      query: { field_ids: "identifier,legal_name,website_url,categories,num_employees_enum,revenue_range,funding_total", card_ids: "raised_funding_rounds,parent_organization,sub_organizations" },
    });
    return normaliseCompany(r, ctx.fetchedAt);
  },
};
