// Sanctions, exclusions and court records for the person.
//   OFAC SDN + alternate names (Treasury CSV) and HHS-OIG LEIE (CSV): downloaded once a day into
//   work/osint/_lists/ and matched by surname + first name. Keyless.
//   OpenSanctions match API with OPENSANCTIONS_API_KEY.
//   CourtListener v4 search (federal dockets via RECAP, and opinions) with COURTLISTENER_TOKEN.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nameParts, normName, companyIn, blockedMiss, firstForms } from "../person-lib.mjs";
import { REPO } from "../run.mjs";

const LISTS = {
  sdn: { url: "https://www.treasury.gov/ofac/downloads/sdn.csv", label: "OFAC SDN" },
  alt: { url: "https://www.treasury.gov/ofac/downloads/alt.csv", label: "OFAC SDN alternate names" },
  leie: { url: "https://oig.hhs.gov/exclusions/downloadables/UPDATED.csv", label: "HHS-OIG LEIE" },
};

/** Minimal CSV line splitter (quoted fields, doubled quotes). */
export function csvLine(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") out.push(cur), (cur = "");
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Lines of a list whose text holds both the surname and the first name (or its initial for LEIE). */
export function screen(text, subject, kind) {
  const { first, last } = nameParts(subject.name);
  const forms = firstForms(first);
  const hits = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line || !line.toLowerCase().includes(last)) continue;
    const f = csvLine(line);
    if (kind === "leie") {
      const ln = normName(f[0]), fn = normName(f[1]);
      if (ln === last && (forms.includes(fn) || forms.includes(fn.split(" ")[0]))) hits.push({ name: `${f[1]} ${f[2] || ""} ${f[0]}`.replace(/\s+/g, " ").trim(), detail: { general: f[4], specialty: f[5], city: f[10], state: f[11], type: f[13], date: f[14] } });
    } else {
      const nm = normName(kind === "alt" ? f[3] : f[1]);
      const toks = nm.split(" ");
      if (toks.includes(last) && forms.some((f) => toks.includes(f))) hits.push({ name: kind === "alt" ? f[3] : f[1], detail: { ent_num: f[0], type: kind === "alt" ? f[2] : f[2], program: kind === "alt" ? null : f[3], remarks: kind === "alt" ? null : f[11] } });
    }
  }
  return hits;
}

async function loadList(http, id, log) {
  const dir = process.env.OSINT_LISTS_DIR || join(REPO, "work", "osint", "_lists");
  const file = join(dir, `${id}.csv`);
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < 24 * 3600e3) return { text: readFileSync(file, "utf8"), cached: true };
  const r = await http.get(LISTS[id].url, { timeout: 25000, cache: false });
  if (!r.ok || r.text.length < 1000) return { error: `HTTP ${r.status || r.error}` };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, r.text);
  log?.(`${id}: downloaded ${(r.text.length / 1e6).toFixed(1)} MB`);
  return { text: r.text, cached: false };
}

export default {
  id: "records",
  /** The ledger variables this module fills (config/form buckets read them to say "no tool yet"). */
  vars: ["rec.sanctions_detail", "rec.sanctions", "rec.courts"],
  label: "Sanctions, exclusions and court records",
  lane: "fast",
  needs: ["name"],
  env: ["OPENSANCTIONS_API_KEY", "COURTLISTENER_TOKEN"],
  budgetMs: 30000,
  async run(ctx) {
    const { subject, http, env, log } = ctx;
    const checked = [];
    const hits = [];
    const lists = await Promise.all(Object.keys(LISTS).map(async (id) => ({ id, ...(await loadList(http, id, log)) })));
    const perList = [];
    for (const l of lists) {
      if (l.error) {
        blockedMiss(ctx, "rec.sanctions", `${LISTS[l.id].label} download`, { status: Number(String(l.error).match(/\d+/)?.[0]) || 0, error: l.error }, "retry later; the list is cached for a day once it downloads");
        continue;
      }
      const h = screen(l.text, subject, l.id);
      const rows = l.text.split("\n").length;
      checked.push(`${LISTS[l.id].label} (${rows.toLocaleString("en-US")} rows)`);
      perList.push({ list: LISTS[l.id].label, rows, matches: h.length, names: h.slice(0, 3).map((x) => x.name).join("; ") || null, url: LISTS[l.id].url });
      // A per-list row only when the list names someone: a clean screen lives in the summary.
      if (h.length) ctx.add({ var: "rec.sanctions_detail", value: `${LISTS[l.id].label}: ${h.length} name match(es): ${h.slice(0, 3).map((x) => x.name).join("; ")} (${rows.toLocaleString("en-US")} rows screened)`, url: LISTS[l.id].url, grade: "w", tier: "A", detail: { list: l.id, hits: h.slice(0, 10), rows } });
      hits.push(...h.map((x) => ({ ...x, list: LISTS[l.id].label })));
    }

    if (env.OPENSANCTIONS_API_KEY) {
      const body = JSON.stringify({ queries: { q: { schema: "Person", properties: { name: [subject.name] } } } });
      const r = await http.get("https://api.opensanctions.org/match/default?algorithm=best", { method: "POST", body, headers: { authorization: `ApiKey ${env.OPENSANCTIONS_API_KEY}`, "content-type": "application/json", accept: "application/json" }, timeout: 15000 });
      let res = [];
      try {
        res = (JSON.parse(r.text).responses?.q?.results || []).filter((x) => x.score >= 0.7);
      } catch {}
      if (r.ok) {
        checked.push("OpenSanctions (global sanctions, PEPs, debarments)");
        ctx.add({ var: "rec.sanctions_detail", value: `OpenSanctions: ${res.length ? res.slice(0, 3).map((x) => `${x.caption} (${(x.datasets || []).slice(0, 2).join(", ")}, score ${x.score.toFixed(2)})`).join("; ") : "no match ≥ 0.70"}`, url: "https://www.opensanctions.org/search/?q=" + encodeURIComponent(subject.name), grade: "v", tier: "A", detail: res.slice(0, 5) });
        hits.push(...res.map((x) => ({ name: x.caption, list: "OpenSanctions", detail: { id: x.id, score: x.score, topics: x.properties?.topics } })));
      } else ctx.miss("rec.sanctions", `OpenSanctions: HTTP ${r.status || r.error}`);
    } else ctx.miss("rec.sanctions", "OpenSanctions (PEPs, global lists) not checked: needs OPENSANCTIONS_API_KEY");

    if (checked.length) {
      ctx.add({ var: "rec.sanctions", value: hits.length ? `Possible match on ${[...new Set(hits.map((h) => h.list))].join(", ")}: ${hits.slice(0, 3).map((h) => h.name).join("; ")} — check identity before relying on it` : `Clear: no match for ${subject.name} on ${checked.join(", ")}`, url: LISTS.sdn.url, grade: hits.length ? "w" : "v", tier: "A", detail: { lists: perList, hits: hits.slice(0, 10) } });
    }

    if (env.COURTLISTENER_TOKEN) {
      const H = { authorization: `Token ${env.COURTLISTENER_TOKEN}` };
      const q = encodeURIComponent(`"${subject.name}"`);
      const [dockets, opinions] = await Promise.all([
        http.json(`https://www.courtlistener.com/api/rest/v4/search/?type=r&q=${q}&order_by=dateFiled%20desc`, { headers: H, timeout: 15000 }),
        http.json(`https://www.courtlistener.com/api/rest/v4/search/?type=o&q=${q}&order_by=dateFiled%20desc`, { headers: H, timeout: 15000 }),
      ]);
      let n = 0;
      for (const [kind, r] of [["docket", dockets], ["opinion", opinions]]) {
        if (!r.ok) {
          ctx.miss("rec.courts", `CourtListener ${kind} search: HTTP ${r.status || r.error}`);
          continue;
        }
        for (const x of (r.data?.results || []).slice(0, 10)) {
          const name = x.caseName || x.case_name || "case";
          const text = `${name} ${(x.party || []).join(" ")} ${x.snippet || ""}`;
          const co = companyIn(text, subject);
          ctx.add({ var: "rec.courts", value: `${name} — ${x.court || x.court_id || ""}, filed ${x.dateFiled || "?"}${x.docketNumber ? `, ${x.docketNumber}` : ""}`, url: "https://www.courtlistener.com" + (x.docket_absolute_url || x.absolute_url || ""), date: x.dateFiled || null, grade: co ? "p" : "w", tier: "C", anchors: co ? ["name", "company"] : ["name"], detail: { kind, court: x.court, cause: x.cause, nature: x.suitNature, parties: (x.party || []).slice(0, 8) } });
          n++;
        }
      }
      if (!n && dockets.ok) ctx.add({ var: "rec.courts", value: `No federal dockets or opinions naming "${subject.name}" (CourtListener RECAP + opinions)`, url: `https://www.courtlistener.com/?q=${q}`, grade: "v", tier: "A" });
    } else ctx.miss("rec.courts", "CourtListener not checked: needs a free COURTLISTENER_TOKEN (the API returns 401 without one); state courts are not covered by any free API");
  },
};
