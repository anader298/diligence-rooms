// Patents where he is an inventor. Google Patents' xhr/query endpoint answers JSON with no key
// (measured 19 Nov 2026, under a second). Family members (US, EP, WO copies of one invention)
// are collapsed by title. With PATENTSVIEW_API_KEY (free) the PatentsView inventor endpoint
// adds the inventor's last known city and state.

import { nameParts, normName, companyIn, hobbiesIn, stripTags } from "../person-lib.mjs";

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
  label: "Patents as inventor (Google Patents; PatentsView with key)",
  lane: "fast",
  needs: ["name"],
  env: ["PATENTSVIEW_API_KEY"],
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
      ctx.miss("career.patents", `Google Patents xhr: HTTP ${r.status || r.error}${/Sorry\.\.\./.test(r.text || "") ? " (Google's unusual-traffic page for this IP; clears on its own)" : ""} — patents not checked, unknown rather than none`);
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

    if (env.PATENTSVIEW_API_KEY) {
      const q = JSON.stringify({ _and: [{ inventor_name_first: first.replace(/^./, (c) => c.toUpperCase()) }, { inventor_name_last: last.replace(/^./, (c) => c.toUpperCase()) }] });
      const f = JSON.stringify(["inventor_id", "inventor_name_first", "inventor_name_last", "inventor_lastknown_city", "inventor_lastknown_state", "inventor_lastknown_country", "inventor_num_patents"]);
      const pv = await http.json(`https://search.patentsview.org/api/v1/inventor/?q=${encodeURIComponent(q)}&f=${encodeURIComponent(f)}`, { headers: { "X-Api-Key": env.PATENTSVIEW_API_KEY }, timeout: 12000 });
      for (const inv of pv.data?.inventors || []) {
        const city = inv.inventor_lastknown_city, st = inv.inventor_lastknown_state;
        if (!city) continue;
        ctx.add({ var: "place.home_metro", value: `${city}, ${st || inv.inventor_lastknown_country} (PatentsView inventor's last known city, ${inv.inventor_num_patents ?? "?"} patents)`, url: `https://datatool.patentsview.org/#search/inventor&inv=${inv.inventor_id}`, grade: "p", tier: "A", anchors: ["name"], detail: inv });
      }
      if (!pv.ok) ctx.miss("place.home_metro", `PatentsView: HTTP ${pv.status || pv.error}`);
    } else if (shared.patents?.length) {
      ctx.miss("place.home_metro", "inventor city not read: Google Patents does not expose it; set PATENTSVIEW_API_KEY (free) to add it");
    }
  },
};
