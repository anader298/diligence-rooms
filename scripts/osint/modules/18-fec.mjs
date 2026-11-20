// Federal political donations (FEC Schedule A, individual contributions). One call by name
// ("LAST, FIRST"), up to 100 most recent records, matched locally: name + employer is a strong
// match, name + city/state partial, name alone weak. FEC_API_KEY (free) or the shared DEMO_KEY.

import { nameParts, companyIn, placeIn, normName } from "../person-lib.mjs";

const money = (n) => "$" + Math.round(n).toLocaleString("en-US");
const PARTY = { DEM: "Democratic", REP: "Republican", LIB: "Libertarian", GRE: "Green", IND: "Independent" };

/** Score one Schedule A record against the subject. */
export function matchDonation(rec, subject, shared = {}) {
  const { first } = nameParts(subject.name);
  const fn = normName(rec.contributor_first_name || String(rec.contributor_name || "").split(",")[1] || "").split(" ")[0];
  const nick = { rick: "richard", rich: "richard", bob: "robert", bill: "william", jim: "james", mike: "michael", gabe: "gabriel", tom: "thomas", dave: "david", steve: "steven", chris: "christopher", dan: "daniel", matt: "matthew", tony: "anthony" };
  const firstOk = fn === first || nick[fn] === first || nick[first] === fn || (fn.length === 1 && fn === first[0]);
  if (!firstOk) return null;
  const anchors = ["name"];
  if (companyIn(`${rec.contributor_employer || ""}`, subject)) anchors.push("company");
  if (placeIn(`${rec.contributor_city || ""} ${rec.contributor_state || ""}`, subject, shared)) anchors.push("place");
  const grade = anchors.includes("company") && anchors.includes("place") ? "v" : anchors.length > 1 ? "p" : "w";
  return { anchors, grade };
}

export function donationRow(rec, m) {
  const c = rec.committee || {};
  const to = c.name || rec.committee_name || rec.committee_id;
  return {
    var: "politics.donations",
    value: `${money(rec.contribution_receipt_amount)} to ${to}, ${String(rec.contribution_receipt_date || "").slice(0, 10)}`,
    url: rec.pdf_url || `https://www.fec.gov/data/receipts/individual-contributions/?contributor_name=${encodeURIComponent(rec.contributor_name || "")}`,
    grade: m.grade,
    tier: "A",
    anchors: m.anchors,
    date: String(rec.contribution_receipt_date || "").slice(0, 10) || null,
    detail: { committee: to, committee_id: rec.committee_id, party: c.party || null, employer: rec.contributor_employer, occupation: rec.contributor_occupation, city: rec.contributor_city, state: rec.contributor_state, zip: rec.contributor_zip, name_on_record: rec.contributor_name, memo: rec.memo_text || null },
  };
}

export default {
  id: "fec",
  label: "Political donations (FEC)",
  lane: "fast",
  needs: ["name"],
  env: ["FEC_API_KEY"],
  budgetMs: 20000,
  async run(ctx) {
    const { subject, http, env, shared } = ctx;
    const key = env.FEC_API_KEY || "DEMO_KEY";
    const { first, last } = nameParts(subject.name);
    const names = [`${last}, ${first}`, ...(subject.aliases || []).map((a) => { const p = nameParts(a); return `${p.last}, ${p.first}`; })];
    const recs = [];
    for (const n of [...new Set(names)].slice(0, 2)) {
      const url = `https://api.open.fec.gov/v1/schedules/schedule_a/?api_key=${key}&contributor_name=${encodeURIComponent(n)}&per_page=100&sort=-contribution_receipt_date&is_individual=true`;
      const r = await http.json(url, { timeout: 15000 });
      if (!r.ok) {
        ctx.miss("politics.donations", `FEC API HTTP ${r.status || r.error}${r.status === 429 ? ` (${key === "DEMO_KEY" ? "the shared DEMO_KEY allows 40 calls an hour; set FEC_API_KEY, free at api.data.gov" : "rate limited"})` : ""} — donations not checked, unknown rather than none`);
        return;
      }
      recs.push(...(r.data?.results || []));
    }
    const seen = new Set();
    const matched = [];
    for (const rec of recs) {
      if (seen.has(rec.sub_id)) continue;
      seen.add(rec.sub_id);
      const m = matchDonation(rec, subject, shared);
      if (m) matched.push({ rec, m });
    }
    if (!matched.length) {
      ctx.add({ var: "cause.political", value: `No federal contributions on record for ${subject.name} (FEC Schedule A, ${recs.length} records under the surname checked)`, url: `https://www.fec.gov/data/receipts/individual-contributions/?contributor_name=${encodeURIComponent(`${last}, ${first}`)}`, grade: "v", tier: "A", detail: { checked: recs.length } });
      return;
    }
    const strong = matched.filter((x) => x.m.anchors.length > 1);
    const use = strong.length ? strong : matched;
    for (const x of use.slice(0, 25)) ctx.add(donationRow(x.rec, x.m));
    // Summary: totals by party and top committees.
    const byParty = {}, byCmte = {};
    let total = 0;
    for (const { rec } of use) {
      const amt = Number(rec.contribution_receipt_amount) || 0;
      total += amt;
      const p = PARTY[rec.committee?.party] || rec.committee?.party_full || "no party listed";
      byParty[p] = (byParty[p] || 0) + amt;
      const c = rec.committee?.name || rec.committee_id;
      byCmte[c] = (byCmte[c] || 0) + amt;
    }
    const dates = use.map((x) => String(x.rec.contribution_receipt_date || "").slice(0, 4)).filter(Boolean).sort();
    const top = Object.entries(byCmte).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const emp = [...new Set(use.map((x) => x.rec.contributor_employer).filter(Boolean))].slice(0, 3);
    ctx.add({
      var: "cause.political",
      value: `${use.length} federal contribution(s), ${money(total)}${dates.length ? `, ${dates[0]}–${dates.at(-1)}` : ""}: ${Object.entries(byParty).map(([p, v]) => `${p} ${money(v)}`).join(", ")}; top ${top.map(([c, v]) => `${c} ${money(v)}`).join("; ")}${emp.length ? `; employer on record: ${emp.join(", ")}` : ""}${strong.length ? "" : " (name match only — could be a namesake)"}`,
      url: `https://www.fec.gov/data/receipts/individual-contributions/?contributor_name=${encodeURIComponent(`${last}, ${first}`)}`,
      grade: strong.length ? (strong.some((x) => x.m.grade === "v") ? "v" : "p") : "w",
      tier: "A",
      anchors: [...new Set(use.flatMap((x) => x.m.anchors))],
      detail: { byParty, byCommittee: byCmte, total, n: use.length, strong: strong.length, nameOnly: matched.length - strong.length },
    });
    const pl = use.find((x) => x.m.anchors.includes("company"));
    if (pl) {
      if (pl.rec.contributor_city) shared.places = [...(shared.places || []), { place: pl.rec.contributor_city, from: "fec" }];
      ctx.add({ var: "place.home_metro", value: `${pl.rec.contributor_city}, ${pl.rec.contributor_state} ${pl.rec.contributor_zip ? String(pl.rec.contributor_zip).slice(0, 5) : ""} (FEC donor address, employer ${pl.rec.contributor_employer})`.trim(), url: donationRow(pl.rec, pl.m).url, grade: "p", tier: "A", anchors: pl.m.anchors, date: String(pl.rec.contribution_receipt_date || "").slice(0, 10) });
    }
  },
};
