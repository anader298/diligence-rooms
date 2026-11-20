#!/usr/bin/env node
// Public-source research on one person and their company, in about a minute, with no paid keys.
//
//   npm run osint -- --name "Jane Doe" --company "Acme Corp" [--domain acme.com] [--title "VP Ops"]
//                    [--city Austin --state TX] [--handles janedoe,jdoe] [--photo <url>]
//                    [--room <slug>] [--only sec,fec] [--out <dir>] [--open]
//
// Writes <out>/ledger.jsonl (one row per finding, with its source), osint.json and dossier.html.
// With --room the output goes to rooms/<slug>/work/osint/, where the research agents read it as leads.
// Optional free keys in .env make more modules run: FEC_API_KEY, COURTLISTENER_TOKEN,
// OPENSANCTIONS_API_KEY, BRAVE_API_KEY, GITHUB_TOKEN, SEC_USER_AGENT. See docs/osint.md.
import { parseArgs } from "node:util";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { runOsint, REPO } from "./osint/run.mjs";
import { renderDossier } from "./osint/dossier.mjs";

const usage = 'usage: npm run osint -- --name "Full Name" --company "Company" [--domain d] [--title t] [--city c --state ST] [--handles a,b] [--photo url] [--room slug] [--only m1,m2] [--out dir] [--open]';
let values;
try {
  ({ values } = parseArgs({
    options: {
      name: { type: "string" },
      company: { type: "string" },
      domain: { type: "string" },
      title: { type: "string" },
      city: { type: "string" },
      state: { type: "string" },
      handles: { type: "string" },
      aliases: { type: "string" },
      photo: { type: "string" },
      ticker: { type: "string" },
      room: { type: "string" },
      only: { type: "string" },
      out: { type: "string" },
      open: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  }));
} catch (e) {
  console.error(e.message + "\n" + usage);
  process.exit(1);
}
if (values.help || !values.name) {
  console.log(usage);
  process.exit(values.help ? 0 : 1);
}
const list = (s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);
const subject = {
  name: values.name.trim(),
  company: values.company?.trim() || null,
  domain: values.domain?.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "") || null,
  title: values.title || null,
  city: values.city || null,
  state: values.state || null,
  handles: list(values.handles),
  aliases: list(values.aliases),
  photo: values.photo || null,
  ticker: values.ticker || null,
};
const slugOf = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const outDir = values.out || (values.room ? join(REPO, "rooms", values.room, "work", "osint") : join(REPO, "work", "osint", slugOf(subject.name)));

console.log(`OSINT: ${subject.name}${subject.company ? " · " + subject.company : ""} → ${outDir}`);
const result = await runOsint(subject, { outDir, only: values.only ? list(values.only) : null });
const file = join(outDir, "dossier.html");
writeFileSync(file, renderDossier(result));
const found = new Set(result.rows.map((r) => r.var)).size;
console.log(`\n${result.rows.length} findings across ${found} variables in ${result.seconds}s · ${result.http.calls} calls, ${result.http.blocked} blocked`);
console.log(`dossier: ${file}`);
if (values.open) execFile("open", [file]);
