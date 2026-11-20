// bank-cu: for banks and credit unions only. FDIC BankFind (institutions: assets, deposits, net
// income, ROA, branches, holding company) and NCUA (credit unions: assets, members, field of
// membership and the CEO on file). Runs only when the company looks like one: its name, an SEC
// SIC code for banks and thrifts, or a GLEIF name. Keyless; the NCUA mapping API is internal and
// may change, so a failure there is a miss, never fatal.

import { companyBase } from "../resolve.mjs";
import { secBase } from "./50-sec.mjs";
import { normCompany, money } from "../colib.mjs";
import { nameParts, normName, firstForms, isBlocked, blockedMiss } from "../person-lib.mjs";

const BANK_SIC = new Set(["6021", "6022", "6029", "6035", "6036", "6061", "6062", "6099", "6712"]);
const BANK_NAME = /\b(bank|banc|bancorp|bancshares|bankshares|bancorporation|savings|thrift|trust company|financial corp|credit union|fcu|federal credit)\b/i;
export const isCreditUnion = (name) => /\b(credit union|fcu)\b/i.test(String(name || ""));

/** The distinctive words of a bank or credit union name ("Huntington Bancshares Inc" -> "huntington"). */
export function coreName(name) {
  return normCompany(name)
    .replace(/\b(bank|banc|bancorp|bancshares|bankshares|bancorporation|national|association|n a|savings|financial|federal|credit union|fcu|trust|of|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Does the company look like a bank or credit union? Returns the reason, or null. */
export function bankReason(subject, sec = {}, lei = null) {
  if (BANK_NAME.test(subject.company || "")) return `name "${subject.company}"`;
  if (sec?.sub?.sic && BANK_SIC.has(String(sec.sub.sic))) return `SEC SIC ${sec.sub.sic} (${sec.sub.sicDescription})`;
  if (lei?.legalName && BANK_NAME.test(lei.legalName)) return `GLEIF name "${lei.legalName}"`;
  return null;
}

/** FDIC institutions that belong to the company: holding-company name or bank name contains its core words. Largest first. */
export function pickFdic(json, company, holding = null) {
  const core = coreName(company);
  if (!core) return [];
  const has = (s) => (" " + normCompany(s) + " ").includes(" " + core + " ");
  return (json?.data || [])
    .map((d) => d.data)
    .filter((d) => d && (has(d.NAMEHCR || "") || has(d.NAME || "") || (holding && normCompany(d.NAMEHCR) === normCompany(holding))))
    .sort((a, b) => (b.ASSET || 0) - (a.ASSET || 0));
}

const k = (n) => money(Number(n) * 1000); // FDIC reports in thousands of dollars

export default {
  id: "bank-cu",
  label: "Banks and credit unions: FDIC BankFind, NCUA",
  lane: "fast",
  needs: ["company"],
  budgetMs: 12000,
  async run(ctx) {
    const { subject, http } = ctx;
    const [sec, c] = await Promise.all([secBase(ctx).catch(() => ({})), companyBase(ctx).catch(() => ({}))]);
    const why = bankReason(subject, sec, c.leiRecord);
    if (!why) return ctx.miss("co.facts", `FDIC / NCUA not checked: "${subject.company}" does not look like a bank or credit union (name, SEC SIC, GLEIF)`);
    const core = coreName(subject.company);
    if (isCreditUnion(subject.company) || isCreditUnion(c.leiRecord?.legalName)) {
      const s = await http.json("https://mapping.ncua.gov/api/Search/GetSearchLocations", { method: "POST", body: JSON.stringify({ searchText: subject.company, rdSearchType: "cuname", skip: 0, take: 10, sort_by: "", sort_order: "", is_mainOffice: true }), headers: { "content-type": "application/json" }, timeout: 8000 });
      if (!s.ok) return isBlocked(s) ? blockedMiss(ctx, "co.facts", "NCUA credit union search", s, "retry later") : ctx.miss("co.facts", `NCUA search: HTTP ${s.status || s.error}`);
      const hit = (s.data?.list || []).find((x) => (" " + normCompany(x.creditUnionName) + " ").includes(" " + core + " ") && x.isMainOffice) || (s.data?.list || [])[0];
      if (!hit) return ctx.miss("co.facts", `NCUA: no credit union named like "${subject.company}"`);
      const d = await http.json(`https://mapping.ncua.gov/api/CreditUnionDetails/GetCreditUnionDetails/${hit.creditUnionNumber}`, { timeout: 8000 });
      const x = d.data || {};
      const url = `https://mapping.ncua.gov/ResearchCreditUnion?cuNumber=${hit.creditUnionNumber}`;
      ctx.add({ var: "co.facts", value: `NCUA: ${x.creditUnionName || hit.creditUnionName}, charter ${hit.creditUnionNumber} (${x.creditUnionType || "?"}, ${x.creditUnionStatus || "?"}), assets ${x.assetsFormatted || "?"}, ${x.membersFormatted || "?"} members, chartered ${x.creditUnionYear || "?"}; field of membership ${x.creditUnionFom || "?"}; ${x.creditUnionCity || hit.city}, ${x.creditUnionState || hit.state}`, url, grade: "v", tier: "A", anchors: ["company"], detail: { source: "ncua", charter: hit.creditUnionNumber, ...Object.fromEntries(Object.entries(x).filter(([key]) => /^creditUnion|Formatted$/.test(key))) } });
      if (x.creditUnionCeo) {
        ctx.add({ var: "co.leadership", value: `CEO on file with NCUA: ${x.creditUnionCeo}`, url, grade: "v", tier: "A", anchors: ["company"], detail: { source: "ncua" } });
        const { first, last } = nameParts(subject.name || "");
        const ceo = normName(x.creditUnionCeo).split(" ");
        if (last && ceo.at(-1) === last && firstForms(first).includes(ceo[0])) ctx.add({ var: "role.title", value: `CEO of ${x.creditUnionName} (NCUA record)`, url, grade: "v", tier: "A", anchors: ["name", "company"] });
      }
      return;
    }
    const fields = "NAME,CERT,ASSET,DEP,NETINC,ROA,ROE,OFFDOM,CITY,STNAME,NAMEHCR,ESTYMD,REPDTE,WEBADDR,ACTIVE";
    const r = await http.json(`https://api.fdic.gov/banks/institutions?search=${encodeURIComponent(`NAME:${core}`)}&filters=ACTIVE:1&fields=${fields}&sort_by=ASSET&sort_order=DESC&limit=25`, { timeout: 8000 });
    if (!r.ok) return isBlocked(r) ? blockedMiss(ctx, "co.facts", "FDIC BankFind", r, "retry later") : ctx.miss("co.facts", `FDIC BankFind: HTTP ${r.status || r.error}`);
    const banks = pickFdic(r.data, subject.company, sec?.title || null);
    if (!banks.length) return ctx.miss("co.facts", `FDIC BankFind: no active FDIC-insured institution named like "${subject.company}" (checked because of ${why})`);
    const top = banks[0];
    const total = banks.reduce((a, b) => a + (b.ASSET || 0), 0);
    ctx.add({
      var: "co.facts",
      value: `FDIC: ${top.NAME} (cert ${top.CERT}${top.NAMEHCR ? `, holding company ${top.NAMEHCR}` : ""}), assets ${k(top.ASSET)}, deposits ${k(top.DEP)}, net income ${k(top.NETINC)} year to date, ROA ${top.ROA != null ? Number(top.ROA).toFixed(2) + "%" : "?"}, ${top.OFFDOM ?? "?"} domestic offices, report date ${top.REPDTE}; established ${top.ESTYMD}; ${top.CITY}, ${top.STNAME}${banks.length > 1 ? `; ${banks.length} insured banks in the group, ${k(total)} total assets` : ""}`,
      url: `https://banks.data.fdic.gov/bankfind-suite/bankfind/details/${top.CERT}`,
      grade: "v",
      tier: "A",
      anchors: ["company"],
      date: top.REPDTE ? top.REPDTE.replace(/(\d\d)\/(\d\d)\/(\d{4})/, "$3-$1-$2") : null,
      detail: { source: "fdic", reason: why, banks: banks.slice(0, 10) },
    });
  },
};
