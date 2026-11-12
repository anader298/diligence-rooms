// The Enrich stage (STANDARD.md sec. 10, stage 2b). Estimate first; fetch only with yes.
//
//   estimate:  every chosen provider, configured or not, with its credit estimate. Writes
//              work/connectors/estimate.json and stops. Nothing is called, nothing is spent.
//   yes:       each configured provider fetches every person, then the company, and writes
//              work/connectors/<provider>.json; then every provider file present is merged into
//              merged.json (per-field provenance, grade partly), conflicts.json and run.json.
//              Contacts are cross-checked against work/business-records.json (sameAsBusiness).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BY_ID, ADAPTERS, loadConfig, roomPaths, staticCtx, describe } from "./index.mjs";
import { mergeAll, fieldsFilled } from "./merge.mjs";
import { domain as cleanDomain } from "./schema.mjs";

const RESERVED = new Set(["merged", "conflicts", "run", "estimate"]);
const writeJson = (f, x) => writeFileSync(f, JSON.stringify(x, null, 2) + "\n");

export function formatEstimate(rows, total) {
  const pad = (s, n) => String(s).padEnd(n);
  const L = [pad("provider", 17) + pad("kind", 6) + pad("configured", 12) + pad("credits", 9) + "note"];
  for (const r of rows) {
    if (r.unknown) {
      L.push(pad(r.id, 17) + "unknown provider");
      continue;
    }
    const why = r.configured ? "" : r.kind === "api" ? `needs ${r.missing.join(", ") || "its keys"} in .env; ` : r.kind === "mcp" ? "no saved MCP responses yet; " : "no files yet; ";
    L.push(pad(r.id, 17) + pad(r.kind, 6) + pad(r.configured ? "yes" : "no", 12) + pad(r.configured ? r.estimate.credits : "-", 9) + why + r.estimate.note + (r.mcp ? `\n${" ".repeat(44)}MCP: ${r.mcp}` : ""));
  }
  L.push(`Estimated total: ${total} credits across ${rows.filter((r) => r.configured).length} configured provider(s).`);
  return L.join("\n");
}

export async function enrich(opts) {
  const { slug, yes = false, env = process.env, fetch: fetchFn = globalThis.fetch, log = console.log, now = () => new Date() } = opts;
  const paths = roomPaths(opts.roomsDir, slug);
  if (!existsSync(paths.intake)) throw new Error(`rooms/${slug}/intake.json not found; compose the room first (npm run new-room)`);
  const intake = JSON.parse(readFileSync(paths.intake, "utf8"));
  const config = loadConfig(opts.configFile);
  const ids = opts.providers?.length ? opts.providers : config.enabled;
  const unknown = ids.filter((id) => !BY_ID[id]);
  if (unknown.length) throw new Error(`unknown provider(s): ${unknown.join(", ")} (known: ${ADAPTERS.map((a) => a.id).join(", ")})`);
  if (config.example) log(`note: config/connectors.json not found; using ${config.file.split("/").slice(-2).join("/")} (copy it to config/connectors.json to choose providers)`);

  const base = staticCtx(paths, env, slug);
  const rows = describe(ids, intake, base, config);
  const total = rows.filter((r) => r.configured).reduce((n, r) => n + (r.estimate.credits || 0), 0);
  const cap = Number(opts.maxCredits ?? config.maxCredits ?? 50);
  log(formatEstimate(rows, total));
  mkdirSync(paths.out, { recursive: true });
  writeJson(join(paths.out, "estimate.json"), { at: now().toISOString(), providers: rows.map(({ fields, ...r }) => r), total, cap });

  if (!yes) {
    log("Nothing has been spent. Run again with --yes to fetch from the configured providers.");
    return { stopped: true, rows, total };
  }
  if (total > cap) {
    log(`Stopped: the estimate (${total}) is over the cap of ${cap} credits. Raise maxCredits in config/connectors.json or pass --max ${total}.`);
    return { stopped: true, overCap: true, rows, total };
  }

  const fetchedAt = now().toISOString();
  const company = { name: intake.company || intake.counterparty, domain: cleanDomain(opts.domain || intake.domain) };
  const hints = { domain: company.domain };
  const ran = [];
  for (const r of rows) {
    if (!r.configured) {
      log(`skip ${r.id}: not configured`);
      continue;
    }
    const a = BY_ID[r.id];
    const notes = [], errors = [];
    let spent = 0;
    const ctx = { ...base, fetch: fetchFn, fetchedAt, cache: {}, hints, options: config.providers[r.id] || {}, revealPersonal: config.revealPersonal !== false, spend: (n) => (spent += Number(n) || 0), note: (m) => notes.push(m) };
    const people = {};
    for (const p of intake.people || []) {
      try {
        people[p.slug] = await a.fetchPerson({ name: p.name, slug: p.slug, linkedin: p.linkedin }, company, ctx);
      } catch (e) {
        people[p.slug] = null;
        errors.push(`${p.name}: ${e.message}`);
      }
    }
    let comp = null;
    try {
      comp = await a.fetchCompany(company, ctx);
    } catch (e) {
      errors.push(`company: ${e.message}`);
    }
    const result = { provider: r.id, name: a.name, kind: a.kind, fetchedAt, estimate: r.estimate, creditsUsed: spent, notes, errors, people, company: comp };
    writeJson(join(paths.out, `${r.id}.json`), result);
    ran.push(result);
    log(`${r.id}: ${Object.values(people).filter(Boolean).length}/${(intake.people || []).length} people, company ${comp ? "found" : "not found"}, ${spent} credits used${errors.length ? `, ${errors.length} error(s)` : ""}`);
    for (const m of [...notes, ...errors]) log(`  ${m}`);
  }

  // Merge every provider file in the folder (this run and earlier ones), configured order first.
  const files = readdirSync(paths.out).filter((f) => f.endsWith(".json") && !RESERVED.has(f.slice(0, -5)) && BY_ID[f.slice(0, -5)]);
  const order = [...ids, ...config.enabled, ...ADAPTERS.map((a) => a.id)];
  const all = files.map((f) => JSON.parse(readFileSync(join(paths.out, f), "utf8"))).sort((x, y) => order.indexOf(x.provider) - order.indexOf(y.provider));
  // The company's own contact records (website, state registry, SEC/ADV/Form D/990, UCC, WHOIS), saved by the
  // research stage, let the merge mark a personal email, phone or address as the business contact of record.
  const businessRecords = existsSync(paths.businessRecords) ? JSON.parse(readFileSync(paths.businessRecords, "utf8")) : intake.businessRecords || [];
  const { merged, conflicts } = mergeAll(all, intake, fetchedAt, Array.isArray(businessRecords) ? businessRecords : businessRecords.records || []);
  writeJson(join(paths.out, "merged.json"), merged);
  writeJson(join(paths.out, "conflicts.json"), conflicts);
  const runFile = join(paths.out, "run.json");
  const prev = existsSync(runFile) ? JSON.parse(readFileSync(runFile, "utf8")) : { history: [] };
  const summary = {
    ranAt: fetchedAt,
    providers: rows.map((r) => {
      const res = all.find((x) => x.provider === r.id);
      const thisRun = ran.find((x) => x.provider === r.id);
      return { id: r.id, name: r.name, kind: r.kind, configured: r.configured, ran: !!thisRun, estimate: r.estimate.credits, creditsUsed: thisRun ? thisRun.creditsUsed : 0, fieldsFilled: res ? fieldsFilled(res) : [], errors: thisRun?.errors || [], notes: thisRun?.notes || [] };
    }),
    creditsUsed: ran.reduce((n, x) => n + x.creditsUsed, 0),
    conflicts: conflicts.length,
  };
  writeJson(runFile, { ...summary, history: [...(prev.history || []), { ranAt: summary.ranAt, providers: ran.map((x) => x.provider), creditsUsed: summary.creditsUsed, conflicts: summary.conflicts }] });
  log(`merged ${all.length} provider file(s) -> work/connectors/merged.json; ${conflicts.length} conflict(s) -> conflicts.json; ${summary.creditsUsed} credits used`);
  return { stopped: false, rows, total, results: ran, merged, conflicts, summary };
}
