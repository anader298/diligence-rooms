// Patents where he is an inventor. Google Patents' xhr/query endpoint answers JSON with no key
// (measured 19 Nov 2026, under a second). Family members (US, EP, WO copies of one invention)
// are collapsed by title. With USPTO_API_KEY (free, USPTO Open Data Portal; PatentsView moved
// there on 20 Mar 2026 and search.patentsview.org no longer resolves) the ODP patent application
// search adds US applications by inventor name, with the inventor's city and state.

import { nameParts, normName, companyIn, placeIn, hobbiesIn, stripTags, blockedMiss, firstForms } from "../person-lib.mjs";

const ODP = "https://api.uspto.gov/api/v1/patent/applications/search";

/**
 * USPTO ODP application search results naming the subject as inventor: [{ title, application,
 * patent, filed, granted, applicant, inventor, city, region, country, url }].
 */
export function odpApplications(json, subject) {
  const { first, last } = nameParts(subject.name);
  const forms = firstForms(first);
  const out = [];
  for (const w of json?.patentFileWrapperDataBag || []) {
    const m = w.applicationMetaData || {};
    const inv = (m.inventorBag || []).find((i) => {
      const n = normName(i.inventorNameText || [i.firstName, i.lastName].join(" ")).split(" ");
      return n.includes(last) && forms.some((f) => n.includes(f));
    });
    if (!inv) continue;
    const addr = (inv.correspondenceAddressBag || [])[0] || {};
    out.push({
      title: m.inventionTitle || null,
      application: w.applicationNumberText || m.applicationNumberText || null,
      patent: m.patentNumber || null,
      filed: m.filingDate || null,
      granted: m.grantDate || null,
      applicant: m.firstApplicantName || (m.applicantBag || [])[0]?.applicantNameText || null,
      inventor: inv.inventorNameText || null,
      city: addr.cityName || null,
      region: addr.geographicRegionCode || addr.geographicRegionName || null,
      country: addr.countryCode || null,
      url: w.applicationNumberText ? `https://data.uspto.gov/patent-file-wrapper/search/details/${w.applicationNumberText}` : null,
    });
  }
  return out;
}

/** Collapse Google Patents results to one per invention, keeping those that name the subject. */
export function patentsFrom(json, subject) {
  const { first, last } = nameParts(subject.name);
  const out = new Map();
  for (const c of json?.results?.cluster || []) {
    for (const x of c.result || []) {
      const p = x?.patent;
      if (!p) continue;
      const inv = normName(stripTags(p.inventor || ""));
      if (!(inv.includes(last) && (inv.includes(first) || inv.split(" ").includes(first[0])))) continue;
      const title = stripTags(p.title || "").trim();
      const k = normName(title);
      const prev = out.get(k);
      const rec = { title, number: p.publication_number, assignee: stripTags(p.assignee || ""), priority: p.priority_date, filed: p.filing_date, granted: p.grant_date, published: p.publication_date, inventor: stripTags(p.inventor || ""), url: `https://patents.google.com/patent/${p.publication_number}/en` };
      if (!prev || (/^US/.test(rec.number) && !/^US/.test(prev.number)) || (/B\d$/.test(rec.number) && !/B\d$/.test(prev.number))) out.set(k, rec);
    }
  }
  return [...out.values()].sort((a, b) => String(b.priority || "").localeCompare(String(a.priority || "")));
}

export default {
  id: "patents",
  /** The ledger variables this module fills (config/form buckets read them to say "no tool yet"). */
  vars: ["career.patents", "place.home_metro", "hobby.sports", "hobby.cooking", "hobby.endurance", "hobby.media", "hobby.teams"],
  label: "Patents as inventor (Google Patents; USPTO Open Data Portal with key)",
  lane: "fast",
  needs: ["name"],
  env: ["USPTO_API_KEY"],
  budgetMs: 20000,
  async run(ctx) {
    const { subject, http, env, shared } = ctx;
    const { first, last } = nameParts(subject.name);
    const pu = `https://patents.google.com/xhr/query?url=${encodeURIComponent(`inventor=${first} ${last}&num=100`)}&exp=`;
    let r = await http.json(pu, { timeout: 12000 });
    if (r.status === 503 || r.status === 429) {
      await new Promise((res) => setTimeout(res, 2000));
      r = await http.json(pu, { timeout: 12000 });
    }
    if (!r.ok) {
      blockedMiss(ctx, "career.patents", "Google Patents", r, `${env.USPTO_API_KEY ? "" : "set USPTO_API_KEY (free, USPTO Open Data Portal) for a second source, or "}retry in an hour (Google's unusual-traffic page clears on its own)`);
    } else {
      const pats = patentsFrom(r.data, subject);
      if (!pats.length) ctx.miss("career.patents", `Google Patents: no patents with inventor ${first} ${last}`);
      const assignees = {};
      for (const p of pats) if (p.assignee) assignees[p.assignee] = (assignees[p.assignee] || 0) + 1;
      if (pats.length) {
        const years = pats.map((p) => String(p.priority || "").slice(0, 4)).filter(Boolean).sort();
        const coHit = pats.some((p) => companyIn(p.assignee, subject));
        ctx.add({ var: "career.patents", value: `${pats.length} invention(s) naming ${first} ${last} as inventor, ${years[0]}–${years.at(-1)}; assignees ${Object.entries(assignees).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([a, n]) => `${a} (${n})`).join(", ")}`, url: `https://patents.google.com/?inventor=${encodeURIComponent(`${first} ${last}`)}`, grade: coHit ? "p" : "w", tier: "A", anchors: coHit ? ["name", "company"] : ["name"], detail: { assignees, total: r.data?.results?.total_num_results } });
      }
      for (const p of pats.slice(0, 20)) {
        const co = companyIn(p.assignee, subject);
        ctx.add({ var: "career.patents", value: `${p.title} — ${p.number}, priority ${p.priority || "?"}${p.assignee ? `, ${p.assignee}` : ""}`, url: p.url, date: p.granted || p.published || null, grade: co ? "p" : "w", tier: "A", anchors: co ? ["name", "company"] : ["name"], detail: p });
      }
      // Hobby leads from what he invents outside work (bow sights, tree stands...).
      const seen = new Set();
      for (const p of pats) {
        for (const h of hobbiesIn(p.title)) {
          if (seen.has(h.label)) continue;
          seen.add(h.label);
          ctx.add({ var: h.var, value: `${h.label} (inference): named inventor on "${p.title}"${p.assignee ? ` for ${p.assignee}` : ""}`, url: p.url, grade: "i", tier: "D", anchors: ["name"], detail: { patent: p.number } });
        }
      }
      shared.patents = pats;
    }

    if (env.USPTO_API_KEY) {
      const q = `applicationMetaData.inventorBag.inventorNameText:"${first} ${last}"`;
      const od = await http.json(`${ODP}?q=${encodeURIComponent(q)}&limit=50&offset=0`, { headers: { "X-API-KEY": env.USPTO_API_KEY }, timeout: 12000 });
      if (!od.ok) {
        if ([401, 403].includes(od.status)) ctx.miss("career.patents", `USPTO Open Data Portal: HTTP ${od.status} (check USPTO_API_KEY), not checked`, { blocked: true });
        else if (od.status !== 404) blockedMiss(ctx, "career.patents", "USPTO Open Data Portal", od, "retry later", { partial: true });
      }
      const apps = odpApplications(od.data, subject);
      const web = `https://data.uspto.gov/patent-file-wrapper/search?q=${encodeURIComponent(q)}`;
      if (apps.length) {
        const co = apps.filter((a) => companyIn(a.applicant || "", subject));
        ctx.add({ var: "career.patents", value: `USPTO: ${od.data?.count ?? apps.length} US application(s) with inventor ${first} ${last}; applicants ${[...new Set(apps.map((a) => a.applicant).filter(Boolean))].slice(0, 5).join(", ") || "?"}${co.length ? ` (${co.length} for ${subject.company})` : ""}`, url: web, grade: co.length ? "p" : "w", tier: "A", anchors: co.length ? ["name", "company"] : ["name"], detail: { count: od.data?.count ?? apps.length, applications: apps.slice(0, 25) } });
        const cities = new Map();
        for (const a of apps) if (a.city) cities.set(`${a.city}|${a.region || a.country}`, (cities.get(`${a.city}|${a.region || a.country}`) || []).concat(a));
        for (const [k, list] of [...cities].sort((a, b) => b[1].length - a[1].length).slice(0, 2)) {
          const [city, reg] = k.split("|");
          const tied = list.some((a) => companyIn(a.applicant || "", subject)) || placeIn(`${city} ${reg}`, subject, shared);
          ctx.add({ var: "place.home_metro", value: `${city}, ${reg} (USPTO inventor address on ${list.length} application(s)${list[0].applicant ? `, e.g. for ${list[0].applicant}` : ""})`, url: list[0].url || web, grade: tied ? "p" : "w", tier: "A", anchors: tied ? ["name", "company"] : ["name"], date: list.map((a) => a.filed).filter(Boolean).sort().at(-1) || null, detail: { applications: list.map((a) => a.application) } });
        }
      } else if (od.ok) ctx.miss("career.patents", `USPTO Open Data Portal: no US applications with inventor "${first} ${last}"`);
    } else {
      ctx.miss("career.patents", "USPTO Open Data Portal not checked: set USPTO_API_KEY (free at data.uspto.gov) for US applications by inventor and the inventor's city", { blocked: true });
    }
  },
};
