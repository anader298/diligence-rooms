// Identity scoring (late lane): is each candidate account really this person, or a namesake?
// Simple additive log-odds over what the other modules found:
//   name matches the display name or title   +2   (family: name)
//   company in bio, title or snippet          +4   (family: company)
//   city or state matches a known place       +2   (family: place)
//   same handle on 2+ name-matched sites      +2   (family: handle)
//   headshot reused (reverse image) / same avatar +3 (family: image)
//   contradicting company or place            -3 each
// Verdicts: verified >= 7 with 2+ anchor families besides the name; likely 4-6; namesake <= -3;
// otherwise unclear. Rows go to social.candidates; the verdicts are published as shared.identity.

import { nameMatch, companyIn, placeIn, knownPlaces, handleFromUrl, hostOf, normName } from "../person-lib.mjs";

/** Merge accounts from the sweep, search profile hits and Wikidata into one candidate list. */
export function gatherCandidates(shared = {}) {
  const out = new Map();
  const key = (site, handle, url) => (handle ? `${site}|${String(handle).toLowerCase()}` : `url|${String(url).toLowerCase().replace(/\/$/, "")}`);
  const put = (c) => {
    const k = key(c.site, c.handle, c.url);
    const prev = out.get(k);
    if (!prev) return out.set(k, { ...c, sources: [c.source] });
    prev.sources.push(c.source);
    for (const f of ["name", "bio", "company", "location", "avatar", "snippet", "title"]) prev[f] ||= c[f];
    prev.wikidataAnchors ||= c.wikidataAnchors;
  };
  for (const a of shared.accounts || []) put({ site: a.site, handle: a.handle, url: a.url, name: a.name, bio: a.bio, company: a.company, location: a.location, avatar: a.avatar, source: "sweep:" + a.source });
  for (const p of shared.searchProfiles || []) put({ site: p.platform, handle: p.handle || handleFromUrl(p.url), url: p.url, title: p.title, snippet: p.snippet, source: "search" });
  for (const w of shared.wikidataAccounts || []) put({ site: w.site, handle: w.handle, url: w.url, source: "wikidata", wikidataAnchors: w.anchors });
  return [...out.values()];
}

/** LinkedIn titles read "Name - Employer | LinkedIn"; GitHub and Docker carry a company field. */
function statedCompany(c) {
  if (c.company) return c.company;
  const t = c.title || "";
  if (c.site === "linkedin") {
    const m = t.replace(/\s*\|\s*LinkedIn.*$/, "").split(" - ");
    if (m.length > 1) return m.at(-1);
  }
  return null;
}

export function scoreCandidate(c, subject, sharedIn = {}, all = []) {
  // A place this candidate reported itself cannot anchor it.
  const shared = { ...sharedIn, places: (sharedIn.places || []).filter((p) => typeof p === "string" || p.from !== c.url) };
  const reasons = [];
  const fam = new Set();
  let s = 0;
  const text = [c.name, c.title, c.bio, c.snippet, c.company, c.location].filter(Boolean).join(" · ");
  if (nameMatch(c.name || c.title || "", subject) || (c.site === "github" && nameMatch(c.name || "", subject))) {
    s += 2;
    reasons.push("name +2");
    fam.add("name");
  }
  const co = statedCompany(c);
  if (companyIn(text, subject) || (c.wikidataAnchors || []).includes("company")) {
    s += 4;
    reasons.push("company +4");
    fam.add("company");
  } else if (co && subject.company && normName(co).length > 2 && !/^(self|freelance|retired|n a|none)$/.test(normName(co))) {
    s -= 3;
    reasons.push(`other company "${co}" -3`);
  }
  const places = knownPlaces(subject, shared);
  const loc = c.location || (c.snippet || "").match(/Location:\s*([^·|]+)/)?.[1] || null;
  if (placeIn(text, subject, shared)) {
    s += 2;
    reasons.push("place +2");
    fam.add("place");
  } else if (loc && places.length && !placeIn(loc, subject, shared)) {
    s -= 3;
    reasons.push(`other place "${loc.trim()}" -3`);
  }
  if (c.handle) {
    const same = all.filter((o) => o !== c && o.handle && o.site !== c.site && o.handle.toLowerCase() === c.handle.toLowerCase() && nameMatch(o.name || o.title || "", subject));
    if (same.length >= 1 && nameMatch(c.name || c.title || "", subject)) {
      s += 2;
      reasons.push(`same handle on ${same.map((o) => o.site).join(", ")} +2`);
      fam.add("handle");
    }
  }
  const rev = (shared.reverseHits || []).find((h) => (c.handle && String(h.page).toLowerCase().includes(String(c.handle).toLowerCase()) && hostOf(h.page).includes(c.site)) || String(h.page).replace(/\/$/, "") === String(c.url).replace(/\/$/, ""));
  if (rev || (c.avatar && shared.headshot && c.avatar === shared.headshot && shared.headshotFrom && !shared.headshotFrom.startsWith(c.site))) {
    s += 3;
    reasons.push("headshot reused +3");
    fam.add("image");
  }
  const families = [...fam].filter((f) => f !== "name");
  const verdict = s >= 7 && families.length >= 2 ? "verified" : s <= -3 ? "namesake" : s >= 4 ? "likely" : "unclear";
  return { score: s, verdict, reasons, families: [...fam] };
}

const GRADE = { verified: "v", likely: "p", unclear: "w", namesake: "i" };

export default {
  id: "identity",
  label: "Identity score for every candidate account",
  lane: "late",
  needs: ["name"],
  budgetMs: 5000,
  async run(ctx) {
    const { subject, shared } = ctx;
    const cands = gatherCandidates(shared);
    if (!cands.length) {
      ctx.miss("social.candidates", "no candidate accounts to score (search and sweep found none)");
      shared.identity = { candidates: [], verified: [], likely: [], namesakes: [] };
      return;
    }
    const scored = cands.map((c) => ({ ...c, ...scoreCandidate(c, subject, shared, cands) })).sort((a, b) => b.score - a.score);
    for (const c of scored.slice(0, 40)) {
      ctx.add({
        var: "social.candidates",
        value: `${c.verdict} (${c.score >= 0 ? "+" : ""}${c.score}): ${c.site || hostOf(c.url)}${c.handle ? ` @${c.handle}` : ""}${c.name || c.title ? ` — "${(c.name || c.title).slice(0, 60)}"` : ""} — ${c.reasons.join(", ") || "no anchors"}`,
        url: c.url,
        grade: GRADE[c.verdict],
        tier: "B",
        anchors: c.families,
        image: c.avatar || null,
        detail: { score: c.score, verdict: c.verdict, reasons: c.reasons, sources: c.sources, site: c.site, handle: c.handle || null, stage: "identity" },
      });
    }
    const by = (v) => scored.filter((c) => c.verdict === v);
    shared.identity = { candidates: scored, verified: by("verified").map((c) => c.url), likely: by("likely").map((c) => c.url), namesakes: by("namesake").map((c) => c.url) };
    const best = scored[0];
    ctx.add({ var: "social.candidates", value: `Identity check: ${by("verified").length} verified, ${by("likely").length} likely, ${by("unclear").length} unclear, ${by("namesake").length} namesake(s) of ${scored.length} candidates; strongest ${best.site} @${best.handle || hostOf(best.url)} (${best.score})`, grade: by("verified").length ? "v" : by("likely").length ? "p" : "w", tier: "B", detail: { verified: shared.identity.verified, likely: shared.identity.likely, namesakes: shared.identity.namesakes } });
  },
};
