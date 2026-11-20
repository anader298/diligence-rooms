// Federal political donations (FEC Schedule A, individual contributions). Up to two calls by name
// ("LAST, FIRST" for the given and the formal first name: Jenny and Jennifer), 100 most recent
// records each, matched locally with nickname forms. Grade p needs an anchor beyond the name: the
// employer on the record, or a city/state already tied to the subject; name-only records are weak
// (possible namesakes). FEC_API_KEY (free at api.data.gov) or the shared DEMO_KEY, nothing else.
// A 429 is recorded as unknown, never as "no donations".

import { nameParts, companyIn, placeIn, normName, firstForms, blockedMiss } from "../person-lib.mjs";

const money = (n) => "$" + Math.round(n).toLocaleString("en-US");
const PARTY = { DEM: "Democratic", REP: "Republican", LIB: "Libertarian", GRE: "Green", IND: "Independent" };

/** Score one Schedule A record against the subject. */
export function matchDonation(rec, subject, shared = {}) {
  const { first, last } = nameParts(subject.name);
  const ln = normName(rec.contributor_last_name || String(rec.contributor_name || "").split(",")[0] || "");
  if (ln && last && !ln.split(" ").includes(last)) return null;
  const fn = normName(rec.contributor_first_name || String(rec.contributor_name || "").split(",")[1] || "").split(" ")[0];
  const forms = firstForms(first);
  const firstOk = forms.includes(fn) || firstForms(fn).some((f) => forms.includes(f)) || (fn.length === 1 && fn === first[0]);
  if (!firstOk) return null;
  const anchors = ["name"];
  if (companyIn(`${rec.contributor_employer || ""}`, subject)) anchors.push("company");
  if (placeIn(`${rec.contributor_city || ""} ${rec.contributor_state || ""}`, subject, shared)) anchors.push("place");
  // v: employer and place agree; p: one anchor beyond the name; w: the name alone (maybe a namesake).
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
  /** The ledger variables this module fills (config/form buckets read them to say "no tool yet"). */
  vars: ["politics.donations", "cause.political", "place.home_metro"],
  label: "Political donations (FEC)",
  lane: "fast",
  needs: ["name"],
  env: ["FEC_API_KEY"],
  budgetMs: 20000,
  async run(ctx) {
    const { subject, http, env, shared } = ctx;
    const key = env.FEC_API_KEY || "DEMO_KEY";
    const { first, last } = nameParts(subject.name);
    const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
    // The given first name, then its formal form (Jenny -> Jennifer), then aliases. Donors file
    // under their legal name, people are introduced by the short one.
    const formal = firstForms(first).filter((f) => f !== first && f.length > first.length);
    const names = [`${cap(last)}, ${cap(first)}`, ...formal.slice(0, 1).map((f) => `${cap(last)}, ${cap(f)}`), ...(subject.aliases || []).map((a) => { const p = nameParts(a); return `${cap(p.last)}, ${cap(p.first)}`; })];
    const recs = [];
    let checked = 0;
    for (const n of [...new Set(names)].slice(0, 2)) {
      const url = `https://api.open.fec.gov/v1/schedules/schedule_a/?api_key=${key}&contributor_name=${encodeURIComponent(n)}&per_page=100&sort=-contribution_receipt_date&is_individual=true`;
      const r = await http.json(url, { timeout: 15000 });
      if (!r.ok) {
        const fix = key === "DEMO_KEY" ? "set FEC_API_KEY (free at api.data.gov); the shared DEMO_KEY allows about 40 calls an hour" : "rate limited; retry later";
        if (checked) ctx.miss("politics.donations", `FEC query "${n}": blocked (HTTP ${r.status || r.error}), unknown · fix: ${fix}`, { blocked: true });
        else {
          blockedMiss(ctx, "politics.donations", "FEC API", r, fix);
          ctx.miss("cause.political", `FEC donations: blocked (HTTP ${r.status || r.error}), unknown rather than none · fix: ${fix}`, { blocked: true });
          return;
        }
        break;
      }
      checked++;
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
      ctx.add({ var: "cause.political", value: `No federal contributions on record for ${subject.name} (FEC Schedule A, ${recs.length} records under ${[...new Set(names)].slice(0, checked).join(" and ")} checked)`, url: `https://www.fec.gov/data/receipts/individual-contributions/?contributor_name=${encodeURIComponent(`${last}, ${first}`)}`, grade: "v", tier: "A", detail: { checked: recs.length, names: [...new Set(names)].slice(0, checked) } });
      return;
    }
    const strong = matched.filter((x) => x.m.anchors.length > 1);
    const use = strong.length ? strong : matched;
    // Name-only records (no employer, no known place) stay in the summary row as possible namesakes.
    // Anchored records: one row per committee (a payroll PAC deduction twice a month is one fact,
    // not 80 rows), with count, total and date range; single gifts keep their own row.
    if (strong.length) {
      const byC = new Map();
      for (const x of strong) {
        const k = x.rec.committee?.name || x.rec.committee_id;
        if (!byC.has(k)) byC.set(k, []);
        byC.get(k).push(x);
      }
      for (const list of [...byC.values()].sort((a, b) => b.length - a.length).slice(0, 12)) {
        if (list.length === 1) {
          ctx.add(donationRow(list[0].rec, list[0].m));
          continue;
        }
        const row = donationRow(list[0].rec, list[0].m);
        const amt = list.reduce((a, x) => a + (Number(x.rec.contribution_receipt_amount) || 0), 0);
        const ds = list.map((x) => String(x.rec.contribution_receipt_date || "").slice(0, 10)).filter(Boolean).sort();
        ctx.add({ ...row, value: `${money(amt)} to ${row.detail.committee} in ${list.length} contributions, ${ds[0]} to ${ds.at(-1)}`, date: ds.at(-1) || row.date, grade: list.some((x) => x.m.grade === "v") ? "v" : "p", detail: { ...row.detail, count: list.length, amount: amt, first: ds[0], last: ds.at(-1) } });
      }
    }
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
      detail: { byParty, byCommittee: byCmte, total, count: use.length, n: use.length, strong: strong.length, nameOnly: matched.length - strong.length },
    });
    const pl = use.find((x) => x.m.anchors.includes("company"));
    if (pl) {
      if (pl.rec.contributor_city) shared.places = [...(shared.places || []), { place: pl.rec.contributor_city, from: "fec" }];
      ctx.add({ var: "place.home_metro", value: `${pl.rec.contributor_city}, ${pl.rec.contributor_state} ${pl.rec.contributor_zip ? String(pl.rec.contributor_zip).slice(0, 5) : ""} (FEC donor address, employer ${pl.rec.contributor_employer})`.trim(), url: donationRow(pl.rec, pl.m).url, grade: "p", tier: "A", anchors: pl.m.anchors, date: String(pl.rec.contribution_receipt_date || "").slice(0, 10) });
    }
  },
};
