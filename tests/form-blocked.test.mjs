// A call that failed is "couldn't check", never "searched, nothing found": modules mark the miss
// blocked (a structured flag on the miss), and the form reads the flag, not the miss text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOsint } from "../scripts/osint/run.mjs";
import { makeHttp } from "../scripts/osint/core.mjs";
import { computeStates, instances, isBlockedMiss } from "../scripts/lib/form.mjs";
import domainMods from "../scripts/osint/modules/55-domain.mjs";
import secDocs from "../scripts/osint/modules/51-sec-docs.mjs";

const [dns, crtsh] = domainMods;
const quiet = () => {};
const PACK = { id: "t", scope: "company", buckets: [{ id: "co.domains", label: "Domains", page: "who-they-are", group: "g", kind: "list", vars: ["co.domains"] }] };
const SUBJECT = { name: "Pat Doe", company: "Acme Corp", domain: "acme.example" };

/** Run one module against a fake fetch, then compute the co.domains bucket from what it left. */
async function bucketAfter(mod, fetchImpl) {
  const dir = mkdtempSync(join(tmpdir(), "form-blocked-"));
  try {
    const r = await runOsint(SUBJECT, { outDir: dir, modules: [mod], fetchImpl, log: quiet });
    const ledgers = { _company: { name: "_company", rows: r.rows, misses: r.misses, modules: r.modules, ran: true } };
    const [b] = computeStates(instances([PACK]), ledgers, { moduleVars: { [mod.id]: mod.vars } });
    return { b, r };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const json = (obj, status = 200) => async () => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

test("dns: a failed dns.google lookup is couldn't check, not searched and empty", async () => {
  // the network call fails outright
  const down = await bucketAfter(dns, async () => {
    throw new Error("fetch failed");
  });
  assert.equal(down.b.state, "blocked", down.b.why);
  assert.equal(down.r.misses[0].blocked, true);
  assert.equal(down.r.modules[0].status, "blocked");
  // the resolver answers SERVFAIL
  const servfail = await bucketAfter(dns, json({ Status: 2 }));
  assert.equal(servfail.b.state, "blocked", servfail.b.why);
  // control: the resolver answers, and there are no records
  const none = await bucketAfter(dns, json({ Status: 0 }));
  assert.equal(none.b.state, "empty", none.b.why);
  assert.equal(none.r.misses[0].blocked, false);
});

test("crt.sh: a 503 is couldn't check", async () => {
  const { b, r } = await bucketAfter(crtsh, async () => new Response("Service Unavailable", { status: 503 }));
  assert.equal(b.state, "blocked", b.why);
  assert.match(r.misses[0].searched, /HTTP 503/);
  assert.equal(r.misses[0].blocked, true);
});

test("form: the miss flag decides, not its text; ledgers without the flag fall back to the text", () => {
  assert.equal(isBlockedMiss({ searched: "anything at all", blocked: true }), true);
  assert.equal(isBlockedMiss({ searched: "blocked (HTTP 403), unknown", blocked: false }), false);
  // older ledgers: no flag, so the text is read (5xx and "fetch failed" now count)
  assert.equal(isBlockedMiss({ searched: "crt.sh 503 (often slow or overloaded)" }), true);
  assert.equal(isBlockedMiss({ searched: "10-Q fetch failed" }), true);
  assert.equal(isBlockedMiss({ searched: "no MX/TXT records returned for x by dns.google" }), false);
  // a module that ran ok but whose only miss on the var is blocked did not search it
  const ledgers = { _company: { name: "_company", rows: [], misses: [{ module: "dns", var: "co.domains", searched: "x", blocked: true }], modules: [{ id: "dns", status: "partial" }], ran: true } };
  const [b] = computeStates(instances([PACK]), ledgers, { moduleVars: { dns: ["co.domains"] } });
  assert.equal(b.state, "blocked");
});

test("sec-docs: a filing that fails to download is not checked, not 'nothing found'", async () => {
  const misses = [];
  const ctx = {
    subject: SUBJECT,
    shared: { _sec: Promise.resolve({ cik: 1234, filings: [{ form: "10-K", date: "2026-02-01", url: "https://www.sec.gov/Archives/edgar/data/1234/x/10k.htm", items: "", acc: "0001-26-000001", doc: "10k.htm" }] }) },
    http: makeHttp({
      fetchImpl: async () => {
        throw new Error("fetch failed");
      },
    }),
    add: () => null,
    miss: (v, searched, o) => misses.push({ var: v, searched, blocked: o?.blocked === true }),
    status: () => {},
    log: quiet,
  };
  await secDocs.run(ctx);
  const of = (v) => misses.find((m) => m.var === v);
  assert.equal(of("co.segments").blocked, true, of("co.segments").searched);
  assert.equal(of("co.legal").blocked, true, of("co.legal").searched);
  // no 8-K earnings release in the list: that one is a real "none"
  assert.equal(of("co.kpis").blocked, false);
});
