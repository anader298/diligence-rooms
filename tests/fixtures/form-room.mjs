// A synthetic room for the form tests: Jane Doe at Acme Freight (fictional), with her ledger.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A synthetic room: Jane Doe at Acme Freight, with her scripted ledger. */
export function fixtureRoom(base, { rows = [], misses = [], modules = [], intake = {}, company = null, ran = true } = {}) {
  const dir = join(base, "rooms", "acme");
  mkdirSync(join(dir, "pages"), { recursive: true });
  writeFileSync(join(dir, "room.json"), JSON.stringify({ slug: "acme", title: "Acme Freight", counterparty: "Acme Freight", people: [{ name: "Jane Doe", slug: "jane-doe" }], sections: [{ id: "start", title: "Start here", pages: [{ id: "one-card", title: "The one card" }] }] }));
  writeFileSync(join(dir, "intake.json"), JSON.stringify({ company: "Acme Freight", domain: "acme-freight.example", goal: "pitch a routing contract", modes: ["pitch"], orgType: "startup", people: [{ name: "Jane Doe", slug: "jane-doe" }], meetingDate: "2026-12-01", ...intake }));
  const d = join(dir, "work", "osint", "jane-doe");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "ledger.jsonl"), rows.map((r, i) => JSON.stringify({ id: `L-${String(i + 1).padStart(4, "0")}`, module: "x", tier: "A", ...r })).join("\n") + (rows.length ? "\n" : ""));
  if (ran) writeFileSync(join(d, "osint.json"), JSON.stringify({ subject: { name: "Jane Doe", company: "Acme Freight", domain: "acme-freight.example" }, misses, modules, rows: [] }));
  if (company) {
    mkdirSync(join(dir, "work", "osint", "_company"), { recursive: true });
    writeFileSync(join(dir, "work", "osint", "_company", "ledger.jsonl"), company.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  return dir;
}
