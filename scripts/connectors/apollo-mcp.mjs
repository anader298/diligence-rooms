// Apollo through the MCP server instead of a key (Claude Code: claude.ai Apollo.io connector).
//
// The pipeline agent calls the MCP tools itself (with reveal_personal_emails and reveal_phone_number
// when revealPersonal is on in config/connectors.json), after showing the credit estimate that the
// MCP returns in its mcp_credits block, and saves each raw response as JSON:
//
//   rooms/<slug>/work/connectors/raw/apollo-mcp/person-<person-slug>.json   apollo_people_match
//   rooms/<slug>/work/connectors/raw/apollo-mcp/company.json                apollo_organizations_enrich
//   rooms/<slug>/work/connectors/raw/apollo-mcp/job-postings.json           apollo_organizations_job_postings
//
// (Tool names in Claude Code look like mcp__claude_ai_Apollo_io__apollo_people_match.)
// This adapter spends nothing: it reads those files and normalises them with the Apollo
// normalisers, so the output is the same as the key route.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { normalisePerson, normaliseCompany } from "./apollo.mjs";
import apollo from "./apollo.mjs";

export const MCP_TOOLS = {
  person: "apollo_people_match",
  company: "apollo_organizations_enrich",
  jobPostings: "apollo_organizations_job_postings",
};

const dir = (ctx) => join(ctx.rawDir, "apollo-mcp");
const read = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null);

export default {
  id: "apollo-mcp",
  name: "Apollo.io (MCP)",
  kind: "mcp",
  envKeys: [],
  fields: apollo.fields,
  docsUrl: "https://mcp.apollo.io",
  status: "verified",
  mcpTools: MCP_TOOLS,
  configured(ctx) {
    return existsSync(dir(ctx)) && readdirSync(dir(ctx)).some((f) => f.endsWith(".json"));
  },
  estimateCredits(intake, opts = {}) {
    const e = apollo.estimateCredits(intake, opts);
    return { ...e, credits: 0, note: `spent by the agent through the MCP (about ${e.credits} Apollo credits; the MCP reports mcp_credits before and after). This step reads the saved responses only.` };
  },
  async fetchPerson(person, company, ctx) {
    const r = read(join(dir(ctx), `person-${person.slug}.json`));
    if (!r) return ctx.note(`no saved ${MCP_TOOLS.person} response for ${person.slug}`), null;
    const p = r.person || r;
    return p.match_confidence === "none" ? null : normalisePerson(p, ctx.fetchedAt);
  },
  async fetchCompany(company, ctx) {
    const r = read(join(dir(ctx), "company.json"));
    if (!r) return ctx.note(`no saved ${MCP_TOOLS.company} response`), null;
    const j = read(join(dir(ctx), "job-postings.json"));
    return normaliseCompany(r.organization || r, j?.organization_job_postings || (Array.isArray(j) ? j : []), ctx.fetchedAt);
  },
};
