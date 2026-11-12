// Generic CSV import: any export you are licensed to use (a CRM, a data room, a provider's
// download). Files: rooms/<slug>/work/imports/*.csv (clay.csv is left to the Clay adapter).
//
// One row per person-position or person-degree, or one row per company (no name column, or
// kind=company). Headers are matched by alias (see util.mjs): name or first/last name, title,
// company, start, end, school, degree, city, linkedin, work email, work phone, seniority,
// department, personal email, mobile, home phone, address, home address; legal name, domain,
// industry, headcount, revenue, funding round, funding date, funding amount, investors,
// technologies, parent, company address, registered address. Every email, phone and address
// column is kept as a labelled contact (work, personal or unknown).
import { basename } from "node:path";
import { csvFiles, csvRecords, recordsFromRows, readText } from "./util.mjs";

const files = (ctx) => csvFiles(ctx.importsDir).filter((f) => basename(f).toLowerCase() !== "clay.csv");

function first(ctx, pick, person, company) {
  for (const f of files(ctx)) {
    const r = recordsFromRows(csvRecords(readText(f)), "csv", { person, company, fetchedAt: ctx.fetchedAt, file: "work/imports/" + basename(f) })[pick];
    if (r) return r;
  }
  return null;
}

export default {
  id: "csv",
  name: "CSV import",
  kind: "file",
  envKeys: [],
  fields: ["person.names", "person.titles", "person.education", "person.locationCity", "person.socials", "person.contacts", "person.seniority", "person.departments", "company.legalName", "company.domains", "company.industry", "company.headcount", "company.revenue", "company.funding", "company.techStack", "company.parent", "company.addresses"],
  docsUrl: "scripts/connectors/util.mjs",
  status: "local file",
  configured(ctx) {
    return files(ctx).length > 0;
  },
  estimateCredits() {
    return { credits: 0, calls: 0, note: "local files in work/imports/" };
  },
  async fetchPerson(person, company, ctx) {
    return first(ctx, "person", person, null);
  },
  async fetchCompany(company, ctx) {
    return first(ctx, "company", null, company);
  },
};
