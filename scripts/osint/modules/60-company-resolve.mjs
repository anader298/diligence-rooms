// company-resolve: one canonical record (SEC CIK and ticker, GLEIF LEI with legal address and
// country, Wikidata QID) that the registry, bank and international modules build on. Keyless.
// GLEIF data is CC0; Wikidata CC0; SEC public.

import { companyBase } from "../resolve.mjs";

export default {
  id: "company-resolve",
  /** The ledger variables this module fills (config/form buckets read them to say "no tool yet"). */
  vars: ["co.identifiers", "co.registry"],
  label: "Company identifiers: SEC CIK, GLEIF LEI, Wikidata QID",
  lane: "fast",
  needs: ["company"],
  budgetMs: 15000,
  async run(ctx) {
    const c = await companyBase(ctx);
    const parts = [];
    if (c.cik) parts.push(`SEC CIK ${c.cik}${c.ticker ? ` (${c.ticker})` : ""}`);
    if (c.lei) parts.push(`LEI ${c.lei}`);
    if (c.qid) parts.push(`Wikidata ${c.qid}`);
    if (!parts.length) {
      if (c.gleifStatus && c.gleifStatus !== 200) ctx.status("partial", `GLEIF ${c.gleifStatus}`);
      return ctx.miss("co.identifiers", `no SEC registrant, GLEIF LEI or Wikidata company item named "${ctx.subject.company}"${c.gleifStatus && c.gleifStatus !== 200 ? ` (GLEIF answered ${c.gleifStatus}: unknown)` : ""}`);
    }
    const r = c.leiRecord;
    ctx.add({
      var: "co.identifiers",
      value: `${c.secName || r?.legalName || ctx.subject.company}: ${parts.join(" · ")}${r ? ` · ${r.legalForm ? r.legalForm + ", " : ""}${r.jurisdiction || r.country}` : ""}`,
      url: c.lei ? `https://search.gleif.org/#/record/${c.lei}` : c.cik ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${c.cik}` : `https://www.wikidata.org/wiki/${c.qid}`,
      grade: c.lei && c.cik ? "v" : c.lei || c.cik ? "v" : "p",
      tier: "A",
      anchors: c.sources,
      detail: { cik: c.cik, ticker: c.ticker, lei: c.lei, qid: c.qid, qidDescription: c.qidDescription || null, country: c.country, gleif: r },
    });
    if (r) {
      ctx.add({
        var: "co.registry",
        value: `GLEIF: ${r.legalName}, ${r.status?.toLowerCase()} entity, LEI ${r.registration?.toLowerCase()}; legal address ${r.legalAddress}${r.hqAddress && r.hqAddress !== r.legalAddress ? `; HQ ${r.hqAddress}` : ""}${r.registeredAs ? `; registered as ${r.registeredAs}` : ""}${r.created ? `; formed ${r.created}` : ""}`,
        url: `https://search.gleif.org/#/record/${c.lei}`,
        grade: "v",
        tier: "A",
        date: r.created,
        detail: r,
      });
    }
  },
};
