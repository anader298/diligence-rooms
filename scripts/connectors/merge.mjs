// Merge every provider's records into one set of leads with per-field provenance, and list
// where providers disagree. Nothing here is a fact: every field carries grade "partly" until
// the research stage confirms it at a public source (STANDARD.md sec. 9).
import { PERSON_FIELDS, COMPANY_FIELDS, CONNECTOR_GRADE, GRADING_RULE, norm, filledFields, contactKey, addressKey } from "./schema.mjs";

const SCALARS = new Set(["locationCity", "seniority", "legalName", "industry", "headcount", "revenue", "parent"]);
const KEY = {
  titles: (t) => `${norm(t.title)}|${norm(t.company)}`,
  education: (e) => `${norm(e.school)}|${norm(e.degree)}`,
  socials: (x) => `${x.platform}|${norm(x.handle || x.url)}`,
  funding: (f) => `${f.date || ""}|${norm(f.round)}`,
  jobPostings: (j) => j.url || `${norm(j.title)}|${j.date}`,
  contacts: (c) => `${c.type}|${contactKey(c)}`,
  addresses: (a) => addressKey(a.value),
};
// A contact's own source is carried in sources[]; the merged value keeps type, value, kind, phoneType.
const bare = (v) => {
  if (!v || typeof v !== "object" || !("source" in v)) return v;
  const { source, ...rest } = v;
  return rest;
};
const keyOf = (field, v) => (KEY[field] ? KEY[field](v) : norm(typeof v === "object" ? JSON.stringify(v) : v));
const src = (rec) => ({ provider: rec.source.provider, fetchedAt: rec.source.fetchedAt, recordId: rec.source.recordId });

/** Do two scalar values say the same thing? Headcounts within 10%, or a number inside a range, agree. */
export function sameValue(field, a, b) {
  if (field === "headcount" || field === "revenue") {
    const range = (x) => {
      if (typeof x === "number") return [x, x];
      const m = String(x).match(/(\d+)\D+(\d+)/);
      if (m) return [Number(m[1]), Number(m[2])];
      const p = String(x).match(/(\d+)\s*\+/);
      return p ? [Number(p[1]), Infinity] : null;
    };
    const ra = range(a), rb = range(b);
    if (ra && rb) {
      if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 0.1 * Math.max(a, b);
      return ra[0] <= rb[1] && rb[0] <= ra[1];
    }
  }
  return norm(a) === norm(b);
}

/** records: [{provider, record}] in priority order. Returns { fields, conflicts }. */
export function mergeRecords(records, fields, entity) {
  const recs = records.filter((r) => r.record);
  const out = {};
  const conflicts = [];
  for (const f of fields) {
    if (SCALARS.has(f)) {
      const values = recs.filter((r) => r.record[f] != null && r.record[f] !== "").map((r) => ({ value: r.record[f], ...src(r.record) }));
      if (!values.length) continue;
      const chosen = values[0];
      const agree = values.filter((v) => sameValue(f, v.value, chosen.value));
      out[f] = { value: chosen.value, grade: CONNECTOR_GRADE, providers: agree.map((v) => v.provider), sources: values };
      const groups = [];
      for (const v of values) {
        const g = groups.find((x) => sameValue(f, x[0].value, v.value));
        g ? g.push(v) : groups.push([v]);
      }
      if (groups.length > 1) conflicts.push({ entity, field: f, values: values.map((v) => ({ provider: v.provider, value: v.value })), note: `${groups.length} different values` });
    } else {
      const items = new Map();
      for (const r of recs)
        for (const v of r.record[f] || []) {
          const k = keyOf(f, v);
          const it = items.get(k) || { value: bare(v), grade: CONNECTOR_GRADE, providers: [], sources: [] };
          if (!it.providers.includes(r.provider)) it.providers.push(r.provider), it.sources.push({ ...src(r.record), value: bare(v) });
          // A contact one provider labels work or personal beats another's "unknown"; a disagreement is reported below.
          if (f === "contacts" && it.value.kind === "unknown" && v.kind && v.kind !== "unknown") it.value = { ...it.value, kind: v.kind };
          if (f === "contacts" && !it.value.phoneType && v.phoneType) it.value = { ...it.value, phoneType: v.phoneType };
          // Keep the most complete dates seen; differing dates are reported below.
          if (f === "titles" || f === "education") for (const d of ["from", "to"]) if (!it.value[d] && v[d]) it.value = { ...it.value, [d]: v[d] };
          items.set(k, it);
        }
      if (items.size) out[f] = [...items.values()];
    }
  }

  // Current title: each provider's current roles (no end date). Conflict when two providers share none.
  const current = recs
    .map((r) => ({ provider: r.provider, set: (r.record.titles || []).filter((t) => !t.to).map((t) => `${t.title || ""} @ ${t.company || ""}`) }))
    .filter((x) => x.set.length);
  for (let i = 1; i < current.length; i++) {
    const base = new Set(current[0].set.map(norm));
    if (!current[i].set.some((t) => base.has(norm(t)))) {
      conflicts.push({ entity, field: "titles.current", values: current.map((c) => ({ provider: c.provider, value: c.set.join("; ") })), note: "providers name a different current title or employer" });
      break;
    }
  }
  // Dates: the same title at the same company with different start or end months.
  for (const f of ["titles", "education"])
    for (const it of out[f] || []) {
      const ds = it.sources.map((s) => ({ provider: s.provider, from: s.value.from, to: s.value.to }));
      const differ = (d) => new Set(ds.map((x) => x[d]).filter(Boolean)).size > 1;
      if (ds.length > 1 && (differ("from") || differ("to")))
        conflicts.push({ entity, field: `${f}.dates`, item: f === "titles" ? `${it.value.title || ""} @ ${it.value.company || ""}` : `${it.value.school} ${it.value.degree || ""}`.trim(), values: ds.map((d) => ({ provider: d.provider, value: `${d.from || "?"} to ${d.to || "now"}` })), note: "dates differ" });
    }
  // Contacts: one provider says work, another personal.
  for (const it of out.contacts || []) {
    const kinds = it.sources.map((s) => ({ provider: s.provider, value: s.value.kind })).filter((x) => x.value && x.value !== "unknown");
    if (new Set(kinds.map((k) => k.value)).size > 1) conflicts.push({ entity, field: "contacts.kind", item: it.value.value, values: kinds, note: "providers label this contact differently" });
  }
  // Funding: same round, different amount.
  for (const it of out.funding || []) {
    const amounts = it.sources.map((s) => ({ provider: s.provider, value: s.value.amount })).filter((x) => x.value != null);
    if (new Set(amounts.map((a) => a.value)).size > 1 && !amounts.every((a) => sameValue("revenue", a.value, amounts[0].value)))
      conflicts.push({ entity, field: "funding.amount", item: `${it.value.round || ""} ${it.value.date || ""}`.trim(), values: amounts, note: "amounts differ" });
  }
  return { fields: out, conflicts };
}

// ---------------------------------------------------------------- business of record
//
// In owner-run firms the "personal" email, mobile or home address is often the business contact
// of record. businessRecords are the company's own public records, read in the research stage and
// saved to rooms/<slug>/work/business-records.json:
//   [{ record: "website" | "state registry" | "SEC" | "Form ADV" | "Form D" | "990" | "UCC" | "WHOIS",
//      url, emails[], phones[], addresses[] }]
// A contact (of any kind) whose value matches one of them is marked sameAsBusiness: true, with
// businessRecords naming which record(s) match.
export const BUSINESS_RECORD_TYPES = ["website", "state registry", "SEC", "Form ADV", "Form D", "990", "UCC", "WHOIS"];

const zip = (v) => (String(v).match(/\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)/) || [])[1] || null;
const streetLine = (v) => addressKey(String(v).split(",")[0]);

/** Do two values of one contact type name the same route? Phones by their last 10 digits; addresses by street line (and ZIP when both have one). */
export function sameContact(type, a, b) {
  if (type === "address") {
    const za = zip(a), zb = zip(b);
    if (za && zb && za !== zb) return false;
    const ka = addressKey(a), kb = addressKey(b);
    return ka === kb || (streetLine(a).length > 4 && streetLine(a) === streetLine(b));
  }
  const ka = contactKey({ type, value: a }), kb = contactKey({ type, value: b });
  return !!ka && ka.length >= (type === "phone" ? 7 : 3) && ka === kb;
}

/** The business records a value matches: [{record, url}]. */
export function businessMatches(type, value, businessRecords = []) {
  const list = { email: "emails", phone: "phones", address: "addresses" }[type];
  return (businessRecords || [])
    .filter((r) => (r[list] || []).some((v) => sameContact(type, typeof v === "object" && v ? v.value : v, value)))
    .map((r) => ({ record: r.record, ...(r.url ? { url: r.url } : {}) }));
}

/** Mark merged contacts and company addresses that match a business record. Mutates and returns the merged fields. */
export function markBusinessOfRecord(fields, businessRecords, typeOf = (it) => it.value.type) {
  for (const f of ["contacts", "addresses"])
    for (const it of fields[f] || []) {
      const m = businessMatches(f === "addresses" ? "address" : typeOf(it), it.value.value, businessRecords);
      it.sameAsBusiness = m.length > 0;
      if (m.length) it.businessRecords = m;
    }
  return fields;
}

/**
 * results: [{provider, people:{slug: person|null}, company: company|null}] in priority order.
 * businessRecords: the company's own public contact records (see above), or [].
 * Returns { merged, conflicts }.
 */
export function mergeAll(results, intake, generatedAt = new Date().toISOString(), businessRecords = []) {
  const people = {};
  const conflicts = [];
  for (const p of intake.people || []) {
    const m = mergeRecords(results.map((r) => ({ provider: r.provider, record: r.people?.[p.slug] || null })), PERSON_FIELDS, `person:${p.slug}`);
    markBusinessOfRecord(m.fields, businessRecords);
    people[p.slug] = { name: p.name, fields: m.fields, providers: results.filter((r) => r.people?.[p.slug]).map((r) => r.provider) };
    conflicts.push(...m.conflicts);
  }
  const c = mergeRecords(results.map((r) => ({ provider: r.provider, record: r.company || null })), COMPANY_FIELDS, "company");
  conflicts.push(...c.conflicts);
  markBusinessOfRecord(c.fields, businessRecords);
  const merged = {
    generatedAt,
    counterparty: intake.company || intake.counterparty,
    grading: GRADING_RULE,
    use: "Leads to verify, never facts to copy. Confirm each value at a public source before grading it verified, and cite that source, not the provider.",
    contactsRule: "Every email, phone and address a provider returned is kept with its kind (work, personal, unknown). sameAsBusiness: true means it matches the company's own record (website, state registry, SEC/ADV/Form D/990, UCC or WHOIS), named in businessRecords.",
    businessRecords: (businessRecords || []).map((r) => ({ record: r.record, ...(r.url ? { url: r.url } : {}) })),
    providers: results.map((r) => r.provider),
    people,
    company: { name: intake.company || intake.counterparty, fields: c.fields, providers: results.filter((r) => r.company).map((r) => r.provider) },
  };
  return { merged, conflicts };
}

/** Fields each provider filled, for the data-sources page. */
export function fieldsFilled(result) {
  const person = Object.values(result.people || {}).flatMap((p) => filledFields(p, PERSON_FIELDS).map((f) => "person." + f));
  const company = filledFields(result.company, COMPANY_FIELDS).map((f) => "company." + f);
  return [...new Set([...person, ...company])];
}
