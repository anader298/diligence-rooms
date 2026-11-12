#!/usr/bin/env node
// Enrich a room from licensed data providers and the user's own exports (stage 2b).
//
//   npm run enrich -- <slug> [--providers apollo,lusha] [--domain acme.com] [--yes] [--max 80]
//
// Without --yes it prints a credit estimate per provider and stops: nothing is called.
// With --yes it fetches from the configured providers, writes rooms/<slug>/work/connectors/
// <provider>.json, merged.json (per-field provenance), conflicts.json and run.json.
// Providers come from --providers, else config/connectors.json "enabled".
// Keys come from .env (see .env.example); they are never printed.
import { parseArgs } from "node:util";
import { join } from "node:path";
import { REPO, SLUG_RE } from "./lib/compose.mjs";
import { enrich } from "./connectors/run.mjs";

const usage = "usage: npm run enrich -- <slug> [--providers apollo,lusha] [--domain example.com] [--yes] [--max <credits>]";
let values, positionals;
try {
  ({ values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      providers: { type: "string" },
      domain: { type: "string" },
      yes: { type: "boolean", default: false },
      max: { type: "string" },
      "rooms-dir": { type: "string" },
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  }));
} catch (e) {
  console.error(e.message + "\n" + usage);
  process.exit(1);
}
if (values.help || !positionals[0]) {
  console.log(usage);
  process.exit(values.help ? 0 : 1);
}
const slug = positionals[0];
if (!SLUG_RE.test(slug)) {
  console.error(`bad slug "${slug}"`);
  process.exit(1);
}

try {
  const r = await enrich({
    slug,
    yes: values.yes,
    providers: values.providers ? values.providers.split(",").map((s) => s.trim()).filter(Boolean) : null,
    domain: values.domain,
    maxCredits: values.max != null ? Number(values.max) : undefined,
    roomsDir: values["rooms-dir"] || join(REPO, "rooms"),
    configFile: values.config || join(REPO, "config", "connectors.json"),
  });
  process.exitCode = r.overCap ? 2 : 0;
} catch (e) {
  console.error("enrich: " + e.message);
  process.exitCode = 1;
}
