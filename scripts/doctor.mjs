#!/usr/bin/env node
// npm run doctor: is this machine ready to build rooms? One line per check, with the fix.
import { REPO } from "./lib/compose.mjs";
import { checks, osintChecks } from "./lib/doctor.mjs";

const r = await checks(REPO);
for (const c of r.checks) {
  const mark = c.ok ? "ok  " : c.required ? "FIX " : "--  ";
  console.log(`${mark} ${c.label}${c.fix ? `\n       ${c.fix}` : ""}`);
}
// Public-source research (npm run osint): optional keys and the opt-in heavy lane. Never blocking.
console.log("\nOSINT (all optional):");
for (const c of await osintChecks(process.env)) console.log(`${c.ok ? "ok  " : "--  "} ${c.label}${c.fix ? `\n       ${c.fix}` : ""}`);
console.log(r.ok ? "\nReady. Run: npm run studio" : "\nNot ready yet: fix the FIX lines above, then run npm run doctor again.");
process.exit(r.ok ? 0 : 1);
