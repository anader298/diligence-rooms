#!/usr/bin/env node
// Compose a new room from the skeleton.
//
//   npm run new-room -- --company "Acme Capital" --person "Jane Doe" [--person "John Roe"]
//                       --goal "negotiate a licence" [--mode deal] [--mode audit]
//                       [--org private-equity] [--date 2026-12-01] [--tier light] [--slug acme]
//                       [--meeting "2026-12-08 14:00|Round 2|Jane Doe, John Roe|video|60 min"]...
//                       [--deadline "2026-12-03|Send the case deck|submission"]...
//
// --mode can repeat; when it is missing the modes are read from the goal text.
// --person can repeat or hold several names separated by commas.
// Writes rooms/<slug>/room.json, pages/, intake.json, and RUN.sh with the
// pipeline command (it does not run it). Refuses to overwrite a room.
//
// The older form still works:  npm run new-room -- <slug> "<Display name>"
import { parseArgs } from "node:util";
import { composeRoom, writeRunScript, MODES, ORG_TYPES } from "./lib/compose.mjs";

const usage = `usage: npm run new-room -- --company "Acme Capital" --person "Jane Doe" --goal "negotiate a licence"
                            [--mode ${MODES.join("|")}]... [--org auto|${ORG_TYPES.join("|")}]
                            [--date YYYY-MM-DD] [--tier full|light] [--slug acme-capital]
                            [--meeting "YYYY-MM-DD HH:MM|title|who|format|length"]...
                            [--deadline "YYYY-MM-DD|title|kind"]...`;

let values, positionals;
try {
  ({ values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      company: { type: "string" },
      person: { type: "string", multiple: true },
      goal: { type: "string" },
      mode: { type: "string", multiple: true },
      org: { type: "string" },
      date: { type: "string" },
      meeting: { type: "string", multiple: true },
      deadline: { type: "string", multiple: true },
      tier: { type: "string" },
      slug: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  }));
} catch (e) {
  console.error(e.message + "\n" + usage);
  process.exit(1);
}
if (values.help) {
  console.log(usage);
  process.exit(0);
}
// legacy: <slug> "<Display name>"
if (!values.company && positionals.length === 2) {
  values.slug = positionals[0];
  values.company = positionals[1];
}
if (!values.company) {
  console.error(usage);
  process.exit(1);
}

try {
  const r = composeRoom({
    company: values.company,
    people: values.person || [],
    goal: values.goal || "",
    modes: (values.mode || []).flatMap((m) => m.split(",")),
    orgType: values.org,
    date: values.date,
    meetings: (values.meeting || []).map((m) => {
      const [when = "", title, who, format, length] = m.split("|").map((x) => x.trim());
      const [date, time = ""] = when.split(/\s+/);
      return { date, time, title, who, format, length };
    }),
    deadlines: (values.deadline || []).map((d) => {
      const [date, title, kind] = d.split("|").map((x) => x.trim());
      return { date, title, kind };
    }),
    tier: values.tier,
    slug: values.slug,
  });
  const run = writeRunScript(r.slug, r.intake);
  const envName = "ROOM_PASSWORD_" + r.slug.toUpperCase().replace(/-/g, "_");
  for (const w of r.warnings) console.warn("note: " + w);
  console.log(`created rooms/${r.slug}/  (${r.pageCount} pages; modes ${r.intake.modes.join(", ")}${r.intake.modesInferred ? " (from the goal)" : ""}; org ${r.intake.orgType})
pipeline (not started):
  rooms/${r.slug}/RUN.sh
  ${run.command}
next:
  1. run the pipeline above, or fill in rooms/${r.slug}/pages/ by hand
  2. npm run lint ${r.slug}
  3. set ${envName} in .env (local) and in the site's environment variables (deployed)
  4. npm run build`);
} catch (e) {
  console.error("new-room: " + e.message);
  process.exit(1);
}
