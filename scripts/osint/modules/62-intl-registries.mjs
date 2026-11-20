// intl-registries: the national company register for the company's country, chosen from
// --country or the GLEIF legal address (company-resolve). Officers with their roles are the
// prize: they name the subject's role and its start date in a legal record.
//   FR recherche-entreprises.api.gouv.fr (no key, Etalab licence): dirigeants, headcount band, finances
//   NO data.brreg.no (no key, NLOD): enheter + /roller
//   CZ ares.gov.cz (no key): vyhledat, then the commercial register record (statutory bodies)
//   GB Companies House (free COMPANIES_HOUSE_API_KEY, basic auth): search + officers
// Other countries: a miss that says no free register API is wired.

import { companyBase } from "../resolve.mjs";
import { normCompany } from "../colib.mjs";
import { nameParts, firstForms, normName, blockedMiss, isBlocked } from "../person-lib.mjs";

const cap = (s) => String(s || "").toLowerCase().replace(/(^|[\s'-])([a-zà-ÿ])/g, (m, a, b) => a + b.toUpperCase());

/** True when an officer (given names, surname) is the subject: surname equal, a given name in the first-name forms. */
export function officerIsSubject(o, subject) {
  const { first, last } = nameParts(subject.name);
  if (!first || !last) return false;
  const sur = normName(o.last);
  if (!(sur === last || sur.split(" ").includes(last) || sur.replace(/ /g, "") === last.replace(/ /g, ""))) return false;
  const forms = firstForms(first);
  return normName(o.first).split(" ").some((g) => forms.includes(g));
}

/** Pick the register entry whose name matches the company (exact normalised first, then prefix). */
export function pickEntry(list, names, nameOf) {
  const want = names.filter(Boolean).map(normCompany).filter(Boolean);
  return list.find((x) => want.includes(normCompany(nameOf(x)))) || list.find((x) => want.some((w) => normCompany(nameOf(x)).startsWith(w + " ") || normCompany(nameOf(x)) === w)) || null;
}

// ------------------------------------------------------------------ France

export function parseFrance(json, names) {
  const e = pickEntry(json?.results || [], names, (x) => x.nom_raison_sociale || x.nom_complet);
  if (!e) return null;
  const fin = Object.entries(e.finances || {}).sort((a, b) => b[0].localeCompare(a[0]))[0];
  return {
    registry: "France, Registre national des entreprises (recherche-entreprises.api.gouv.fr)",
    id: `SIREN ${e.siren}`,
    name: e.nom_complet,
    status: e.etat_administratif === "A" ? "active" : "closed",
    created: e.date_creation,
    address: e.siege?.adresse || null,
    size: e.categorie_entreprise ? `category ${e.categorie_entreprise}${e.tranche_effectif_salarie ? `, INSEE headcount band ${e.tranche_effectif_salarie} (${e.annee_tranche_effectif_salarie})` : ""}` : null,
    finances: fin ? { year: fin[0], revenue: fin[1].ca ?? null, netIncome: fin[1].resultat_net ?? null } : null,
    url: `https://annuaire-entreprises.data.gouv.fr/entreprise/${e.siren}`,
    officers: (e.dirigeants || []).map((d) => (d.type_dirigeant === "personne morale" ? { org: d.denomination, role: d.qualite } : { first: cap(d.prenoms), last: cap(d.nom), role: d.qualite, born: d.annee_de_naissance || null })),
  };
}

// ------------------------------------------------------------------ Norway

export function parseNorway(json, names) {
  const e = pickEntry(json?._embedded?.enheter || [], names, (x) => x.navn);
  if (!e) return null;
  const a = e.forretningsadresse || {};
  return {
    registry: "Norway, Enhetsregisteret (data.brreg.no)",
    id: `org.nr ${e.organisasjonsnummer}`,
    orgnr: e.organisasjonsnummer,
    name: e.navn,
    status: e.konkurs ? "bankrupt" : e.underAvvikling ? "winding up" : "active",
    created: e.stiftelsesdato || e.registreringsdatoEnhetsregisteret || null,
    address: [...(a.adresse || []), a.postnummer, a.poststed, a.land].filter(Boolean).join(", "),
    size: e.antallAnsatte != null ? `${e.antallAnsatte.toLocaleString("en-US")} employees registered` : null,
    formerNames: (e.historiskeNavn || []).map((h) => h.navn),
    url: `https://data.brreg.no/enhetsregisteret/oppslag/enheter/${e.organisasjonsnummer}`,
    officers: [],
  };
}

export function parseNorwayRoles(json) {
  const out = [];
  for (const g of json?.rollegrupper || []) {
    for (const r of g.roller || []) {
      if (r.avregistrert) continue;
      // sistEndret is when the role group last changed, not the person's start date
      if (r.person) out.push({ first: r.person.navn?.fornavn, last: r.person.navn?.etternavn, role: r.type?.beskrivelse, groupUpdated: g.sistEndret || null });
      else if (r.enhet) out.push({ org: (r.enhet.navn || []).join(" "), role: r.type?.beskrivelse });
    }
  }
  return out;
}

// ------------------------------------------------------------------ Czechia

export function parseCzechSearch(json, names) {
  const e = pickEntry(json?.ekonomickeSubjekty || [], names, (x) => x.obchodniJmeno);
  if (!e) return null;
  return {
    registry: "Czechia, ARES (ares.gov.cz)",
    id: `IČO ${e.ico}`,
    ico: e.ico,
    name: e.obchodniJmeno,
    status: e.datumZaniku ? "dissolved" : "active",
    created: e.datumVzniku || null,
    address: e.sidlo?.textovaAdresa || null,
    url: `https://ares.gov.cz/ekonomicke-subjekty?ico=${e.ico}`,
    officers: [],
  };
}

/**
 * Members of the statutory and supervisory bodies in an ARES commercial-register record: current
 * ones, and former ones (with the date they left) marked former. An entry struck out without an
 * end date is a superseded copy of a later entry and is skipped.
 */
export function parseCzechVr(json) {
  const z = (json?.zaznamy || []).find((x) => x.primarniZaznam) || json?.zaznamy?.[0];
  const out = [];
  for (const org of [...(z?.statutarniOrgany || []), ...(z?.ostatniOrgany || [])]) {
    for (const m of org.clenoveOrganu || []) {
      const until = m.clenstvi?.clenstvi?.zanikClenstvi || m.clenstvi?.funkce?.zanikFunkce || null;
      if (m.datumVymazu && !until) continue;
      const p = m.fyzickaOsoba;
      const role = m.clenstvi?.funkce?.nazev || m.nazevAngazma || org.nazevOrganu;
      const since = m.clenstvi?.clenstvi?.vznikClenstvi || m.clenstvi?.funkce?.vznikFunkce || m.datumZapisu || null;
      const former = !!(m.datumVymazu || until);
      if (p) out.push({ first: cap(p.jmeno), last: cap(p.prijmeni), role, since, ...(former ? { former, until } : {}) });
      else if (m.pravnickaOsoba) out.push({ org: m.pravnickaOsoba.obchodniJmeno, role, since, ...(former ? { former, until } : {}) });
    }
  }
  return out;
}

// ------------------------------------------------------------------ United Kingdom

export function parseUkSearch(json, names) {
  const e = pickEntry(json?.items || [], names, (x) => x.title);
  if (!e) return null;
  return {
    registry: "United Kingdom, Companies House",
    id: `company no. ${e.company_number}`,
    number: e.company_number,
    name: e.title,
    status: e.company_status,
    created: e.date_of_creation || null,
    address: e.address_snippet || null,
    url: `https://find-and-update.company-information.service.gov.uk/company/${e.company_number}`,
    officers: [],
  };
}

export function parseUkOfficers(json) {
  return (json?.items || [])
    .filter((o) => !o.resigned_on)
    .map((o) => {
      const [last, rest] = String(o.name || "").split(",");
      return o.officer_role?.startsWith("corporate") ? { org: o.name, role: o.officer_role } : { first: cap((rest || "").trim()), last: cap(last.trim()), role: (o.officer_role || "").replace(/-/g, " "), since: o.appointed_on || null, occupation: o.occupation || null };
    });
}

// ------------------------------------------------------------------ module

export const WIRED = { FR: "France", NO: "Norway", CZ: "Czechia", GB: "United Kingdom" };

async function lookup(ctx, country, names) {
  const { http, env } = ctx;
  const q = encodeURIComponent(names[0]);
  if (country === "FR") {
    const r = await http.json(`https://recherche-entreprises.api.gouv.fr/search?q=${q}&per_page=10`, { timeout: 8000 });
    return { r, rec: r.ok ? parseFrance(r.data, names) : null };
  }
  if (country === "NO") {
    const r = await http.json(`https://data.brreg.no/enhetsregisteret/api/enheter?navn=${q}&size=10`, { timeout: 8000 });
    const rec = r.ok ? parseNorway(r.data, names) : null;
    if (rec) {
      const ro = await http.json(`https://data.brreg.no/enhetsregisteret/api/enheter/${rec.orgnr}/roller`, { timeout: 8000 });
      rec.officers = parseNorwayRoles(ro.data);
    }
    return { r, rec };
  }
  if (country === "CZ") {
    const r = await http.json("https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/vyhledat", { method: "POST", body: JSON.stringify({ obchodniJmeno: names[0], pocet: 10 }), headers: { "content-type": "application/json" }, timeout: 8000 });
    const rec = r.ok ? parseCzechSearch(r.data, names) : null;
    if (rec) {
      const vr = await http.json(`https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty-vr/${rec.ico}`, { timeout: 10000 });
      rec.officers = parseCzechVr(vr.data);
    }
    return { r, rec };
  }
  if (country === "GB") {
    if (!env.COMPANIES_HOUSE_API_KEY) return { needKey: "COMPANIES_HOUSE_API_KEY" };
    const auth = { authorization: "Basic " + Buffer.from(`${env.COMPANIES_HOUSE_API_KEY}:`).toString("base64") };
    const r = await http.json(`https://api.company-information.service.gov.uk/search/companies?q=${q}&items_per_page=10`, { headers: auth, timeout: 8000 });
    const rec = r.ok ? parseUkSearch(r.data, names) : null;
    if (rec) {
      const of = await http.json(`https://api.company-information.service.gov.uk/company/${rec.number}/officers?items_per_page=50`, { headers: auth, timeout: 8000 });
      rec.officers = parseUkOfficers(of.data);
    }
    return { r, rec };
  }
  return null;
}

export default {
  id: "intl-registries",
  label: "National company registers (FR, NO, CZ; UK with key): officers and roles",
  lane: "fast",
  needs: ["company"],
  env: ["COMPANIES_HOUSE_API_KEY"],
  budgetMs: 15000,
  async run(ctx) {
    const { subject } = ctx;
    const c = await companyBase(ctx);
    const country = (subject.country || c.country || "").toUpperCase().replace(/^UK$/, "GB");
    if (!country) return ctx.miss("co.registry", "national register not checked: country unknown (no GLEIF record; pass --country)");
    if (country === "US") return ctx.miss("co.registry", "US company: no national register (state registries have no free API; SEC and GLEIF cover it)");
    if (!WIRED[country]) return ctx.miss("co.registry", `no free company-register API wired for country ${country} (wired: ${Object.keys(WIRED).join(", ")})`);
    // GLEIF's legal name is the registered one; it often matches the register better than the brand
    const names = [...new Set([c.leiRecord?.legalName, subject.company, c.secName].filter(Boolean))];
    const out = await lookup(ctx, country, names);
    if (out.needKey) return ctx.miss("co.registry", `${WIRED[country]} register not checked: needs a free ${out.needKey}`);
    if (!out.rec) {
      if (isBlocked(out.r)) return blockedMiss(ctx, "co.registry", `${WIRED[country]} register`, out.r, "retry later");
      return ctx.miss("co.registry", `${WIRED[country]} register: no entity named like ${names.map((n) => `"${n}"`).join(" or ")}`);
    }
    const rec = out.rec;
    const fin = rec.finances;
    ctx.add({
      var: "co.registry",
      value: `${rec.registry}: ${rec.name}, ${rec.id}, ${rec.status}${rec.created ? `, formed ${rec.created}` : ""}${rec.address ? `; ${rec.address}` : ""}${rec.size ? `; ${rec.size}` : ""}${fin ? `; FY${fin.year} revenue ${fin.revenue != null ? fin.revenue.toLocaleString("en-US") : "?"}, net ${fin.netIncome != null ? fin.netIncome.toLocaleString("en-US") : "?"} (EUR)` : ""}${rec.formerNames?.length ? `; formerly ${rec.formerNames.slice(-3).join(", ")}` : ""}`,
      url: rec.url,
      grade: "v",
      tier: "A",
      date: rec.created || null,
      anchors: ["company"],
      detail: { ...rec, officers: undefined, country },
    });
    const people = rec.officers.filter((o) => o.last && !o.former);
    if (people.length) {
      ctx.add({
        var: "co.leadership",
        value: `${WIRED[country]} register officers (${people.length}): ${people.slice(0, 12).map((o) => `${o.first} ${o.last} (${o.role}${o.since ? `, since ${o.since}` : ""})`).join("; ")}${people.length > 12 ? `; and ${people.length - 12} more` : ""}`,
        url: rec.url,
        grade: "v",
        tier: "A",
        anchors: ["company"],
        detail: { registry: rec.registry, officers: rec.officers },
      });
    } else ctx.miss("co.leadership", `${WIRED[country]} register lists no current officers for ${rec.name}`);
    const me = people.filter((o) => officerIsSubject(o, subject));
    for (const o of me) {
      ctx.add({ var: "role.title", value: `${o.role} of ${rec.name} (${WIRED[country]} register${o.since ? `, since ${o.since}` : ""})`, url: rec.url, grade: "v", tier: "A", date: o.since || null, anchors: ["name", "company"], detail: { registry: rec.registry, officer: o } });
      if (o.since) ctx.add({ var: "role.start", value: `${o.since}: ${o.role}, ${rec.name} (${WIRED[country]} register)`, url: rec.url, grade: "v", tier: "A", date: o.since, anchors: ["name", "company"] });
    }
    // a former officer entry for the subject: the register's own record of when he left
    const past = rec.officers.filter((o) => o.last && o.former && officerIsSubject(o, subject)).sort((a, b) => String(b.until || "").localeCompare(String(a.until || "")));
    if (past.length && !me.length) {
      const o = past[0];
      ctx.add({ var: "role.title", value: `Former ${o.role} of ${rec.name}${o.since ? ` from ${o.since}` : ""}${o.until ? ` until ${o.until}` : ""} (${WIRED[country]} register)`, url: rec.url, grade: "v", tier: "A", date: o.until || null, anchors: ["name", "company"], detail: { registry: rec.registry, officer: o } });
    }
    if (subject.name && people.length && !me.length && !past.length) ctx.miss("role.title", `${subject.name} is not among the ${people.length} current officers in the ${WIRED[country]} register for ${rec.name}`);
  },
};
