#!/usr/bin/env node
// Add one finding to a person's ledger by hand or from a research agent, then re-render the dossier.
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
const row = ledger.add(values.module, { var: values.var, value: values.value, url: values.url, grade: values.grade, tier: values.tier, date: values.date });
console.log(row.id);

// Keep osint.json and the dossier in step with the ledger.
const file = join(dir, "osint.json");
if (existsSync(file)) {
  const result = JSON.parse(readFileSync(file, "utf8"));
  result.rows = ledger.rows;
  writeFileSync(file, JSON.stringify(result, null, 1));
  writeFileSync(join(dir, "dossier.html"), renderDossier(result));
}
