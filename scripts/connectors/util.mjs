// Shared helpers for the adapters: one HTTP call shape, a CSV reader, and the
// header aliases the file imports (and Clay's table export) understand.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makePerson, makeCompany, makeSource, norm, domain } from "./schema.mjs";

/**
 * One JSON call through ctx.fetch (injected, so tests never touch the network).
 * Returns the parsed body, or null on 404. Throws on any other non-2xx, with the status.
 * Keys go in headers only; the error never echoes request headers.
 */
export async function call(ctx, provider, url, { method = "GET", headers = {}, query, body } = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(query || {})) if (v != null && v !== "") u.searchParams.set(k, String(v));
  const res = await ctx.fetch(u.toString(), {
    method,
    headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`${provider} ${method} ${u.pathname}: HTTP ${res.status} ${text.slice(0, 160)}`), { status: res.status });
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${provider} ${method} ${u.pathname}: response was not JSON`);
  }
}

/** RFC 4180-ish CSV: quoted fields, doubled quotes, CRLF. Returns rows of strings. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  const t = String(text).replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"' && t[i + 1] === '"') field += '"', i++;
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") row.push(field), (field = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(field), rows.push(row), (row = []), (field = "");
    } else field += c;
  }
  if (field !== "" || row.length) row.push(field), rows.push(row);
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

// Header (normalised) -> schema key. Unknown headers are ignored. Every email, phone and
// address column is read and labelled: "Work Email" is work, "Personal Email", "Mobile" and
// "Home Address" are kept and labelled personal or mobile, a bare "Email" is labelled by domain.
const ALIASES = {
  kind: ["kind", "type", "record type"],
  name: ["name", "full name", "person", "person name", "contact name", "lead name"],
  first: ["first name", "firstname", "given name"],
  last: ["last name", "lastname", "surname", "family name"],
  title: ["title", "job title", "position", "headline title", "current title"],
  company: ["company", "company name", "organization", "organisation", "employer", "account name", "current company"],
  from: ["from", "start", "start date", "started on", "started"],
  to: ["to", "end", "end date", "ended on", "finished"],
  school: ["school", "school name", "university", "college", "institution"],
  degree: ["degree", "degree name", "qualification", "field of study"],
  city: ["city", "location", "person city", "geography"],
  linkedin: ["linkedin", "linkedin url", "profile url", "url", "linkedin profile", "person linkedin url"],
  x: ["twitter", "x", "twitter url", "x url"],
  workEmail: ["work email", "business email"],
  email: ["email", "email address", "e mail"],
  personalEmail: ["personal email", "private email", "home email"],
  workPhone: ["work phone", "direct phone", "office phone", "company phone", "direct dial"],
  phone: ["phone", "phone number", "telephone"],
  mobile: ["mobile", "mobile phone", "cell", "cell phone"],
  homePhone: ["home phone"],
  address: ["address", "street address", "mailing address"],
  homeAddress: ["home address", "residential address"],
  workAddress: ["work address", "office address", "business address"],
  companyAddress: ["company address", "hq address", "headquarters address", "principal office"],
  registeredAddress: ["registered address", "registered office", "registered agent address"],
  seniority: ["seniority", "management level"],
  departments: ["department", "departments", "function", "job function"],
  connectedOn: ["connected on"],
  legalName: ["legal name", "company legal name"],
  domain: ["domain", "website", "company domain", "company website"],
  industry: ["industry", "company industry"],
  headcount: ["headcount", "employees", "employee count", "company size", "company headcount"],
  revenue: ["revenue", "annual revenue", "company revenue"],
  round: ["funding round", "round"],
  roundDate: ["funding date", "round date", "announced on"],
  amount: ["funding amount", "amount raised", "money raised"],
  investors: ["investors", "lead investors"],
  tech: ["technologies", "tech stack", "technology"],
  parent: ["parent", "parent company"],
};
const HEADER = Object.fromEntries(Object.entries(ALIASES).flatMap(([k, list]) => list.map((h) => [norm(h), k])));

/** CSV rows -> objects keyed by schema keys. LinkedIn's export puts "Notes:" lines above the header; they are skipped. */
export function csvRecords(text) {
  const rows = parseCsv(text);
  const at = rows.findIndex((r) => r.filter((h) => HEADER[norm(h)]).length >= 2);
  if (at < 0) return [];
  const keys = rows[at].map((h) => HEADER[norm(h)] || null);
  return rows.slice(at + 1).map((r) => {
    const o = {};
    keys.forEach((k, i) => {
      if (k && r[i] != null && String(r[i]).trim() !== "" && o[k] == null) o[k] = String(r[i]).trim();
    });
    return o;
  });
}

export const rowName = (r) => r.name || [r.first, r.last].filter(Boolean).join(" ");

/** CSV files in a folder (not recursive), sorted. */
export function csvFiles(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".csv")).sort().map((f) => join(dir, f));
}

const sameCompany = (a, company) => {
  const n = norm(a);
  const c = norm(company.name);
  return !!n && (n === c || n.startsWith(c + " ") || c.startsWith(n + " ") || (company.domain && domain(a) === company.domain));
};

/**
 * Person and company records from CSV rows. One row per position or degree is fine:
 * rows for the same name are folded into one person. Every email, phone and address
 * column is kept as a labelled contact.
 */
export function recordsFromRows(rows, provider, { person, company, fetchedAt, file }) {
  const mine = person ? rows.filter((r) => norm(rowName(r)) && norm(rowName(r)) === norm(person.name) && r.kind?.toLowerCase() !== "company") : [];
  let p = null;
  if (person && mine.length) {
    const first = mine[0];
    p = makePerson(
      {
        names: [rowName(first)],
        titles: mine.filter((r) => r.title || r.company).map((r) => ({ title: r.title, company: r.company, from: r.from, to: r.to })),
        education: mine.filter((r) => r.school).map((r) => ({ school: r.school, degree: r.degree, from: r.from, to: r.to })),
        city: mine.map((r) => r.city).find(Boolean),
        socials: mine.flatMap((r) => [r.linkedin, r.x]).filter(Boolean),
        emails: mine.flatMap((r) => [r.workEmail && { email: r.workEmail, type: "work" }, r.email, r.personalEmail && { email: r.personalEmail, type: "personal" }]).filter(Boolean),
        phones: mine.flatMap((r) => [r.workPhone && { number: r.workPhone, type: "work" }, r.phone, r.mobile && { number: r.mobile, type: "mobile" }, r.homePhone && { number: r.homePhone, type: "home" }]).filter(Boolean),
        addresses: mine.flatMap((r) => [r.workAddress && { value: r.workAddress, type: "work" }, r.address, r.homeAddress && { value: r.homeAddress, type: "home" }]).filter(Boolean),
        seniority: mine.map((r) => r.seniority).find(Boolean),
        departments: mine.flatMap((r) => (r.departments ? r.departments.split(/[;,]/) : [])),
      },
      makeSource(provider, file, fetchedAt, first.connectedOn ? `1st-degree connection of the user since ${first.connectedOn}` : undefined),
    );
  }
  const crow = !company ? [] : rows.filter((r) => !norm(rowName(r)) && (r.kind?.toLowerCase() === "company" || r.legalName || r.domain || r.headcount) && sameCompany(r.legalName || r.company || r.domain, company));
  let c = null;
  if (company && crow.length) {
    const f = crow[0];
    c = makeCompany(
      {
        legalName: f.legalName || f.company,
        domains: crow.map((r) => r.domain),
        industry: f.industry,
        headcount: f.headcount,
        revenue: f.revenue,
        funding: crow.filter((r) => r.round || r.amount).map((r) => ({ round: r.round, date: r.roundDate, amount: r.amount, investors: r.investors })),
        techStack: crow.flatMap((r) => (r.tech ? r.tech.split(/[;,]/) : [])),
        parent: f.parent,
        addresses: crow.flatMap((r) => [r.registeredAddress && { value: r.registeredAddress, role: "registered" }, r.companyAddress && { value: r.companyAddress, role: "principal office" }, r.address && { value: r.address, role: "other" }]).filter(Boolean),
      },
      makeSource(provider, file, fetchedAt),
    );
  }
  return { person: p, company: c };
}

export const readText = (f) => readFileSync(f, "utf8");
