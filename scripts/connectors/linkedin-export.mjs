// LinkedIn content from the user's own account, never from scraping LinkedIn.
//
// Put the files in rooms/<slug>/work/imports/linkedin/:
//   Connections.csv   from LinkedIn's "Get a copy of your data" export (Settings > Data privacy).
//                     If a person across the table is a 1st-degree connection, this gives their
//                     current title, company and profile URL, and the date you connected.
//   *.csv             a Sales Navigator lead list export, or any CSV with one row per position
//                     (name, title, company, start, end) or degree (name, school, degree, start, end)
//                     copied from a profile you viewed under your own account.
// Email addresses in Connections.csv were shared with you as a connection and are kept as contacts
// (labelled by their domain: webmail is personal); so are phone and address columns, by header.
import { join } from "node:path";
import { csvFiles, csvRecords, recordsFromRows, readText } from "./util.mjs";
import { makePerson, makeSource } from "./schema.mjs";

const dir = (ctx) => join(ctx.importsDir, "linkedin");

function load(ctx) {
  return csvFiles(dir(ctx)).map((f) => ({ file: f, rows: csvRecords(readText(f)) }));
}

/** Several files may describe one person (Connections.csv plus a positions file): fold them. */
function fold(parts, fetchedAt) {
  const ps = parts.filter(Boolean);
  if (!ps.length) return null;
  return makePerson(
    {
      names: ps.flatMap((p) => p.names),
      titles: ps.flatMap((p) => p.titles),
      education: ps.flatMap((p) => p.education),
      city: ps.map((p) => p.locationCity).find(Boolean),
      socials: ps.flatMap((p) => p.socials),
      contacts: ps.flatMap((p) => p.contacts),
      seniority: ps.map((p) => p.seniority).find(Boolean),
      departments: ps.flatMap((p) => p.departments),
    },
    makeSource("linkedin-export", ps.map((p) => p.source.recordId).join(" + "), fetchedAt, ps.map((p) => p.source.note).find(Boolean)),
  );
}

export default {
  id: "linkedin-export",
  name: "LinkedIn export (your own data or Sales Navigator CSV)",
  kind: "file",
  envKeys: [],
  fields: ["person.names", "person.titles", "person.education", "person.locationCity", "person.socials", "person.contacts", "person.seniority", "person.departments"],
  docsUrl: "https://www.linkedin.com/help/linkedin/answer/a1339364",
  status: "local file",
  configured(ctx) {
    return csvFiles(dir(ctx)).length > 0;
  },
  estimateCredits() {
    return { credits: 0, calls: 0, note: "local files in work/imports/linkedin/" };
  },
  async fetchPerson(person, company, ctx) {
    return fold(
      load(ctx).map(({ file, rows }) => recordsFromRows(rows, "linkedin-export", { person, company: null, fetchedAt: ctx.fetchedAt, file: "work/imports/linkedin/" + file.split("/").pop() }).person),
      ctx.fetchedAt,
    );
  },
  async fetchCompany() {
    return null;
  },
};
