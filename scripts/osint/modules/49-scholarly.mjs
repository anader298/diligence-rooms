// scholarly: papers, patents of thought and degrees for people who publish. Four open sources in
// parallel: ORCID expanded search (and the matched record's education list), OpenAlex authors
// (OPENALEX_API_KEY optional; without it calls share a small daily pool per IP), Semantic Scholar
// author search, and Crossref works by author name. An author record is accepted only when an
// affiliation names the company (or the homepage sits on its domain): common names have hundreds
// of namesakes in these indexes. Name-only matches are counted in the miss, never added as rows.

import { nameMatch, companyIn, nameParts, stripTags, isBlocked, blockedMiss } from "../person-lib.mjs";

const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
const year = (d) => d?.year?.value || null;

/** ORCID expanded-search rows that match the name and list the company among institutions. */
export function orcidMatches(json, subject) {
  return (json?.["expanded-result"] || []).filter((r) => nameMatch(`${r["given-names"] || ""} ${r["family-names"] || ""}`, subject) && (r["institution-name"] || []).some((i) => companyIn(i, subject))).map((r) => ({ id: r["orcid-id"], name: `${r["given-names"]} ${r["family-names"]}`, institutions: r["institution-name"] || [] }));
}

/** ORCID educations → [{ org, role, start, end }]. */
export function orcidEducation(json) {
  const out = [];
  for (const g of json?.["affiliation-group"] || []) {
    for (const s of g.summaries || []) {
      const e = s["education-summary"];
      if (!e) continue;
      out.push({ org: e.organization?.name, role: e["role-title"] || null, department: e["department-name"] || null, start: year(e["start-date"]), end: year(e["end-date"]) });
    }
  }
  return out;
}

/** OpenAlex authors that match the name and whose affiliations name the company. */
export function openalexMatches(json, subject) {
  return (json?.results || []).filter((a) => nameMatch(a.display_name, subject)).map((a) => {
    const insts = [...(a.last_known_institutions || []).map((i) => i.display_name), ...(a.affiliations || []).map((x) => x.institution?.display_name)].filter(Boolean);
    return { id: a.id, name: a.display_name, orcid: a.orcid || null, works: a.works_count, cited: a.cited_by_count, hIndex: a.summary_stats?.h_index ?? null, institutions: [...new Set(insts)], topics: (a.topics || []).slice(0, 5).map((t) => t.display_name), anchored: insts.some((i) => companyIn(i, subject)) };
  });
}

/** Semantic Scholar authors that match the name; anchored by affiliation or a homepage on the company domain. */
export function s2Matches(json, subject) {
  const dom = String(subject.domain || "").toLowerCase();
  return (json?.data || []).filter((a) => nameMatch(a.name, subject)).map((a) => ({ id: a.authorId, name: a.name, url: a.url || `https://www.semanticscholar.org/author/${a.authorId}`, affiliations: a.affiliations || [], homepage: a.homepage || null, papers: a.paperCount, hIndex: a.hIndex ?? null, anchored: (a.affiliations || []).some((x) => companyIn(x, subject)) || (!!dom && String(a.homepage || "").toLowerCase().includes(dom)) }));
}

/** Crossref works with an author who matches the name and whose affiliation names the company. */
export function crossrefWorks(json, subject) {
  const out = [];
  for (const w of json?.message?.items || []) {
    const au = (w.author || []).find((a) => nameMatch(`${a.given || ""} ${a.family || ""}`, subject));
    if (!au) continue;
    const affs = (au.affiliation || []).map((x) => stripTags(x.name || "")).filter(Boolean);
    out.push({ doi: w.DOI, title: stripTags((w.title || [])[0] || "") || null, venue: (w["container-title"] || [])[0] || null, year: w.issued?.["date-parts"]?.[0]?.[0] || null, affiliations: affs, affiliation: affs.find((x) => companyIn(x, subject)) || affs[0] || null, anchored: affs.some((x) => companyIn(x, subject)) });
  }
  return out;
}

export default {
  id: "scholarly",
  label: "Scholarly record (ORCID, OpenAlex, Semantic Scholar, Crossref)",
  lane: "fast",
  needs: ["name"],
  env: ["OPENALEX_API_KEY"],
  budgetMs: 12000,
  async run(ctx) {
    const { subject, http, env } = ctx;
    const { first, last } = nameParts(subject.name);
    if (!first || !last) return ctx.miss("career.publications", "scholarly: needs a first and last name");
    const n = encodeURIComponent(subject.name);
    const oaKey = env.OPENALEX_API_KEY ? `&api_key=${env.OPENALEX_API_KEY}` : "";
    const [orc, oa, s2, cr] = await Promise.all([
      http.json(`https://pub.orcid.org/v3.0/expanded-search/?q=${encodeURIComponent(`given-names:${cap(first)} AND family-name:${cap(last)}`)}&rows=20`, { timeout: 6000, headers: { accept: "application/json" } }),
      http.json(`https://api.openalex.org/authors?search=${n}&per-page=10${oaKey}`, { timeout: 6000 }),
      http.json(`https://api.semanticscholar.org/graph/v1/author/search?query=${n}&fields=name,affiliations,homepage,paperCount,hIndex,url&limit=10`, { timeout: 6000 }),
      http.json(`https://api.crossref.org/works?query.author=${n}&rows=40&select=DOI,title,author,issued,container-title`, { timeout: 8000 }),
    ]);
    const status = { orcid: orc.status || orc.error, openalex: oa.status || oa.error, semanticscholar: s2.status || s2.error, crossref: cr.status || cr.error };
    for (const [src, r] of [["ORCID", orc], ["OpenAlex", oa], ["Semantic Scholar", s2], ["Crossref", cr]]) if (isBlocked(r)) blockedMiss(ctx, "career.publications", src, r, src === "OpenAlex" && !env.OPENALEX_API_KEY ? "set OPENALEX_API_KEY (free)" : "retry later", { partial: true });
    const orcids = orc.ok ? orcidMatches(orc.data, subject) : [];
    const oas = oa.ok ? openalexMatches(oa.data, subject) : [];
    const s2s = s2.ok ? s2Matches(s2.data, subject) : [];
    const works = cr.ok ? crossrefWorks(cr.data, subject) : [];
    let n2 = 0;
    for (const a of oas.filter((x) => x.anchored).slice(0, 2)) {
      n2++;
      ctx.add({ var: "career.publications", value: `OpenAlex: ${a.name}, ${a.works} works, ${a.cited?.toLocaleString()} citations${a.hIndex != null ? `, h-index ${a.hIndex}` : ""}; institutions ${a.institutions.slice(0, 4).join(", ")}${a.topics.length ? `; topics ${a.topics.join(", ")}` : ""}`, url: String(a.id).replace("https://openalex.org/", "https://openalex.org/authors/"), grade: "p", tier: "A", anchors: ["name", "company"], detail: a });
    }
    for (const a of s2s.filter((x) => x.anchored).slice(0, 2)) {
      n2++;
      ctx.add({ var: "career.publications", value: `Semantic Scholar: ${a.name}, ${a.papers} papers${a.hIndex != null ? `, h-index ${a.hIndex}` : ""}; ${a.affiliations.join(", ") || a.homepage}`, url: a.url, grade: "p", tier: "A", anchors: ["name", "company"], detail: a });
    }
    const anchoredWorks = works.filter((w) => w.anchored);
    for (const w of anchoredWorks.slice(0, 8)) {
      n2++;
      ctx.add({ var: "career.publications", value: `${w.title || w.doi}${w.venue ? ` — ${w.venue}` : ""}${w.year ? ` (${w.year})` : ""}; affiliation ${w.affiliation}`, url: `https://doi.org/${w.doi}`, grade: "p", tier: "A", date: w.year ? String(w.year) : null, anchors: ["name", "company"], detail: w });
    }
    for (const o of orcids.slice(0, 1)) {
      n2++;
      ctx.add({ var: "career.publications", value: `ORCID ${o.id}: ${o.name}; institutions ${o.institutions.slice(0, 5).join(", ")}`, url: `https://orcid.org/${o.id}`, grade: "p", tier: "A", anchors: ["name", "company"], detail: o });
      const ed = await http.json(`https://pub.orcid.org/v3.0/${o.id}/educations`, { timeout: 5000, headers: { accept: "application/json" } });
      for (const e of ed.ok ? orcidEducation(ed.data) : []) {
        ctx.add({ var: "career.education", value: `${e.role || "Studied"}${e.department ? `, ${e.department}` : ""} — ${e.org}${e.start || e.end ? ` (${e.start || "?"}–${e.end || ""})` : ""} (ORCID)`, url: `https://orcid.org/${o.id}`, grade: "p", tier: "A", date: e.end ? String(e.end) : null, anchors: ["name", "company"], detail: e });
      }
    }
    if (!n2) {
      const nameOnly = [(orc.data?.["expanded-result"] || []).filter((r) => nameMatch(`${r["given-names"] || ""} ${r["family-names"] || ""}`, subject)).length, oas.length, s2s.length, works.length];
      ctx.miss("career.publications", `ORCID, OpenAlex, Semantic Scholar, Crossref: no author record whose affiliation names ${subject.company || "the company"} (name-only matches, possible namesakes: ORCID ${nameOnly[0]}, OpenAlex ${nameOnly[1]}, Semantic Scholar ${nameOnly[2]}, Crossref works ${nameOnly[3]})${Object.values(status).some((s) => s !== 200) ? `; HTTP ${Object.entries(status).map(([k, v]) => `${k} ${v}`).join(", ")}` : ""}`);
    }
  },
};
