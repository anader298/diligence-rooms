// The one shape every connector returns, whatever the provider sends back.
//
//   person  { names[], titles[{title, company, from, to}], education[{school, degree, from, to}],
//             locationCity, socials[{platform, url, handle}],
//             contacts[{type: "email"|"phone"|"address", value, kind: "work"|"personal"|"unknown",
//                       phoneType?: "direct"|"office"|"mobile"|"home"|"other", source{provider, fetchedAt, recordId}}],
//             seniority, departments[], source{provider, fetchedAt, recordId, note} }
//   company { legalName, domains[], industry, headcount, revenue,
//             funding[{round, date, amount, investors[]}], techStack[], jobPostings[{title, date, url}],
//             parent, subsidiaries[], addresses[{value, role: "registered"|"principal office"|"mailing"|"other", source}], source }
//
// Every email, phone and address a provider or an own export returns is kept and labelled:
// kind says whether the provider (or a webmail domain) marks it work or personal. In small and
// owner-run firms the personal email, mobile or home address is often the business contact of
// record; the merge step (merge.mjs) checks each one against the company's own records (website,
// state registry, SEC/ADV/Form D/990, UCC, domain WHOIS) and marks a match sameAsBusiness.
// A "city" that looks like a street address is kept as an address contact, not dropped.
//
// Boundaries that remain: public or licensed sources only, nothing on minors, no real-time
// location, no breached or leaked data. Adapters never read breach dumps or location pings.
//
// Grading (STANDARD.md sec. 9): every connector value is graded "partly" (licensed, not
// yet confirmed at a public source). Two providers agreeing is still "partly". Only the
// research stage, by reading a public source, can make it "verified".

export const CONNECTOR_GRADE = "partly";
export const GRADING_RULE =
  "A value from a connector is graded partly (licensed data, not yet confirmed at a public source). Two independent providers agreeing is still partly. Only a public source read in the research stage makes it verified.";

export const PERSON_FIELDS = ["names", "titles", "education", "locationCity", "socials", "contacts", "seniority", "departments"];
export const COMPANY_FIELDS = ["legalName", "domains", "industry", "headcount", "revenue", "funding", "techStack", "jobPostings", "parent", "subsidiaries", "addresses"];

/** Webmail domains: an untyped address here is labelled kind "personal" (kept, not dropped). */
export const PERSONAL_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "ymail.com", "hotmail.com", "hotmail.co.uk", "outlook.com", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.de", "gmx.net", "web.de", "mail.com",
  "yandex.com", "yandex.ru", "zoho.com", "fastmail.com", "hey.com", "qq.com", "163.com", "126.com", "comcast.net", "verizon.net", "att.net",
]);

const PHONE_TYPES = [
  ["direct", /^(work[_ -]?direct|direct|direct[_ -]?dial)$/i],
  ["office", /^(work|work[_ -]?hq|hq|office|company|switchboard|main|business)$/i],
  ["mobile", /^(mobile|cell|cellular|mobile[_ -]?phone|personal[_ -]?mobile|work[_ -]?mobile)$/i],
  ["home", /^(home|home[_ -]?phone|residence|residential|landline)$/i],
];
const WORK_KIND = /^(work|business|professional|company|corporate|office|direct)$/i;
const PERSONAL_KIND = /^(personal|private|home|residential|residence)$/i;

const s = (x) => (x == null ? "" : String(x).replace(/\s+/g, " ").trim());
const orNull = (x) => s(x) || null;
const arr = (x) => (Array.isArray(x) ? x : x == null || x === "" ? [] : [x]);
export const norm = (x) => s(x).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** "2021-03-15", "2021-03", "2021", "03/2021", 1615766400000 -> "2021-03" or "2021"; anything else -> null. */
export function ym(d) {
  if (d == null || d === "") return null;
  if (typeof d === "number") return new Date(d).toISOString().slice(0, 7);
  const t = s(d);
  let m;
  if ((m = t.match(/^(\d{4})-(\d{1,2})/))) return `${m[1]}-${m[2].padStart(2, "0")}`;
  if ((m = t.match(/^(\d{1,2})\/(\d{4})$/))) return `${m[2]}-${m[1].padStart(2, "0")}`;
  if ((m = t.match(/^(\d{1,2})\/\d{1,2}\/(\d{4})$/))) return `${m[2]}-${m[1].padStart(2, "0")}`;
  if ((m = t.match(/^([A-Za-z]{3})[a-z]* (\d{4})$/))) {
    const i = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m[1].toLowerCase());
    if (i >= 0) return `${m[2]}-${String(i + 1).padStart(2, "0")}`;
  }
  if ((m = t.match(/^(\d{4})$/))) return m[1];
  return null;
}

const PLATFORMS = [
  ["linkedin", /linkedin\.com/i],
  ["x", /(twitter\.com|x\.com)/i],
  ["github", /github\.com/i],
  ["facebook", /facebook\.com/i],
  ["instagram", /instagram\.com/i],
  ["youtube", /youtube\.com/i],
  ["crunchbase", /crunchbase\.com/i],
  ["angellist", /(angel\.co|wellfound\.com)/i],
];

export function social(url, platform) {
  let u = s(url);
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = "https://" + u.replace(/^\/+/, "");
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    return null;
  }
  // The hostname decides the platform; a provider's own label ("linkedin.com", "LINKEDIN") is the fallback.
  const p = (PLATFORMS.find(([, re]) => re.test(parsed.hostname)) || [])[0] || s(platform).toLowerCase().replace(/\.com$/, "") || "web";
  const parts = parsed.pathname.split("/").filter(Boolean);
  const handle = parts.length ? parts[parts.length - 1] : null;
  return { platform: p === "twitter" ? "x" : p, url: parsed.origin + parsed.pathname.replace(/\/+$/, ""), handle };
}

const kindOf = (t) => (WORK_KIND.test(t) ? "work" : PERSONAL_KIND.test(t) ? "personal" : null);

/** Emails as contacts. A typed address keeps the provider's label; an untyped webmail address is personal; anything else unknown. */
export function emailContacts(list, kind) {
  const out = [];
  for (const e of arr(list)) {
    const value = s(typeof e === "object" && e ? e.email ?? e.address ?? e.value : e).toLowerCase();
    const m = value.match(/^[^@\s]+@([^@\s]+\.[^@\s]+)$/);
    if (!m || out.some((x) => x.value === value)) continue;
    const typed = kindOf(s(typeof e === "object" && e ? e.kind ?? e.type : "")) || kind;
    out.push({ type: "email", value, kind: typed || (PERSONAL_EMAIL_DOMAINS.has(m[1]) ? "personal" : "unknown") });
  }
  return out;
}

/** Phones as contacts: [{number, type}] or bare strings. Direct and office lines are work, home is personal, mobile and untyped are unknown. */
export function phoneContacts(list) {
  const out = [];
  for (const p of arr(list)) {
    const o = p && typeof p === "object" ? p : { number: p };
    const value = s(o.number ?? o.sanitized_number ?? o.raw_number ?? o.phone ?? o.value);
    if (!value || out.some((x) => x.value === value)) continue;
    const type = s(o.type ?? o.type_cd ?? o.kind);
    const phoneType = (PHONE_TYPES.find(([, re]) => re.test(type)) || ["other"])[0];
    const kind = /personal|private/i.test(type) || phoneType === "home" ? "personal" : phoneType === "direct" || phoneType === "office" ? "work" : "unknown";
    out.push({ type: "phone", value, kind, phoneType });
  }
  return out;
}

/** An address object or string -> one line. */
export function addressLine(a) {
  if (!a) return "";
  if (typeof a !== "object") return s(a);
  if (a.value || a.address) return s(a.value || a.address);
  return [a.street ?? a.street_address ?? a.line1, a.line2, a.city, [a.state, a.postalCode ?? a.postal_code ?? a.zip].filter(Boolean).join(" "), a.country].map(s).filter(Boolean).join(", ");
}

/** Addresses as contacts: strings or {value | street, city, ..., type}. */
export function addressContacts(list) {
  const out = [];
  for (const a of arr(list)) {
    const value = addressLine(a);
    if (!value || out.some((x) => norm(x.value) === norm(value))) continue;
    out.push({ type: "address", value, kind: kindOf(s(typeof a === "object" && a ? a.kind ?? a.type : "")) || "unknown" });
  }
  return out;
}

const looksLikeStreet = (c) => /\d/.test(c) || /\b(street|st\.|road|rd\.|avenue|ave\.|lane|drive|blvd|suite|apt|po box)\b/i.test(c);

/** A city name, or null if it looks like a street address or postcode (makePerson keeps that as an address contact). */
export function cityOnly(x) {
  const c = s(typeof x === "object" && x ? x.city : x).split(",")[0].trim();
  if (!c || looksLikeStreet(c)) return null;
  return c;
}

const ROLES = [
  ["registered", /regist|legal|statutory|agent/i],
  ["principal office", /principal|hq|head ?quarters|head office|main|primary/i],
  ["mailing", /mail|postal|po box/i],
];

/** Company addresses: strings or {value | street, city, ..., role|type}. */
export function companyAddresses(list, source) {
  const out = [];
  for (const a of arr(list)) {
    const value = addressLine(a);
    if (!value || out.some((x) => norm(x.value) === norm(value))) continue;
    const label = s(typeof a === "object" && a ? a.role ?? a.type ?? a.kind : "");
    const role = ROLES.find(([r]) => r === label)?.[0] || (ROLES.find(([, re]) => re.test(label)) || ["other"])[0];
    out.push({ value, role, source: source ? { provider: source.provider, fetchedAt: source.fetchedAt, recordId: source.recordId } : null });
  }
  return out;
}

const uniqBy = (list, key) => {
  const seen = new Set();
  return list.filter((x) => {
    const k = key(x);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

export function makeSource(provider, recordId, fetchedAt, note) {
  return { provider, fetchedAt: fetchedAt || new Date().toISOString(), recordId: recordId == null || recordId === "" ? null : String(recordId), ...(note ? { note } : {}) };
}

/**
 * Build a person in the normalised shape. `p` may hold: names[] (or name), titles[], education[],
 * locationCity (or city), socials[] (urls or {platform,url}), emails[] (strings or {email, type}),
 * personalEmails[], phones[{number,type}] or strings, addresses[] (strings or {street, city, ..., type}),
 * seniority, departments[]. Every email, phone and address is kept as a labelled contact.
 */
export function makeContacts(p = {}, source) {
  const city = s(typeof (p.locationCity ?? p.city) === "object" ? (p.locationCity ?? p.city)?.city : p.locationCity ?? p.city);
  const streetCity = city && looksLikeStreet(city.split(",")[0]) ? [city] : [];
  const list = [
    ...arr(p.contacts).filter((c) => c && c.type && c.value).map((c) => ({ type: c.type, value: s(c.value), kind: c.kind || "unknown", ...(c.phoneType ? { phoneType: c.phoneType } : {}) })),
    ...emailContacts(p.emails),
    ...emailContacts(p.personalEmails, "personal"),
    ...phoneContacts(p.phones),
    ...addressContacts([...arr(p.addresses), ...streetCity]),
  ];
  const src = source ? { provider: source.provider, fetchedAt: source.fetchedAt, recordId: source.recordId } : null;
  return uniqBy(list, (c) => `${c.type}|${contactKey(c)}`).map((c) => ({ ...c, source: src }));
}

/** The comparable form of a contact value: lowercased email, last 10 digits of a phone, a normalised address. */
export function contactKey(c) {
  if (c.type === "email") return s(c.value).toLowerCase();
  if (c.type === "phone") return s(c.value).replace(/\D/g, "").slice(-10);
  return addressKey(c.value);
}

const ABBR = { st: "street", rd: "road", ave: "avenue", av: "avenue", blvd: "boulevard", dr: "drive", ln: "lane", ste: "suite", fl: "floor", pkwy: "parkway", hwy: "highway", ct: "court", pl: "place", sq: "square", n: "north", s: "south", e: "east", w: "west" };
/** "12 Elm St., Suite 4, Boston, MA 02139" -> "12 elm street suite 4 boston ma 02139" */
export function addressKey(v) {
  return norm(v).split(" ").map((w) => ABBR[w] || w).join(" ");
}

export function makePerson(p = {}, source) {
  const titles = uniqBy(
    arr(p.titles)
      .map((t) => ({ title: orNull(t.title), company: orNull(t.company), from: ym(t.from), to: t.current === true ? null : ym(t.to) }))
      .filter((t) => t.title || t.company),
    (t) => `${norm(t.title)}|${norm(t.company)}|${t.from}|${t.to}`,
  );
  const education = uniqBy(
    arr(p.education)
      .map((e) => ({ school: orNull(e.school), degree: orNull(e.degree), from: ym(e.from), to: ym(e.to) }))
      .filter((e) => e.school),
    (e) => `${norm(e.school)}|${norm(e.degree)}`,
  );
  const socials = uniqBy(
    arr(p.socials)
      .map((x) => (typeof x === "string" ? social(x) : x && social(x.url, x.platform)))
      .filter(Boolean),
    (x) => x.url.toLowerCase(),
  );
  return {
    names: [...new Set(arr(p.names ?? p.name).map(s).filter(Boolean))],
    titles,
    education,
    locationCity: cityOnly(p.locationCity ?? p.city),
    socials,
    contacts: makeContacts(p, source),
    seniority: orNull(p.seniority),
    departments: [...new Set(arr(p.departments).map(s).filter(Boolean))],
    source,
  };
}

const num = (x) => {
  if (x == null || x === "") return null;
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  const t = s(x).replace(/[$,\s]/g, "");
  const m = t.match(/^(\d+(?:\.\d+)?)([kmb])?$/i);
  if (!m) return null;
  return Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] || "").toLowerCase()] || 1);
};

/** A headcount as a number, or a range string "101-250" when that is all the provider gives. */
export function headcount(x) {
  const n = num(x);
  if (n != null) return Math.round(n);
  const t = s(x);
  const m = t.match(/(\d[\d,]*)\D+(\d[\d,]*)/);
  if (m) return `${Number(m[1].replace(/,/g, ""))}-${Number(m[2].replace(/,/g, ""))}`;
  const plus = t.match(/(\d[\d,]*)\s*\+/);
  return plus ? `${Number(plus[1].replace(/,/g, ""))}+` : null;
}

export function domain(x) {
  const t = s(x).toLowerCase();
  if (!t) return null;
  try {
    return new URL(/^https?:\/\//.test(t) ? t : "https://" + t).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** Build a company in the normalised shape. Revenue is a number (USD) when numeric, else the provider's range text. */
export function makeCompany(c = {}, source) {
  return {
    legalName: orNull(c.legalName ?? c.name),
    domains: [...new Set(arr(c.domains ?? c.domain).map(domain).filter(Boolean))],
    industry: orNull(c.industry),
    headcount: headcount(c.headcount),
    revenue: num(c.revenue) ?? orNull(c.revenue),
    funding: uniqBy(
      arr(c.funding).map((f) => ({
        round: orNull(f.round),
        date: f.date ? s(f.date).slice(0, 10) : null,
        amount: num(f.amount),
        investors: [...new Set(arr(typeof f.investors === "string" ? f.investors.split(/[;,]/) : f.investors).map((i) => s(typeof i === "object" && i ? i.name ?? i.value : i)).filter(Boolean))],
      })).filter((f) => f.round || f.date || f.amount != null),
      (f) => `${f.date}|${norm(f.round)}`,
    ),
    techStack: [...new Set(arr(c.techStack).map((t) => s(typeof t === "object" && t ? t.name : t)).filter(Boolean))],
    jobPostings: uniqBy(
      arr(c.jobPostings).map((j) => ({ title: orNull(j.title), date: j.date ? s(j.date).slice(0, 10) : null, url: orNull(j.url) })).filter((j) => j.title),
      (j) => j.url || `${norm(j.title)}|${j.date}`,
    ),
    parent: orNull(c.parent),
    subsidiaries: [...new Set(arr(c.subsidiaries).map(s).filter(Boolean))],
    addresses: companyAddresses(c.addresses ?? c.address, source),
    source,
  };
}

/** How many schema fields hold something. */
export function filledFields(rec, fields) {
  if (!rec) return [];
  return fields.filter((f) => (Array.isArray(rec[f]) ? rec[f].length > 0 : rec[f] != null && rec[f] !== ""));
}

/** "Jane van der Berg" -> { first: "Jane", last: "van der Berg" } */
export function splitName(name) {
  const parts = s(name).split(" ");
  return { first: parts[0] || "", last: parts.slice(1).join(" ") };
}
