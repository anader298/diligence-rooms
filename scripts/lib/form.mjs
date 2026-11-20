// The form: a fixed list of buckets, defined in JSON packs (config/form/**), that every room
// fills. Each bucket ends in exactly one state, computed here from the ledgers, never written
// by an AI:
//
//   filled    a ledger row (script or entry) or the intake fills it; best grade and source shown
//   empty     searched, nothing found (a module ran, or a "none found" entry says what was searched)
//   blocked   couldn't check: the modules that feed it were blocked, skipped or not run
//   no-tool   no module feeds it and nobody handed in an entry
//
// Packs: config/form/core-person.json (repeated per person), core-company.json,
// modes/<mode>.json, orgtypes/<type>.json, extras/<name>.json (optional). The intake (mode,
// org type, practice, people) picks which apply. Adding a bucket = a JSON line; adding a use
// case = a pack file; adding a tool = a module that declares its vars. See docs/form.md.
//
// Ledgers: rooms/<slug>/work/osint/<person slug>/ledger.jsonl (+ osint.json from the scripted
// pass) and rooms/<slug>/work/osint/_company/ledger.jsonl (entries on company buckets).
// A row is cited as "<ledger>/L-0001"; a bare "L-0001" means the bucket's own ledger.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const FORM_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "form");
export const COMPANY_LEDGER = "_company";
export const KINDS = ["fact", "list", "ai"];
export const STATES = ["filled", "empty", "blocked", "no-tool"];
export const STATE_LABEL = { filled: "Filled", empty: "Searched, nothing found", blocked: "Couldn't check", "no-tool": "No tool yet" };
const FILL_GRADES = ["v", "p", "w", "i"]; // best first
const NONE_GRADES = ["n", "np", "u"];
export const GRADE_CLASS = { v: "verified", p: "partly", w: "weak", i: "inference", n: "none", np: "not-public", u: "unknown" };
export const GRADE_LABEL = { v: "Verified", p: "Partly verified", w: "Weak", i: "Inference", n: "None found", np: "Not public", u: "Unknown", intake: "From the intake" };
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const BUCKET_KEYS = new Set(["id", "label", "page", "group", "kind", "vars", "match", "intake", "hint", "required", "start", "scope", "cites"]);
const PACK_KEYS = new Set(["id", "label", "scope", "note", "optional", "buckets"]);

// ---------------------------------------------------------------- packs

/** Problems with one pack: { errors[], warnings[] }. Unknown keys are warnings, not errors. */
export function validatePack(pack, where = "pack") {
  const errors = [];
  const warnings = [];
  if (!pack || typeof pack !== "object" || Array.isArray(pack)) return { errors: [`${where}: not a JSON object`], warnings };
  if (typeof pack.id !== "string" || !pack.id) errors.push(`${where}: "id" is required`);
  if (pack.scope && !["person", "company"].includes(pack.scope)) errors.push(`${where}: scope must be person or company`);
  if (!Array.isArray(pack.buckets)) errors.push(`${where}: "buckets" must be an array`);
  for (const k of Object.keys(pack)) if (!PACK_KEYS.has(k)) warnings.push(`${where}: unknown key "${k}" ignored`);
  const seen = new Set();
  for (const [i, b] of (pack.buckets || []).entries()) {
    const at = `${where} bucket ${b?.id || "#" + (i + 1)}`;
    if (!b || typeof b !== "object") {
      errors.push(`${at}: not an object`);
      continue;
    }
    if (!ID_RE.test(b.id || "")) errors.push(`${at}: id must be lower-case letters, digits, dots, dashes`);
    if (seen.has(b.id)) errors.push(`${at}: duplicate id`);
    seen.add(b.id);
    for (const k of ["label", "page", "group"]) if (typeof b[k] !== "string" || !b[k].trim()) errors.push(`${at}: "${k}" is required`);
    if (!KINDS.includes(b.kind)) errors.push(`${at}: kind must be ${KINDS.join(" | ")}`);
    if (b.vars != null && (!Array.isArray(b.vars) || b.vars.some((v) => typeof v !== "string"))) errors.push(`${at}: vars must be a list of variable ids`);
    if (b.scope && !["person", "company"].includes(b.scope)) errors.push(`${at}: scope must be person or company`);
    if (b.match != null)
      try {
        new RegExp(b.match, "i");
      } catch {
        errors.push(`${at}: match is not a valid regular expression`);
      }
    if (b.kind === "ai" && (b.vars || []).length) warnings.push(`${at}: an ai bucket is filled by entries; its vars are ignored`);
    for (const k of Object.keys(b)) if (!BUCKET_KEYS.has(k)) warnings.push(`${at}: unknown key "${k}" ignored`);
  }
  return { errors, warnings };
}

/**
 * Every pack under formDir, by id ("core-person", "modes/deal", ...). A pack that does not parse
 * or validate is reported, not thrown. Returns { packs: {id: pack}, errors[], warnings[] }.
 */
export function loadPacks(formDir = FORM_DIR) {
  const packs = {};
  const errors = [];
  const warnings = [];
  const read = (file, id) => {
    let p;
    try {
      p = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      errors.push(`${id}: ${e.message}`);
      return;
    }
    const v = validatePack(p, id);
    if (p && typeof p === "object" && p.id && p.id !== id) v.warnings.push(`${id}: its "id" says "${p.id}"; the file path wins`);
    errors.push(...v.errors);
    warnings.push(...v.warnings);
    if (!v.errors.length) packs[id] = { ...p, id };
  };
  if (!existsSync(formDir)) return { packs, errors: [`no form packs at ${formDir}`], warnings };
  for (const f of readdirSync(formDir).filter((f) => f.endsWith(".json")).sort()) read(join(formDir, f), f.replace(/\.json$/, ""));
  for (const sub of ["modes", "orgtypes", "extras"]) {
    const d = join(formDir, sub);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((f) => f.endsWith(".json")).sort()) read(join(d, f), `${sub}/${f.replace(/\.json$/, "")}`);
  }
  // bucket ids are unique across all packs
  const owner = {};
  for (const p of Object.values(packs))
    for (const b of p.buckets) {
      if (owner[b.id]) errors.push(`bucket "${b.id}" is in both ${owner[b.id]} and ${p.id}`);
      else owner[b.id] = p.id;
    }
  return { packs, errors, warnings };
}

/**
 * The packs a room uses: every top-level pack (core-*), its modes, its org type, and the
 * extras it opted into. A selection with no pack file is a warning (the room still builds).
 */
export function selectPacks(all, { modes = [], orgType = null, practice = false, extras = [] } = {}) {
  const ids = Object.keys(all).filter((id) => !id.includes("/"));
  const missing = [];
  const want = [...modes.map((m) => `modes/${m}`), ...(orgType ? [`orgtypes/${orgType}`] : []), ...[...extras, ...(practice ? ["practice"] : [])].map((x) => `extras/${x}`)];
  for (const id of [...new Set(want)]) (all[id] ? ids : missing).push(id);
  return { packs: ids.map((id) => all[id]), missing };
}

/** What the room selected: from intake.json, else room.json (older rooms). */
export function selectionFor(roomDir) {
  const read = (f) => {
    try {
      return JSON.parse(readFileSync(join(roomDir, f), "utf8"));
    } catch {
      return null;
    }
  };
  const intake = read("intake.json") || {};
  const room = read("room.json") || {};
  const people = (intake.people?.length ? intake.people : room.people || []).filter((p) => p?.slug).map((p) => ({ name: p.name, slug: p.slug }));
  return {
    modes: intake.modes || room.modes || [],
    orgType: intake.orgType || room.orgType || null,
    practice: intake.practice === true || room.practice === true,
    people,
    intake: { ...intake, company: intake.company || room.counterparty || room.title, domain: intake.domain || room.domain || null, goal: intake.goal ?? room.subtitle, meetingDate: intake.meetingDate || room.meetingDate || null },
  };
}

/**
 * Bucket instances for a room: company buckets once, person buckets once per person.
 * Each: { ...bucket, key, pack, scope, person, pageId, ledger }.
 */
export function instances(packs, people = []) {
  const out = [];
  for (const p of packs)
    for (const b of p.buckets) {
      const scope = b.scope || p.scope || "company";
      if (scope === "person") for (const who of people) out.push({ ...b, vars: b.vars || [], key: `${who.slug}/${b.id}`, pack: p.id, scope, person: who.slug, personName: who.name, pageId: `${b.page}-${who.slug}`, ledger: who.slug });
      else out.push({ ...b, vars: b.vars || [], key: b.id, pack: p.id, scope, person: null, pageId: b.page, ledger: COMPANY_LEDGER });
    }
  return out;
}

// ---------------------------------------------------------------- ledgers

/**
 * Every ledger in rooms/<slug>/work/osint/: { name: { rows, misses, modules, ran, subject } }.
 * Each row gets `ref` ("<name>/L-0001"). An unreadable line or file is skipped, never fatal.
 */
export function loadLedgers(roomDir) {
  const dir = join(roomDir, "work", "osint");
  const out = {};
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || /\.prev-/.test(e.name)) continue;
    const d = join(dir, e.name);
    const rows = [];
    if (existsSync(join(d, "ledger.jsonl")))
      for (const line of readFileSync(join(d, "ledger.jsonl"), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line);
          rows.push({ ...r, ref: `${e.name}/${r.id}`, ledger: e.name });
        } catch {
          // a broken line is skipped; the ledger file keeps it
        }
      }
    let osint = null;
    try {
      osint = existsSync(join(d, "osint.json")) ? JSON.parse(readFileSync(join(d, "osint.json"), "utf8")) : null;
    } catch {
      osint = null;
    }
    if (!rows.length && !osint) continue;
    out[e.name] = { name: e.name, rows, misses: osint?.misses || [], modules: osint?.modules || [], ran: !!osint, subject: osint?.subject || null };
  }
  return out;
}

/** Find a cited row: "dan-x/L-0003", or "L-0003" in the home ledger. */
export function resolveRef(ledgers, ref, home) {
  const s = String(ref || "").trim();
  const m = s.match(/^(?:([a-z0-9_][a-z0-9_-]*)\/)?(L-\d{4,})$/);
  if (!m) return null;
  const L = ledgers[m[1] || home];
  return L ? L.rows.find((r) => r.id === m[2]) || null : null;
}

// ---------------------------------------------------------------- states

const BLOCKED_STATUS = new Set(["blocked", "skipped", "error", "timeout"]);
const isBlockedMiss = (m) => m?.blocked === true || /\bblocked\b|not checked|not checkable|\bnot run\b|rate.?limit|captcha|HTTP (?:202|403|429|451|503|999)\b|needs (?:a free )?[A-Z_]{4,}|: timeout/i.test(String(m?.searched || ""));
const textOf = (r) => `${r.url || ""} ${typeof r.value === "string" ? r.value : JSON.stringify(r.value ?? "")}`;

/** The rows of the ledgers this bucket reads: its own person's, or (company) all of them, deduplicated. */
function ledgersFor(inst, ledgers) {
  if (inst.scope === "person") return [ledgers[inst.ledger]].filter(Boolean);
  return Object.values(ledgers);
}

/** Does this row belong in this bucket? Entries name their bucket; script rows go by var (and match). */
export function rowFits(inst, r) {
  if (r.bucket) return r.bucket === inst.id;
  if (inst.kind === "ai" || !inst.vars.includes(r.var)) return false;
  return !inst.match || new RegExp(inst.match, "i").test(textOf(r));
}

/**
 * The state of every bucket instance. moduleVars: { module id: [vars] } (from moduleVars()).
 * Returns [{ key, id, label, page, pageId, group, kind, pack, person, required, start, state,
 *   grade, rows[], refs[], why, cites{ok[], bad[]} }].
 */
export function computeStates(insts, ledgers, { moduleVars = {}, intake = {} } = {}) {
  const feeders = (vars) => Object.entries(moduleVars).filter(([, vs]) => vs.some((v) => vars.includes(v))).map(([id]) => id);
  return insts.map((inst) => {
    const Ls = ledgersFor(inst, ledgers);
    const seen = new Set();
    const rows = [];
    for (const L of Ls)
      for (const r of L.rows) {
        if (!rowFits(inst, r)) continue;
        const k = `${r.var}|${JSON.stringify(r.value)}|${r.url || ""}|${r.bucket || ""}`;
        if (seen.has(k)) continue;
        seen.add(k);
        rows.push(r);
      }
    const base = { key: inst.key, id: inst.id, label: inst.label, page: inst.page, pageId: inst.pageId, group: inst.group, kind: inst.kind, pack: inst.pack, person: inst.person, personName: inst.personName, scope: inst.scope, required: !!inst.required, start: !!inst.start, hint: inst.hint || null, ledger: inst.ledger };
    const done = (state, extra = {}) => ({ ...base, state, grade: null, rows, refs: rows.map((r) => r.ref), why: null, ...extra });

    // AI slots: an entry counts when every ledger id it cites exists.
    if (inst.kind === "ai") {
      const checked = rows.map((r) => {
        const cites = r.cites || [];
        // a cite must be a row that exists and is evidence (not another AI entry)
        const bad = cites.filter((c) => {
          const hit = resolveRef(ledgers, c, r.ledger);
          return !hit || hit.entry === "ai";
        });
        return { r, ok: cites.length > 0 && !bad.length, bad, none: NONE_GRADES.includes(r.grade) };
      });
      const good = checked.filter((c) => c.ok && !c.none);
      const bad = checked.flatMap((c) => c.bad.map((x) => ({ row: c.r.ref, cite: x }))).concat(checked.filter((c) => !c.none && !(c.r.cites || []).length).map((c) => ({ row: c.r.ref, cite: "(none)" })));
      if (good.length) return done("filled", { grade: "i", rows: good.map((c) => c.r), refs: good.map((c) => c.r.ref), badCites: bad });
      const none = checked.find((c) => c.none);
      if (none) return done("empty", { why: none.r.note || none.r.value, badCites: bad });
      return done("empty", { why: rows.length ? "AI entry cites ledger ids that do not exist" : "AI slot not written yet", badCites: bad, aiOpen: true });
    }

    const fill = rows.filter((r) => FILL_GRADES.includes(r.grade));
    if (fill.length) {
      fill.sort((a, b) => FILL_GRADES.indexOf(a.grade) - FILL_GRADES.indexOf(b.grade));
      return done("filled", { grade: fill[0].grade, rows: fill, refs: fill.map((r) => r.ref) });
    }
    if (inst.intake) {
      const v = inst.intake.split(".").reduce((o, k) => (o == null ? o : o[k]), intake);
      if (v != null && String(v).trim()) return done("filled", { grade: "intake", value: String(v), why: "from the intake form" });
    }
    const none = rows.find((r) => NONE_GRADES.includes(r.grade));
    if (none) return done("empty", { why: none.note || none.detail?.searched || none.value });

    const misses = Ls.flatMap((L) => L.misses.filter((m) => inst.vars.includes(m.var)));
    const realMiss = misses.find((m) => !isBlockedMiss(m));
    if (realMiss) return done("empty", { why: `${realMiss.module}: ${realMiss.searched}` });

    const feed = feeders(inst.vars);
    if (inst.intake && !feed.length) return done("empty", { why: "not given in the intake" });
    if (!feed.length) return done("no-tool", { why: inst.hint ? `no module feeds it; where to look: ${inst.hint}` : "no module feeds it; an agent can hand in an entry" });
    const reports = Ls.flatMap((L) => L.modules.filter((m) => feed.includes(m.id)));
    const ranOk = reports.filter((m) => !BLOCKED_STATUS.has(m.status));
    if (ranOk.length) return done("empty", { why: `searched by ${[...new Set(ranOk.map((m) => m.id))].join(", ")}: nothing found` });
    if (reports.length) {
      const why = [...new Set(reports.map((m) => `${m.id} ${m.status}${m.why ? ` (${m.why})` : ""}`))].join("; ");
      return done("blocked", { why });
    }
    const blockedMiss = misses.find(isBlockedMiss);
    if (blockedMiss) return done("blocked", { why: `${blockedMiss.module}: ${blockedMiss.searched}` });
    return done("blocked", { why: Ls.some((L) => L.ran) ? `${feed.join(", ")} did not run` : "the scripted pass has not run" });
  });
}

/** Ledger rows that landed in no bucket of the room's form ("Other findings"). */
export function otherFindings(insts, ledgers) {
  const out = [];
  const seen = new Set();
  for (const L of Object.values(ledgers))
    for (const r of L.rows) {
      const own = insts.filter((i) => (i.scope === "person" ? i.ledger === L.name : true));
      if (own.some((i) => rowFits(i, r))) continue;
      const k = `${r.var}|${JSON.stringify(r.value)}|${r.url || ""}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ ...r, unknownBucket: r.bucket ? !insts.some((i) => i.id === r.bucket) : false });
    }
  return out;
}

/**
 * The whole form for a room, or null when the room has no ledgers yet (rooms built before the
 * form keep today's behaviour). opts: { formDir, moduleVars, pageIds: Set of the room's page ids }.
 */
export function roomForm(roomDir, opts = {}) {
  const ledgers = loadLedgers(roomDir);
  if (!Object.keys(ledgers).length && !opts.force) return null;
  const loaded = loadPacks(opts.formDir);
  const sel = selectionFor(roomDir);
  const { packs, missing } = selectPacks(loaded.packs, sel);
  const insts = instances(packs, sel.people);
  const buckets = computeStates(insts, ledgers, { moduleVars: opts.moduleVars || {}, intake: sel.intake });
  const warnings = [...loaded.warnings, ...missing.map((id) => `no form pack ${id}.json for this room's selection; its buckets are missing`)];
  if (opts.pageIds) {
    const absent = [...new Set(buckets.filter((b) => !opts.pageIds.has(b.pageId)).map((b) => `${b.pack}: page "${b.pageId}"`))];
    for (const a of absent) warnings.push(`${a} is not in this room; its buckets show on the form page only`);
  }
  const counts = Object.fromEntries(STATES.map((s) => [s, buckets.filter((b) => b.state === s).length]));
  return { selection: sel, packs: packs.map((p) => ({ id: p.id, label: p.label, buckets: insts.filter((i) => i.pack === p.id).length })), missingPacks: missing, buckets, other: otherFindings(insts, ledgers), counts, errors: loaded.errors, warnings, ledgers: Object.keys(ledgers) };
}

// ---------------------------------------------------------------- the gate

/**
 * The form check run before every build. Returns { ok, errors[], warnings[] }.
 *  - every pack the room selected exists (no bucket from the selected packs missing)
 *  - every required bucket has a real state: not "no tool yet", not "the scripted pass has not run"
 *  - every Start here bucket is filled
 *  - every AI entry cites ledger ids that exist
 */
export function formGate(form) {
  if (!form) return { ok: false, errors: ["no form: the scripted pass has not run (rooms/<slug>/work/osint/ is empty)"], warnings: [] };
  const errors = [...form.errors];
  for (const id of form.missingPacks) errors.push(`selected pack ${id} has no file in config/form/: its buckets are missing`);
  for (const b of form.buckets) {
    const who = b.personName ? ` (${b.personName})` : "";
    if (b.start && b.state !== "filled") errors.push(`Start here: "${b.label}"${who} is not filled (${STATE_LABEL[b.state]}${b.why ? `: ${b.why}` : ""})`);
    else if (b.required && b.state === "no-tool") errors.push(`required bucket "${b.label}"${who} [${b.id}] has no tool and no entry: hand in an entry or a "none found" with what was searched`);
    else if (b.required && b.state === "blocked" && /has not run/.test(b.why || "")) errors.push(`required bucket "${b.label}"${who} [${b.id}]: the scripted pass has not run`);
    else if (b.required && b.kind === "ai" && b.aiOpen) errors.push(`required AI slot "${b.label}"${who} [${b.id}] is not written`);
    for (const c of b.badCites || []) errors.push(`AI entry ${c.row} in "${b.label}"${who} cites ${c.cite}, which is not an evidence row in any ledger`);
  }
  for (const r of form.other) if (r.unknownBucket) form.warnings.push(`ledger row ${r.ref} names bucket "${r.bucket}", which no selected pack has; shown under Other findings`);
  return { ok: !errors.length, errors: [...new Set(errors)], warnings: form.warnings };
}

// ---------------------------------------------------------------- docs

/**
 * The bucket list as a markdown table per pack (docs/form-buckets.md). With moduleVars, a var
 * no module fills is marked "(no module)", and a bucket with no tool at all says so.
 */
export function bucketTable(all, moduleVars = null) {
  const L = [];
  const fed = moduleVars ? new Set(Object.values(moduleVars).flat()) : null;
  const varText = (v) => `\`${v}\`${fed && !fed.has(v) ? " (no module)" : ""}`;
  const order = Object.keys(all).sort((a, b) => (a.includes("/") - b.includes("/")) || a.localeCompare(b));
  for (const id of order) {
    const p = all[id];
    L.push(`## ${id} (${p.buckets.length} bucket${p.buckets.length === 1 ? "" : "s"})`, "", `${p.label}${p.scope === "person" ? ", repeated per person" : ""}.${p.note ? " " + p.note : ""}`, "");
    if (!p.buckets.length) {
      L.push("No buckets yet: add lines to the JSON file.", "");
      continue;
    }
    L.push("| Bucket | Id | Page | Group | Kind | Fed by | Req |", "|---|---|---|---|---|---|---|");
    for (const b of p.buckets) {
      const noTool = fed && b.kind !== "ai" && !b.intake && !(b.vars || []).some((v) => fed.has(v));
      const src = b.kind === "ai" ? "AI entry citing ledger ids" : [...(b.vars || []).map(varText), b.intake ? `intake \`${b.intake}\`` : ""].filter(Boolean).join(", ") || "entries only";
      const by = `${src}${noTool || (!fed && !(b.vars || []).length && b.kind !== "ai" && !b.intake) ? `; **no tool yet**${b.hint ? ` (look: ${b.hint})` : ""}` : ""}`;
      L.push(`| ${b.label.replace(/\|/g, "/")} | \`${b.id}\` | ${b.page} | ${b.group} | ${b.kind} | ${by.replace(/\|/g, "/")}${b.match ? ` (match \`${b.match.replace(/\|/g, "/")}\`)` : ""} | ${b.start ? "start" : b.required ? "yes" : ""} |`);
    }
    L.push("");
  }
  return L.join("\n");
}
