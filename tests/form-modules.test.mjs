// Every OSINT module declares the ledger variables it fills; the form relies on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadModules, moduleVars } from "../scripts/osint/run.mjs";

const DIR = join(import.meta.dirname, "..", "scripts", "osint", "modules");

test("modules: every module declares vars, and every var it adds by name is declared", async () => {
  const mods = await loadModules();
  assert.ok(mods.length >= 50);
  for (const m of mods) {
    assert.ok(Array.isArray(m.vars) && m.vars.length, `${m.id} declares vars`);
    for (const v of m.vars) assert.match(v, /^[a-z_]+\.[a-z_]+$/, `${m.id}: ${v}`);
  }
  // single-module files: each literal var the code adds or misses is in the declaration
  const byFile = {};
  for (const f of readdirSync(DIR).filter((f) => f.endsWith(".mjs"))) {
    const src = readFileSync(join(DIR, f), "utf8");
    const ids = [...src.matchAll(/^\s*id: "([^"]+)",\s*$/gm)].map((x) => x[1]).filter((id) => mods.some((m) => m.id === id));
    if (ids.length !== 1) continue;
    const declared = new Set(mods.find((m) => m.id === ids[0]).vars);
    for (const [, v] of src.matchAll(/(?:var: "|miss\(")([a-z_]+\.[a-z_]+)"/g)) assert.ok(declared.has(v), `${f}: ${v} used but not in vars`);
    byFile[f] = ids[0];
  }
  assert.ok(Object.keys(byFile).length >= 40);
  const mv = await moduleVars();
  assert.ok(mv.sec.includes("co.filings") && mv["sec-person"].includes("money.trades"));
});
