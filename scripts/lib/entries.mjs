// Entries: how agents hand in what they found. An entry names a bucket of the room's form, a
// value, the source URL and a note; it goes into the same ledger as the script rows and through
// the same two-source rule (scripts/osint/weights.mjs). An agent never sets a grade: it may ask
// for Verified, and the row keeps it only when a second, independent source agrees (or the row
// is a primary record). AI judgement slots (kind "ai") hold text that cites the ledger ids it
// rests on; every id must exist.
//
//   submitEntry(roomDir, { bucket, person, value, url, note, none, weak, cites, date })
//     -> { row, bucket, ledger, warnings }      throws on a bad entry, with the reason

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeLedger } from "../osint/core.mjs";
import { loadVariables } from "../osint/run.mjs";
import { corroborate, loadWeights } from "../osint/weights.mjs";
import { loadPacks, selectPacks, selectionFor, instances, loadLedgers, resolveRef, COMPANY_LEDGER } from "./form.mjs";

const HTTP = /^https?:\/\/[^\s]+$/i;

/**
 * Grade a ledger the way the scripted pass does, after a new row: every row that was cut from
 * Verified for having one source, and every agent row, goes back to the grade it claimed, then
 * the two-source rule runs again over this ledger plus `context` rows (other ledgers, read only).
 * Writes the ledger file. Returns the ledger's rows.
 */
export function regrade(ledger, { subject = {}, context = [] } = {}) {
  for (const r of ledger.rows) {
    const cut = r.graded_from === "v" && /^one source/.test(r.grade_basis || "");
    if (cut || (r.module === "agent" && r.claim)) {
      r.grade = r.claim || r.graded_from;
      for (const k of ["graded_from", "grade_basis", "signals", "corroborated_by"]) delete r[k];
    }
  }
  // other ledgers' rows are read only, and cited by their qualified id ("<ledger>/L-0001")
  const ctx = context.map((r) => ({ ...r, id: r.ref || r.id }));
  const all = [...ledger.rows, ...ctx];
  corroborate(all, subject, loadWeights());
  writeFileSync(ledger.file, ledger.rows.map((r) => JSON.stringify(r)).join("\n") + (ledger.rows.length ? "\n" : ""));
  return ledger.rows;
}

/** The bucket instance an entry is for; throws with what to do when it is not on this room's form. */
export function findBucket(roomDir, bucketId, person, formDir) {
  const { packs: all, errors } = loadPacks(formDir);
  if (errors.length && !Object.keys(all).length) throw new Error(`form packs did not load: ${errors[0]}`);
  const sel = selectionFor(roomDir);
  const { packs } = selectPacks(all, sel);
  const owner = Object.values(all).find((p) => p.buckets.some((b) => b.id === bucketId));
  if (!owner) {
    const near = Object.values(all).flatMap((p) => p.buckets.map((b) => b.id)).filter((id) => id.split(".")[0] === String(bucketId).split(".")[0]).slice(0, 8);
    throw new Error(`no bucket "${bucketId}" in config/form/${near.length ? `; near: ${near.join(", ")}` : ""}. To add one, add a line to a pack (docs/form.md).`);
  }
  if (!packs.includes(owner)) throw new Error(`bucket "${bucketId}" is in pack ${owner.id}, which this room did not select (modes ${sel.modes.join(", ") || "none"}, org type ${sel.orgType || "none"})`);
  const b = owner.buckets.find((x) => x.id === bucketId);
  const scope = b.scope || owner.scope || "company";
  if (scope === "person") {
    const who = sel.people.find((p) => p.slug === person || p.name === person);
    if (!who) throw new Error(`bucket "${bucketId}" is per person: pass --person <slug> (${sel.people.map((p) => p.slug).join(", ") || "no people in the intake"})`);
    return { ...instances([owner], [who]).find((i) => i.id === bucketId), selection: sel };
  }
  return { ...instances([owner], []).find((i) => i.id === bucketId), selection: sel };
}

/** Hand in one entry. See the header for the shape. */
export function submitEntry(roomDir, e, { formDir } = {}) {
  const inst = findBucket(roomDir, e.bucket, e.person, formDir);
  const sel = inst.selection;
  const ledgers = loadLedgers(roomDir);
  const home = inst.ledger;
  const value = String(e.value ?? "").trim();
  const note = e.note ? String(e.note).trim() : null;
  const warnings = [];
  const row = { bucket: inst.id, var: inst.vars[0] || inst.id, entry: inst.kind === "ai" ? "ai" : "fact", tier: "C", date: e.date || null, note };

  if (e.none) {
    // a searched-and-empty entry: what was searched is the evidence
    const searched = String(e.none === true ? note || "" : e.none).trim();
    if (!searched) throw new Error('a "none found" entry says what was searched: --none "tool and exact query"');
    Object.assign(row, { value: "None found", grade: "n", note: searched, url: HTTP.test(e.url || "") ? e.url : null });
  } else if (inst.kind === "ai") {
    if (!value) throw new Error("an AI entry needs --value (the judgement text)");
    const cites = String(Array.isArray(e.cites) ? e.cites.join(",") : e.cites || "").split(/[,\s]+/).filter(Boolean);
    if (!cites.length) throw new Error(`AI slot "${inst.label}" must cite the ledger ids it rests on: --cites L-0003,${home === COMPANY_LEDGER ? "<person>/" : ""}L-0007`);
    const missing = cites.filter((c) => !resolveRef(ledgers, c, home));
    if (missing.length) throw new Error(`not in any ledger: ${missing.join(", ")} (cite "<ledger>/L-0001", or a bare L-0001 from ${home})`);
    const ai = cites.filter((c) => resolveRef(ledgers, c, home).entry === "ai");
    if (ai.length) throw new Error(`${ai.join(", ")} are AI entries, not evidence: cite the ledger rows they rest on`);
    const qualified = cites.map((c) => resolveRef(ledgers, c, home).ref);
    Object.assign(row, { value, grade: "i", cites: qualified, url: HTTP.test(e.url || "") ? e.url : null });
  } else {
    if (!value) throw new Error("an entry needs --value");
    if (!HTTP.test(e.url || "")) throw new Error(`every line is cited: --url https://... (or --none "what was searched" when nothing was found)`);
    // The agent may only ask; code decides. Weak when the agent says identity is not confirmed.
    Object.assign(row, { value, url: e.url, claim: e.weak ? "w" : "v", grade: e.weak ? "w" : "v" });
    if (e.grade && !["v", "p", "w", "i"].includes(e.grade)) warnings.push(`grade "${e.grade}" ignored`);
    if (e.grade === "i") Object.assign(row, { claim: "i", grade: "i" });
  }

  const dir = join(roomDir, "work", "osint", home);
  const schema = loadVariables();
  const ledger = makeLedger(dir, schema.variables);
  const added = ledger.add("agent", row);
  if (!added) throw new Error("nothing to add");
  const subject = ledgers[home]?.subject || Object.values(ledgers).find((L) => L.subject)?.subject || { name: null, company: sel.intake.company, domain: sel.intake.domain };
  const context = Object.values(ledgers).filter((L) => L.name !== home && (inst.scope === "company" || L.name === COMPANY_LEDGER)).flatMap((L) => L.rows);
  regrade(ledger, { subject: { ...subject, domain: subject.domain || sel.intake.domain }, context });
  syncOsintJson(dir, ledger.rows);
  return { row: ledger.rows.find((r) => r.id === added.id), bucket: inst, ledger: home, warnings };
}

/** Keep osint.json (and the dossier, when there is one) in step with the ledger. */
export function syncOsintJson(dir, rows) {
  const file = join(dir, "osint.json");
  if (!existsSync(file)) return;
  try {
    const result = JSON.parse(readFileSync(file, "utf8"));
    result.rows = rows;
    writeFileSync(file, JSON.stringify(result, null, 1));
  } catch {
    // an unreadable osint.json is left alone; the ledger is the record
  }
}
