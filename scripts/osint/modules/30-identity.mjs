// Identity scoring (late lane): is each candidate account really this person, or a namesake?
// Additive score over what the other modules found:
//   name matches the display name or title                 +2   (family: name)
//   employer stated on the profile is the company           +5   (family: company)
//   company named in bio, title or snippet                  +4   (family: company)
//   stated employer is one the news ties to the subject     +4   (family: career; e.g. his new job)
//   linked from an official page, Wikidata or --handles     +4   (family: link)
//   city or state matches a known place                     +2   (family: place)
//   title words match the subject's title                   +2   (family: title)
//   headshot reused (reverse image) / same avatar           +3   (family: image)
//   same handle on another site whose account is anchored   +2   (family: handle)
//   contradicting employer or place                         -3 each
// The handle bonus never fires on a handle alone: the sweep derives handles from the name, so two
// strangers called Steve Ferrante share "steveferrante" by construction.
// Verdicts: verified = 7+ with two anchor families beyond the name (or the profile's own employer
// field naming the company); likely = 4+ with at least one anchor beyond name and handle;
// namesake = a contradiction and no anchor; otherwise unclear (the name alone).
// Only verified and likely accounts become social.accounts; the rest are social.candidates.

import { nameMatch, nameAdjacent, nameIn, companyIn, placeIn, knownPlaces, handleFromUrl, hostOf, normName, derivedHandles } from "../person-lib.mjs";

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
  for (const a of shared.accounts || []) put({ site: a.site, handle: a.handle, url: a.url, name: a.name, bio: a.bio, company: a.company, location: a.location, avatar: a.avatar, source: "sweep:" + a.source, followers: a.followers ?? null, extra: a.extra || null });
  for (const p of shared.searchProfiles || []) put({ site: p.platform, handle: p.handle || handleFromUrl(p.url), url: p.url, title: p.title, snippet: p.snippet, source: "search" });
  for (const w of shared.wikidataAccounts || []) put({ site: w.site, handle: w.handle, url: w.url, source: "wikidata", wikidataAnchors: w.anchors });
  return [...out.values()];
}

const COUNTRY = /\b(united states|usa|united kingdom|uk|canada|australia|germany|france|india|japan|china|singapore|ireland|netherlands|israel|brazil|mexico|spain|italy|sweden|switzerland)\b/i;
const STATE_RE = /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b/i;
/** A LinkedIn title segment that is a place ("McLean, Virginia, United States", "Greater Chicago Area"). */
export function isPlace(seg) {
  const s = String(seg || "").replace(/\|.*$/, "").trim();
  if (!s) return false;
  return (/,/.test(s) && (COUNTRY.test(s) || STATE_RE.test(s))) || /\b(metropolitan area|greater .+ area|bay area|area)$/i.test(s) || /^[A-Z][a-z]+(?: [A-Z][a-z]+)*, [A-Z]{2}$/.test(s);
}

/** The employer the profile itself states: LinkedIn "Name - Employer | LinkedIn", or a company field. */
export function statedCompany(c) {
  const clean = (x) => {
    const s = String(x || "").replace(/\s*\|\s*(LinkedIn|Professional).*$/i, "").replace(/\.\.\.$|…$/, "").trim();
    return s && !isPlace(s) && !/^(professional|profile|linkedin)/i.test(s) ? s : null;
  };
  if (c.company) return clean(String(c.company).replace(/^@/, ""));
  const t = c.title || "";
  if (c.site === "linkedin") {
    const m = t.replace(/\s*\|\s*LinkedIn.*$/, "").split(" - ");
    if (m.length > 1) return clean(m.at(-1));
    const exp = String(c.snippet || c.bio || "").match(/Experience:\s*([^·|]+?)\s*(?:·|$)/);
    if (exp) return clean(exp[1]);
  }
  return null;
}

const CO_STRIP = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|company|co|plc|gmbh|group|holdings)\b/g;
/** Texts (search results, news) that name the subject together with the company. */
export function careerTexts(subject, shared = {}) {
  const out = [];
  for (const r of [...(shared.searchResults || []), ...(shared.newsItems || [])]) {
    const t = `${r.title || ""} ${r.snippet || ""}`;
    if (nameMatch(t, subject) && companyIn(t, subject)) out.push({ text: t, url: r.url, title: r.title || "" });
  }
  return out;
}
/** True when a name+company text also names this other employer: a past or next job, not a namesake. */
function knownEmployer(co, texts) {
  const core = normName(co).replace(CO_STRIP, " ").replace(/\s+/g, " ").trim();
  if (core.length < 4) return null;
  return texts.find((x) => (" " + normName(x.text) + " ").includes(" " + core + " ")) || null;
}

const GENERIC_TITLE = new Set("vice president senior director manager head of and the chief officer executive general global lead principal associate assistant deputy group svp evp vp sr jr business".split(" "));
function titleWordsOf(t) {
  return normName(t).split(" ").filter((w) => w.length > 3 && !GENERIC_TITLE.has(w));
}

export function scoreCandidate(c, subject, sharedIn = {}, all = [], ctx = {}) {
  // A place this candidate reported itself cannot anchor it.
  const shared = { ...sharedIn, places: (sharedIn.places || []).filter((p) => typeof p === "string" || p.from !== c.url) };
  const derived = ctx.derived || new Set(derivedHandles(subject).map((h) => h.toLowerCase()));
  const texts = ctx.texts || careerTexts(subject, sharedIn);
  const reasons = [];
  const fam = new Set();
  let s = 0;
  let contra = false;
  let otherEmployer = null;
  const text = [c.name, c.title, c.bio, c.snippet, c.company, c.location].filter(Boolean).join(" · ");
  const named = nameMatch(c.name || c.title || "", subject) || (!c.name && !c.title && nameMatch(c.snippet || "", subject));
  if (named) {
    s += 2;
    reasons.push("name +2");
    fam.add("name");
  }
  const co = statedCompany(c);
  if (co && companyIn(co, subject)) {
    s += 5;
    reasons.push("employer on profile +5");
    fam.add("company");
    fam.add("employer");
  } else if (companyIn(text, subject) || (c.wikidataAnchors || []).includes("company")) {
    s += 4;
    reasons.push("company +4");
    fam.add("company");
  } else if (co && subject.company && normName(co).length > 2 && !/^(self|self employed|freelance|retired|n a|none|student|stealth)$/.test(normName(co))) {
    const hit = named ? knownEmployer(co, texts) : null;
    if (hit) {
      s += 4;
      reasons.push(`employer "${co}" named with ${subject.company} in "${hit.title.slice(0, 70)}" +4`);
      fam.add("career");
      otherEmployer = { name: co, evidence: hit.url, title: hit.title };
    } else {
      s -= 3;
      contra = true;
      reasons.push(`other company "${co}" -3`);
    }
  }
  const official = new Set((sharedIn.officialLinks || []).map((u) => String(u).toLowerCase().replace(/\/$/, "")));
  if (official.has(String(c.url || "").toLowerCase().replace(/\/$/, "")) || (c.sources || []).includes("wikidata") && (c.wikidataAnchors || []).includes("company") || (c.sources || []).includes("sweep:given")) {
    s += 4;
    reasons.push((c.sources || []).includes("sweep:given") ? "handle given by you +4" : "linked from an official page +4");
    fam.add("link");
  }
  const places = knownPlaces(subject, shared);
  const loc = c.location || (c.snippet || c.bio || "").match(/Location:\s*([^·|]+)/)?.[1] || null;
  if (placeIn(text, subject, shared)) {
    s += 2;
    reasons.push("place +2");
    fam.add("place");
  } else if (loc && places.length && !placeIn(loc, subject, shared)) {
    s -= 3;
    contra = true;
    reasons.push(`other place "${loc.trim()}" -3`);
  }
  const tw = titleWordsOf([subject.title, sharedIn.roleTitle].filter(Boolean).join(" "));
  if (named && tw.length && tw.some((w) => (" " + normName(text) + " ").includes(" " + w + " "))) {
    s += 2;
    reasons.push("title words +2");
    fam.add("title");
  }
  const rev = (sharedIn.reverseHits || []).find((h) => (c.handle && String(h.page).toLowerCase().includes(String(c.handle).toLowerCase()) && hostOf(h.page).includes(c.site)) || String(h.page).replace(/\/$/, "") === String(c.url).replace(/\/$/, ""));
  if (rev || (c.avatar && sharedIn.headshot && c.avatar === sharedIn.headshot && sharedIn.headshotFrom && !sharedIn.headshotFrom.startsWith(c.site))) {
    s += 3;
    reasons.push("headshot reused +3");
    fam.add("image");
  }
  // Same handle elsewhere counts only when that other account has its own anchor beyond the name,
  // and never for a handle we derived from the name ourselves.
  if (c.handle && named && !derived.has(String(c.handle).toLowerCase())) {
    const same = all.filter((o) => o !== c && o.handle && o.site !== c.site && o.handle.toLowerCase() === c.handle.toLowerCase() && (o.hard ?? peerAnchored(o, subject, sharedIn)));
    if (same.length) {
      s += 2;
      reasons.push(`same handle on anchored ${same.map((o) => o.site).join(", ")} +2`);
      fam.add("handle");
    }
  }
  const hard = [...fam].filter((f) => f !== "name" && f !== "handle" && f !== "employer");
  // The employer field alone verifies only under the exact name given (or an alias), not a
  // nickname or formal variant: "Steven Ferrante - Lumen Arcade" stays likely for "Steve Ferrante".
  const shown = c.name || c.title || "";
  const exactName = [subject.name, ...(subject.aliases || [])].filter(Boolean).some((n) => nameIn(shown, n) && nameAdjacent(shown, n));
  const exactEmployer = fam.has("employer") && named && exactName;
  const verdict =
    named && s >= 7 && (hard.length + (fam.has("handle") ? 1 : 0) >= 2 || exactEmployer)
      ? "verified"
      : (contra && !hard.length) || s <= -3
        ? "namesake"
        : named && hard.length && s >= 4
          ? "likely"
          : "unclear";
  return { score: s, verdict, reasons, families: [...fam].filter((f) => f !== "employer"), otherEmployer };
}

/** A peer account's own anchor (company, place, image or link), without the handle rule. */
function peerAnchored(o, subject, shared) {
  const t = [o.name, o.title, o.bio, o.snippet, o.company, o.location].filter(Boolean).join(" · ");
  return companyIn(t, subject) || placeIn(t, subject, shared) || (o.avatar && shared.headshot && o.avatar === shared.headshot) || (o.sources || []).includes("sweep:given");
}

/** Score every candidate (for the identity module, and for the profiles module before it). */
export function scoreAll(subject, shared = {}) {
  const cands = gatherCandidates(shared);
  const ctx = { derived: new Set(derivedHandles(subject).map((h) => h.toLowerCase())), texts: careerTexts(subject, shared) };
  return cands.map((c) => ({ ...c, ...scoreCandidate(c, subject, shared, cands, ctx) })).sort((a, b) => b.score - a.score);
}

const DEPART = /\b(former|formerly|ex-|quits?|leaves|leaving|departs?|departed|departure|exits?|exited|steps? down|stepping down|stepped down|resigns?|resigned|retires|retiring|retirement)\b/i;
const JOIN = /\b(joins|joined|joining|appointed|hired|taps|tapped|moves to|new role at|takes up (?:a )?new role)\b/i;
const ROLE = /\b(chief|officer|president|ceo|cfo|cto|coo|cmo|cro|vp|vice president|head of|general manager|director|partner|board)\b/i;
/**
 * Signs the subject has left the company: a name+company headline that says former/quits/leaves,
 * or says joins/appointed to a role somewhere the company is not named, or a likely profile whose
 * own employer field is another employer the news ties to the subject.
 */
export function departureSignals(subject, shared = {}, scored = []) {
  const out = [];
  const seen = new Set();
  for (const x of careerTexts(subject, shared)) {
    const head = x.title || x.text;
    const near = /\bformer(?:ly)?\b[^.]{0,60}/i.exec(x.text);
    const formerCo = near && companyIn(near[0], subject);
    const parts = head.split(JOIN);
    const joinsElsewhere = parts.length > 2 && !companyIn(parts.slice(2).join(" "), subject) && ROLE.test(parts.slice(2).join(" "));
    if (!(formerCo || DEPART.test(head) || joinsElsewhere)) continue;
    const k = normName(head).slice(0, 50);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ kind: "news", text: head.slice(0, 160), url: x.url });
  }
  for (const c of scored) if ((c.verdict === "likely" || c.verdict === "verified") && c.otherEmployer) out.push({ kind: "profile", text: `${c.site} profile states employer "${c.otherEmployer.name}"`, url: c.url, employer: c.otherEmployer.name });
  return out;
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
    const scored = scoreAll(subject, shared);
    if (!scored.length) {
      ctx.miss("social.candidates", "no candidate accounts to score (search and sweep found none)");
      shared.identity = { candidates: [], verified: [], likely: [], namesakes: [] };
    } else {
      const by = (v) => scored.filter((c) => c.verdict === v);
      const line = (c) => `${c.site || hostOf(c.url)}${c.handle ? ` @${c.handle}` : ""}${c.name || c.title ? ` — "${String(c.name || c.title).slice(0, 70)}"` : ""}`;
      const detailOf = (c) => ({ score: c.score, verdict: c.verdict, reasons: c.reasons, sources: c.sources, site: c.site, handle: c.handle || null, bio: c.bio ? String(c.bio).slice(0, 200) : null, location: c.location || null, followers: c.followers ?? null, stage: "identity" });
      // Verified and likely: the subject's accounts. One row each, avatar shown.
      for (const c of [...by("verified"), ...by("likely")]) {
        ctx.add({ var: "social.accounts", value: `${line(c)} — ${c.verdict} (${c.score >= 0 ? "+" : ""}${c.score}: ${c.reasons.join(", ")})`, url: c.url, grade: GRADE[c.verdict], tier: "B", anchors: c.families, image: c.avatar || null, detail: detailOf(c) });
      }
      // Unclear accounts that carry the name, and namesakes ruled out: candidates, no pictures.
      const rest = [...by("unclear").filter((c) => c.families.includes("name")), ...by("namesake")].slice(0, 25);
      for (const c of rest) {
        ctx.add({ var: "social.candidates", value: `${c.verdict} (${c.score >= 0 ? "+" : ""}${c.score}): ${line(c)} — ${c.reasons.join(", ") || "no anchors"}`, url: c.url, grade: GRADE[c.verdict], tier: "B", anchors: c.families, detail: detailOf(c) });
      }
      const mine = [...by("verified"), ...by("likely")].filter((c) => c.handle);
      if (mine.length) {
        const byHandle = {};
        for (const c of mine) (byHandle[String(c.handle).toLowerCase()] ||= []).push(c.site);
        ctx.add({ var: "social.handles", value: Object.entries(byHandle).map(([h, s]) => `${h} (${s.join(", ")})`).join("; "), grade: by("verified").length ? "p" : "w", tier: "B", detail: byHandle });
      }
      const noise = scored.filter((c) => !rest.includes(c) && c.verdict === "unclear");
      shared.identity = { candidates: scored, verified: by("verified").map((c) => c.url), likely: by("likely").map((c) => c.url), namesakes: by("namesake").map((c) => c.url) };
      const best = scored[0];
      ctx.add({
        var: "social.candidates",
        value: `Identity check: ${by("verified").length} verified, ${by("likely").length} likely, ${by("unclear").length} unclear (name only), ${by("namesake").length} namesake(s) of ${scored.length} candidates; strongest ${best.site} @${best.handle || hostOf(best.url)} (${best.score})`,
        grade: by("verified").length ? "v" : by("likely").length ? "p" : "w",
        tier: "B",
        detail: { verdict: "summary", verified: shared.identity.verified, likely: shared.identity.likely, namesakes: shared.identity.namesakes, unanchored: noise.map((c) => `${c.site} @${c.handle || hostOf(c.url)}${c.name ? ` "${String(c.name).slice(0, 40)}"` : ""}`) },
      });
    }
    // Has the subject left the company? run.mjs checks news and filings before this lane and sets
    // shared.departed; this adds what only the identity score sees (a likely profile naming a new
    // employer the news ties to him), and raises it only when that check found nothing.
    const dep = departureSignals(subject, shared, scored);
    if (dep.length && !shared.departed) {
      const news = dep.find((d) => d.kind === "news");
      const prof = dep.find((d) => d.kind === "profile");
      const text = `${subject.name} may have left ${subject.company || "the company"}: ${[news && `"${news.text}"`, prof && prof.text].filter(Boolean).join("; ")}`;
      const row = ctx.add({ var: "role.status", tab: "professional", label: "Still in the seat?", group: "The seat", value: text, url: (news || prof).url, grade: news && prof ? "p" : "w", tier: "C", detail: { alert: { level: "red", text }, signals: dep.slice(0, 6) } });
      (shared.alerts ||= []).push({ level: "red", text, url: (news || prof).url, ledger: row?.id || null });
    }
  },
};
