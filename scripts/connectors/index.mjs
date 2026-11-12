// The connector registry: every adapter, whether it is configured, and what a run would cost.
// "Configured" never reveals a key: only which env key names are present or missing.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import apollo from "./apollo.mjs";
import apolloMcp from "./apollo-mcp.mjs";
import zoominfo from "./zoominfo.mjs";
import lusha from "./lusha.mjs";
import cognism from "./cognism.mjs";
import clay from "./clay.mjs";
import crunchbase from "./crunchbase.mjs";
import pitchbook from "./pitchbook.mjs";
import linkedinExport from "./linkedin-export.mjs";
import csv from "./csv.mjs";

export const ADAPTERS = [apollo, apolloMcp, zoominfo, lusha, cognism, clay, crunchbase, pitchbook, linkedinExport, csv];
export const BY_ID = Object.fromEntries(ADAPTERS.map((a) => [a.id, a]));

const REQUIRED = ["id", "name", "kind", "envKeys", "fields", "docsUrl", "estimateCredits", "fetchPerson", "fetchCompany"];
for (const a of ADAPTERS) for (const k of REQUIRED) if (a[k] === undefined) throw new Error(`connector ${a.id || "?"} is missing ${k}`);

// revealPersonal: ask providers that charge extra for personal emails and mobile/personal phones
// (Apollo reveal_personal_emails / reveal_phone_number, Lusha phones, ZoomInfo mobile) to return
// them. Default true: in owner-run firms these are often the business contact of record. The
// extra credits are in the estimate. Set false in config/connectors.json to skip them.
export const DEFAULT_CONFIG = { enabled: ["linkedin-export", "csv"], maxCredits: 50, revealPersonal: true, providers: {} };

/** config/connectors.json (gitignored), else the example, else the defaults. */
export function loadConfig(configFile) {
  for (const f of [configFile, configFile && configFile.replace(/connectors\.json$/, "connectors.example.json")]) {
    if (f && existsSync(f)) {
      const c = JSON.parse(readFileSync(f, "utf8"));
      return { ...DEFAULT_CONFIG, ...c, providers: c.providers || {}, file: f, example: f.endsWith(".example.json") };
    }
  }
  return { ...DEFAULT_CONFIG, file: null, example: false };
}

export function roomPaths(roomsDir, slug) {
  const room = join(roomsDir, slug);
  const work = join(room, "work");
  return { room, work, out: join(work, "connectors"), raw: join(work, "connectors", "raw"), imports: join(work, "imports"), intake: join(room, "intake.json"), businessRecords: join(work, "business-records.json") };
}

/** Context for configured() and estimates (no fetch, no spending). */
export function staticCtx(paths, env, slug) {
  return { env, slug, importsDir: paths.imports, rawDir: paths.raw };
}

export function status(adapter, ctx) {
  const missing = adapter.envKeys.filter((k) => !ctx.env[k]);
  const configured = adapter.configured ? !!adapter.configured(ctx) : adapter.kind === "api" ? missing.length === 0 : false;
  return { configured, envKeys: adapter.envKeys, optionalEnvKeys: adapter.optionalEnvKeys || [], missing: configured ? [] : missing };
}

/** One row per provider: what it is, whether it can run, and what it would cost for this intake. */
export function describe(ids, intake, ctx, config) {
  return ids.map((id) => {
    const a = BY_ID[id];
    if (!a) return { id, unknown: true };
    const st = status(a, ctx);
    const est = a.estimateCredits(intake, { revealPersonal: config.revealPersonal !== false, ...(config.providers[id] || {}) }, ctx);
    return { id, name: a.name, kind: a.kind, docsUrl: a.docsUrl, apiStatus: a.status, fields: a.fields, ...st, estimate: est, ...(a.mcp ? { mcp: a.mcp } : {}), ...(a.mcpTools ? { mcpTools: a.mcpTools } : {}) };
  });
}
