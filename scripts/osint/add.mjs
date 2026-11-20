#!/usr/bin/env node
// Add one finding to a person's ledger by variable, then re-render the dossier. Research agents
// in a room use npm run entry (by bucket) instead; both go through the same grading.
//
// The grade is a claim, not a verdict: --grade v is kept only when a second, independent source
// in the ledger agrees (the two-source rule in weights.mjs); otherwise the row is shown as Partly
// verified, as script rows are. A row added here is marked origin "agent" by code, so it never
// counts as a primary record: --module only labels the row ("sec" with a sec.gov URL is still an
// agent's claim, not the SEC's record).
//
//   node scripts/osint/add.mjs <osint dir> --var hobby.sports --value "Coaches 10U baseball" \
//        --url https://... --grade p [--tier C] [--date 2026-05-01] [--module agent]
//
// <osint dir> is rooms/<slug>/work/osint/<person-slug>. Prints the new ledger id (L-0123).
import { parseArgs } from "node:util";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeLedger } from "./core.mjs";
import { loadVariables } from "./run.mjs";
import { renderDossier } from "./dossier.mjs";
import { regrade } from "../lib/entries.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    var: { type: "string" },
    value: { type: "string" },
    url: { type: "string" },
    grade: { type: "string", default: "w" },
    tier: { type: "string", default: "C" },
    date: { type: "string" },
    module: { type: "string", default: "agent" },
  },
});
const dir = positionals[0];
if (!dir || !values.var || !values.value) {
  console.error("usage: node scripts/osint/add.mjs <osint dir> --var <id> --value <text> [--url u] [--grade v|p|w|i] [--tier A|B|C|D] [--date YYYY-MM-DD]");
  process.exit(1);
}
const schema = loadVariables();
if (!schema.variables.some((v) => v.id === values.var)) {
  console.error(`unknown variable "${values.var}"; see config/osint-variables.json`);
  process.exit(1);
}
const ledger = makeLedger(dir, schema.variables);
const claim = ["v", "p", "w", "i", "n", "np", "u"].includes(values.grade) ? values.grade : "w";
const row = ledger.add(values.module, { var: values.var, value: values.value, url: values.url, grade: claim, claim, tier: values.tier, date: values.date, origin: "agent" });
const file = join(dir, "osint.json");
let result = null;
try {
  result = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
} catch {
  result = null;
}
regrade(ledger, { subject: result?.subject || {} });
const graded = ledger.rows.find((r) => r.id === row.id);
console.log(`${row.id}${graded.grade !== claim ? `  grade ${graded.grade} (${graded.grade_basis})` : ""}`);

// Keep osint.json and the dossier in step with the ledger.
if (result) {
  result.rows = ledger.rows;
  writeFileSync(file, JSON.stringify(result, null, 1));
  writeFileSync(join(dir, "dossier.html"), renderDossier(result));
}
