#!/usr/bin/env node
// Hand in one entry for a bucket of a room's form (what research agents use instead of
// writing fact rows on pages). Code grades it: an agent cannot write a Verified row.
//
//   npm run entry -- <slug> --bucket seat.title --person jane-doe \
//        --value "Chief Operating Officer since March 2024" --url https://... [--note "..."] [--weak] [--date YYYY-MM-DD]
//   npm run entry -- <slug> --bucket life.weekends --person jane-doe --none "DDG: \"Jane Doe\" weekend sailing; club rosters"
//   npm run entry -- <slug> --bucket persona.verdict --person jane-doe --value "Mixed: ..." --cites L-0004,L-0012
//   npm run entry -- <slug> --bucket start.summary --value "..." --cites jane-doe/L-0004,_company/L-0002
//   npm run entry -- <slug> --list [--person jane-doe]     the buckets this room has, with their state
//
// --weak: identity not confirmed, or one unconfirmed source (kept at Weak).
// --none "<what was searched>": searched, nothing found (the bucket shows as searched and empty).
// --cites: for AI judgement slots, the ledger ids the text rests on (bare L-0001 = this bucket's
// ledger: the person's, or _company for company buckets). Every id must exist.
// Prints the ledger id and the grade the code gave it.
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO, SLUG_RE } from "./lib/compose.mjs";
import { submitEntry } from "./lib/entries.mjs";
import { roomForm, STATE_LABEL } from "./lib/form.mjs";
import { moduleVars } from "./osint/run.mjs";

let values, positionals;
try {
  ({ values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      bucket: { type: "string" }, person: { type: "string" }, value: { type: "string" }, url: { type: "string" },
      note: { type: "string" }, none: { type: "string" }, weak: { type: "boolean", default: false }, cites: { type: "string" },
      date: { type: "string" }, grade: { type: "string" }, list: { type: "boolean", default: false },
    },
  }));
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
const slug = positionals[0];
if (!SLUG_RE.test(slug || "") || !existsSync(join(REPO, "rooms", slug || "", "room.json"))) {
  console.error("usage: npm run entry -- <slug> --bucket <id> [--person <slug>] --value <text> --url <https://...> [--note t] [--weak] | --none <what was searched> | --cites L-0001,...   (or --list)");
  process.exit(2);
}
const roomDir = join(REPO, "rooms", slug);
if (values.list) {
  const form = roomForm(roomDir, { moduleVars: await moduleVars(), force: true });
  for (const b of form.buckets.filter((b) => !values.person || b.person === values.person))
    console.log(`${(b.person ? b.person + " " : "") + b.id}`.padEnd(44), b.kind.padEnd(5), STATE_LABEL[b.state].padEnd(24), b.label);
  process.exit(0);
}
if (!values.bucket) {
  console.error("--bucket is required (npm run entry -- <slug> --list shows them)");
  process.exit(2);
}
try {
  const r = submitEntry(roomDir, { ...values, none: values.none ?? null });
  for (const w of r.warnings) console.warn(`note: ${w}`);
  console.log(`${r.ledger}/${r.row.id}  ${r.bucket.id}  grade ${r.row.grade}${r.row.grade_basis ? ` (${r.row.grade_basis})` : ""}`);
} catch (e) {
  console.error(`entry refused: ${e.message}`);
  process.exit(1);
}
