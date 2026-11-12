// Apollo.io. Endpoints checked against docs.apollo.io on 2026-11-12:
//   POST /api/v1/people/match                         People Enrichment (1 credit when data is found;
//                                                     personal emails and phones cost extra when revealed)
//   GET  /api/v1/organizations/enrich?domain=         Organization Enrichment (1 credit)
//   GET  /api/v1/organizations/{id}/job_postings      Organization Job Postings (1 credit per page)
// Auth: header x-api-key. With revealPersonal (config, default true) reveal_personal_emails is sent
// as true; reveal_phone_number too when providers.apollo.webhookUrl is set (Apollo delivers phone
// numbers to that webhook). Every email, phone and address returned is kept and labelled.
//
// The same data is available to a Claude Code agent through the Apollo MCP server, with no key
// in this repo: see apollo-mcp.mjs.
import { call } from "./util.mjs";
import { makePerson, makeCompany, makeSource, splitName } from "./schema.mjs";

const BASE = "https://api.apollo.io/api/v1";
const headers = (ctx) => ({ "x-api-key": ctx.env.APOLLO_API_KEY, "cache-control": "no-cache" });
const reveal = (ctx) => {
  const on = ctx.revealPersonal !== false;
  const hook = on && ctx.options?.webhookUrl;
  return { reveal_personal_emails: on, reveal_phone_number: !!hook, ...(hook ? { webhook_url: hook } : {}) };
};

export function normalisePerson(p, fetchedAt) {
  if (!p) return null;
  const history = (p.employment_history || []).map((e) => ({ title: e.title, company: e.organization_name, from: e.start_date, to: e.current ? null : e.end_date, current: !!e.current }));
  return makePerson(
    {
      names: [p.name, [p.first_name, p.last_name].filter(Boolean).join(" ")],
      titles: history.length ? history : [{ title: p.title, company: p.organization?.name, current: true }],
      city: p.city,
      socials: [p.linkedin_url, p.twitter_url, p.github_url, p.facebook_url].filter(Boolean),
      // `email` is the work address Apollo matched; personal_emails are kept, labelled personal.
      emails: p.email && p.email_status !== "unavailable" ? [{ email: p.email, type: "work" }] : [],
      personalEmails: p.personal_emails || [],
      // Every line is kept with its type: work_direct, work_hq, mobile, home, other.
      phones: (p.contact?.phone_numbers || p.phone_numbers || []).map((n) => ({ number: n.sanitized_number || n.raw_number, type: n.type_cd || n.type })),
      addresses: p.street_address ? [[p.street_address, p.city, [p.state, p.postal_code].filter(Boolean).join(" "), p.country].filter(Boolean).join(", ")] : [],
      seniority: p.seniority,
      departments: [...(p.departments || []), ...(p.subdepartments || [])],
    },
    makeSource("apollo", p.id, fetchedAt),
  );
}

export function normaliseCompany(o, jobs, fetchedAt) {
  if (!o) return null;
  return makeCompany(
    {
      legalName: o.name,
      domains: [o.primary_domain, o.website_url].filter(Boolean),
      industry: o.industry,
      headcount: o.estimated_num_employees,
      revenue: o.annual_revenue ?? o.annual_revenue_printed,
      funding: (o.funding_events || []).map((f) => ({ round: f.type, date: f.date, amount: f.amount, investors: typeof f.investors === "string" ? f.investors.split(",") : f.investors })),
      techStack: o.technology_names?.length ? o.technology_names : (o.current_technologies || []).map((t) => t.name),
      jobPostings: (jobs || []).map((j) => ({ title: j.title, date: j.posted_at || j.last_seen_at, url: j.url })),
      parent: o.owned_by_organization?.name,
      subsidiaries: (o.suborganizations || []).map((x) => x.name),
      addresses: o.raw_address ? [{ value: o.raw_address, role: "principal office" }] : [],
    },
    makeSource("apollo", o.id, fetchedAt),
  );
}

export default {
  id: "apollo",
  name: "Apollo.io",
  kind: "api",
  envKeys: ["APOLLO_API_KEY"],
  fields: ["person.names", "person.titles", "person.locationCity", "person.socials", "person.contacts", "person.seniority", "person.departments", "company.legalName", "company.domains", "company.industry", "company.headcount", "company.revenue", "company.funding", "company.techStack", "company.jobPostings", "company.parent", "company.subsidiaries", "company.addresses"],
  docsUrl: "https://docs.apollo.io/reference/people-enrichment",
  status: "verified",
  mcp: "Apollo is also an MCP server in Claude Code (apollo_people_match, apollo_organizations_enrich, apollo_organizations_job_postings). Use the apollo-mcp route to normalise saved MCP responses with no key here.",
  estimateCredits(intake, opts = {}) {
    const people = (intake.people || []).length;
    const reveal = opts.revealPersonal !== false;
    const phones = reveal && !!opts.webhookUrl;
    const extra = people * ((reveal ? 1 : 0) + (phones ? 8 : 0));
    const what = reveal ? ` + personal email reveal (1 each, est.)${phones ? " + phone reveal (8 each)" : "; phones not revealed (no webhookUrl)"}` : "; personal reveals off";
    return { credits: people + 2 + extra, calls: people + 2, note: `${people} people match (1 each when found)${what} + organization enrich (1) + job postings (1 per page)` };
  },
  async fetchPerson(person, company, ctx) {
    const { first, last } = splitName(person.name);
    const r = await call(ctx, "apollo", `${BASE}/people/match`, {
      method: "POST",
      headers: headers(ctx),
      query: { first_name: first, last_name: last, name: person.name, organization_name: company.name, domain: company.domain || ctx.hints.domain, linkedin_url: person.linkedin, ...reveal(ctx) },
    });
    if (!r?.person || r.person.match_confidence === "none") return null;
    ctx.spend(1 + (ctx.revealPersonal !== false && r.person.personal_emails?.length ? 1 : 0));
    if (!ctx.hints.domain && r.person.organization?.primary_domain) ctx.hints.domain = r.person.organization.primary_domain;
    if (r.person.organization_id) ctx.hints.apolloOrgId ||= r.person.organization_id;
    return normalisePerson(r.person, ctx.fetchedAt);
  },
  async fetchCompany(company, ctx) {
    const d = company.domain || ctx.hints.domain;
    if (!d) {
      ctx.note("organization enrich needs a domain (Apollo does not take a name alone); pass --domain or add domain to intake.json");
      return null;
    }
    const r = await call(ctx, "apollo", `${BASE}/organizations/enrich`, { headers: headers(ctx), query: { domain: d } });
    if (!r?.organization) return null;
    ctx.spend(1);
    let jobs = [];
    const id = r.organization.id || ctx.hints.apolloOrgId;
    if (id) {
      const j = await call(ctx, "apollo", `${BASE}/organizations/${encodeURIComponent(id)}/job_postings`, { headers: headers(ctx), query: { page: 1, per_page: 100 } });
      ctx.spend(1);
      jobs = j?.organization_job_postings || [];
    }
    return normaliseCompany(r.organization, jobs, ctx.fetchedAt);
  },
};
