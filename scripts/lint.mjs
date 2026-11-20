#!/usr/bin/env node
// Lint rooms against the depth standard:   npm run lint [slug] [--strict] [--json]
//
// Per room: pages still identical to the skeleton, pages with no a.src, grade
// counts (seven grades) and the verified + partly share (None found left out),
// checklist rows with no grade, [ANTHONY: ...] items, h2s longer than
// 40 characters or with attributes, pages missing p.meta, and the depth targets
// for the room's tier (room.json "tier": "full" by default, or "light"), at least
// 8 personal life rows checked per person (counted from the OSINT log's checks plus the
// findings on the page, not from the visible rows), and on every filled persona the
// verdict, the claims against the record and the four drivers (what drives them); Start here
// filled (the summary and the one card); and for rooms with ledgers, the form check
// (scripts/lib/form.mjs).
// Exits non-zero on a failed room only with --strict.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "./lib/compose.mjs";
import { lintRoom, formatReport } from "./lib/lint.mjs";
import { moduleVars } from "./osint/run.mjs";

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const asJson = args.includes("--json");
const only = args.find((a) => !a.startsWith("--"));
const roomsDir = process.env.DR_ROOMS || join(REPO, "rooms");
const slugs = readdirSync(roomsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(roomsDir, d.name, "room.json")) && (!only || d.name === only))
  .map((d) => d.name);
if (!slugs.length) {
  console.error(only ? `lint: no room "${only}" in rooms/` : "lint: no rooms found");
  process.exit(1);
}
const pageTemplate = readFileSync(join(REPO, "templates", "page.html"), "utf8");
const mv = await moduleVars();
const reports = slugs.map((s) => lintRoom(join(roomsDir, s), { skeletonDir: join(REPO, "templates", "skeleton"), pageTemplate, moduleVars: mv }));
if (asJson) console.log(JSON.stringify(reports, null, 2));
else console.log(reports.map(formatReport).join("\n\n"));
if (strict && reports.some((r) => !r.ok)) process.exit(1);
