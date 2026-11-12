// Clay. UNVERIFIED ENDPOINT: Clay has no public person or company lookup API (an Enterprise-only
// one exists, undocumented in public). What is documented is that every Clay table has an inbound
// webhook URL that takes JSON rows. So this adapter works in two steps:
//   1. push: POST one row per person (and one for the company) to CLAY_WEBHOOK_URL; the table's own
//      enrichment columns run in Clay and spend Clay credits there. Optional header
//      x-clay-webhook-auth: CLAY_WEBHOOK_TOKEN (if the table has webhook auth on; header name unverified).
//   2. read: export the table to rooms/<slug>/work/imports/clay.csv and run enrich again; the export
//      is read with the same header aliases as the csv import. Rows are pushed only while clay.csv is
//      missing, so a second run never pays twice.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { csvRecords, recordsFromRows, readText } from "./util.mjs";

const exportFile = (ctx) => join(ctx.importsDir, "clay.csv");

async function push(ctx, row) {
  const res = await ctx.fetch(ctx.env.CLAY_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...(ctx.env.CLAY_WEBHOOK_TOKEN ? { "x-clay-webhook-auth": ctx.env.CLAY_WEBHOOK_TOKEN } : {}) },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`clay webhook: HTTP ${res.status}`);
}

function fromExport(ctx, person, company) {
  const rows = csvRecords(readText(exportFile(ctx)));
  return recordsFromRows(rows, "clay", { person, company, fetchedAt: ctx.fetchedAt, file: "work/imports/clay.csv" });
}

export default {
  id: "clay",
  name: "Clay",
  kind: "api",
  envKeys: ["CLAY_WEBHOOK_URL"],
  optionalEnvKeys: ["CLAY_WEBHOOK_TOKEN"],
  fields: ["person.names", "person.titles", "person.education", "person.locationCity", "person.socials", "person.contacts", "person.seniority", "person.departments", "company.legalName", "company.domains", "company.industry", "company.headcount", "company.revenue", "company.funding", "company.techStack", "company.addresses"],
  docsUrl: "https://university.clay.com/docs/using-clay-as-an-api",
  status: "unverified endpoint",
  configured(ctx) {
    return !!ctx.env.CLAY_WEBHOOK_URL || existsSync(exportFile(ctx));
  },
  estimateCredits(intake, opts = {}, ctx) {
    const rows = (intake.people || []).length + 1;
    if (ctx && existsSync(exportFile(ctx))) return { credits: 0, calls: 0, note: "reads the table export work/imports/clay.csv; nothing is pushed" };
    const per = Number(opts.creditsPerRow ?? 1);
    return { credits: rows * per, calls: rows, note: `${rows} rows pushed to the Clay table; Clay spends about ${per} credit(s) per row (set creditsPerRow in config/connectors.json to match the table's columns)` };
  },
  async fetchPerson(person, company, ctx) {
    if (existsSync(exportFile(ctx))) return fromExport(ctx, person, null).person;
    await push(ctx, { kind: "person", name: person.name, company: company.name, domain: company.domain || ctx.hints.domain || "", linkedin: person.linkedin || "", room: ctx.slug });
    ctx.spend(Number(ctx.options.creditsPerRow ?? 1));
    ctx.note(`sent ${person.name} to the Clay table; export it to work/imports/clay.csv and run enrich again`);
    return null;
  },
  async fetchCompany(company, ctx) {
    if (existsSync(exportFile(ctx))) return fromExport(ctx, null, company).company;
    await push(ctx, { kind: "company", company: company.name, domain: company.domain || ctx.hints.domain || "", room: ctx.slug });
    ctx.spend(Number(ctx.options.creditsPerRow ?? 1));
    return null;
  },
};
