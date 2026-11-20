// One canonical company record for every module that needs more than the name: SEC CIK (via the
// sec module's memoised lookup), GLEIF LEI with legal address and country, and the Wikidata QID.
// Memoised per run in shared._company, so company-resolve, registries, intl-registries and bank-cu
// all await the same three calls.

import { normCompany } from "./colib.mjs";
import { secBase } from "./modules/50-sec.mjs";

const GLEIF = "https://api.gleif.org/api/v1";
const WD = "https://www.wikidata.org/w/api.php";

// legal-form suffixes outside the US that colib's normCompany keeps (it is tuned for SEC names)
const FOREIGN = /\b(asa|as|ab|oyj|oy|spa|s p a|bv|b v|sas|sarl|srl|s r l|kgaa|kg|ag|se|nv|pty|bhd|sdn|kk|a s|s a|sa de cv|sab de cv|ltda|plc)\b/g;
const normCo = (s) => normCompany(s).replace(FOREIGN, " ").replace(/\s+/g, " ").trim();

/** ISO 3166 alpha-2 from a GLEIF jurisdiction ("US-DE") or country code. */
export const countryOf = (s) => (String(s || "").match(/^[A-Z]{2}/) || [null])[0];

/**
 * Pick the LEI record for a company from a GLEIF lei-records page. Exact normalised legal name
 * first, then other names; issued and active beat lapsed; the subject's country, if known, breaks
 * ties; and a record with children (the group parent) beats a subsidiary with the same name.
 */
export function pickLei(data, names, country = null) {
  const want = [...new Set(names.filter(Boolean).map(normCo))].filter(Boolean);
  if (!want.length) return null;
  let best = null;
  for (const d of data || []) {
    const e = d.attributes?.entity || {};
    const all = [e.legalName?.name, ...(e.otherNames || []).map((o) => o.name), ...(e.transliteratedOtherNames || []).map((o) => o.name)].filter(Boolean).map(normCo);
    const exact = want.some((w) => w === normCo(e.legalName?.name));
    const other = !exact && want.some((w) => all.includes(w));
    if (!exact && !other) continue;
    let score = exact ? 10 : 6;
    if (d.attributes?.registration?.status === "ISSUED") score += 2;
    if (e.status === "ACTIVE") score += 1;
    if (country && countryOf(e.legalAddress?.country) === country) score += 2;
    if (d.relationships?.["direct-children"]) score += 1;
    if (/\b(plan|trust|fund|etf|401)\b/i.test(e.legalName?.name || "")) score -= 6;
    if (!best || score > best.score) best = { score, d };
  }
  return best ? best.d : null;
}

/** Short record from a GLEIF lei-record. */
export function leiSummary(d) {
  if (!d) return null;
  const e = d.attributes.entity;
  const a = e.legalAddress || {};
  const h = e.headquartersAddress || {};
  return {
    lei: d.id,
    legalName: e.legalName?.name,
    country: countryOf(a.country),
    jurisdiction: e.jurisdiction || null,
    legalForm: e.legalForm?.other || null,
    status: e.status,
    registration: d.attributes.registration?.status,
    registeredAs: e.registeredAs || null,
    registeredAt: e.registeredAt?.id || null,
    created: e.creationDate ? String(e.creationDate).slice(0, 10) : null,
    legalAddress: [a.addressLines?.join(" "), a.city, a.region, a.postalCode, a.country].filter(Boolean).join(", "),
    hqAddress: [h.addressLines?.join(" "), h.city, h.region, h.postalCode, h.country].filter(Boolean).join(", "),
    hasChildren: !!d.relationships?.["direct-children"],
  };
}

/** The Wikidata item for a company from wbsearchentities results, or null. */
export function pickQid(search, names) {
  const want = names.filter(Boolean).map(normCo);
  const isCo = (x) => /(company|corporation|manufacturer|business|enterprise|firm|developer|provider|startup|maker|software|bank|retailer|conglomerate|organi[sz]ation|group|airline|insurer)/i.test(x.description || "");
  return (search || []).find((x) => isCo(x) && want.includes(normCo(x.label))) || (search || []).find((x) => isCo(x) && want.some((w) => normCo(x.label).startsWith(w))) || null;
}

export function companyBase(ctx) {
  ctx.shared._company ??= (async () => {
    const { subject, http, shared } = ctx;
    const out = { name: subject.company, country: subject.country || null, cik: null, ticker: null, secName: null, lei: null, leiRecord: null, qid: null, sources: [] };
    const sec = await secBase(ctx).catch(() => ({}));
    if (sec?.cik) Object.assign(out, { cik: sec.cik, ticker: sec.ticker, secName: shared.secName || sec.title });
    const names = [subject.company, out.secName].filter(Boolean);
    const q = out.secName || subject.company;
    const [g, w] = await Promise.all([
      http.json(`${GLEIF}/lei-records?filter[entity.legalName]=${encodeURIComponent(q)}&page[size]=10`, { timeout: 8000, headers: { accept: "application/vnd.api+json" } }),
      http.json(`${WD}?action=wbsearchentities&search=${encodeURIComponent(subject.company)}&language=en&type=item&limit=7&format=json`, { timeout: 6000 }),
    ]);
    out.gleifStatus = g.status || g.error;
    let rec = pickLei(g.data?.data, names, out.country || (out.cik ? "US" : null));
    if (!rec && g.ok && out.secName && out.secName !== subject.company) {
      const g2 = await http.json(`${GLEIF}/lei-records?filter[entity.legalName]=${encodeURIComponent(subject.company)}&page[size]=10`, { timeout: 8000, headers: { accept: "application/vnd.api+json" } });
      rec = pickLei(g2.data?.data, names, out.country || "US");
    }
    if (rec) {
      out.leiRecord = leiSummary(rec);
      out.lei = rec.id;
      out.country ||= out.leiRecord.country;
      out.sources.push("gleif");
    }
    const qid = pickQid(w.data?.search, names);
    if (qid) {
      out.qid = qid.id;
      out.qidLabel = qid.label;
      out.qidDescription = qid.description || null;
      out.sources.push("wikidata");
    }
    if (out.cik) {
      out.sources.push("sec");
      out.country ||= "US";
    }
    Object.assign(shared, { lei: out.lei, companyQid: out.qid, companyCountry: out.country });
    return out;
  })();
  return ctx.shared._company;
}
