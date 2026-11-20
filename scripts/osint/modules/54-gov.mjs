// Government money and influence: federal awards (USAspending), lobbying (lda.gov) and a
// company PAC (FEC committees). All keyless; FEC uses FEC_API_KEY, else the public DEMO_KEY
// (40 calls an hour, shared). A rate-limited FEC call is recorded as not checked.
import { normCompany, sameCompany, money, isCompanyPac } from "../colib.mjs";

// the record names the company itself, not another company sharing a word with it
const same = (a, b) => sameCompany(a, b);

const USA = "https://api.usaspending.gov/api/v2/search/spending_by_award/";

/** Every page of a USAspending award search (100 a page, up to `max` pages). */
export async function usaspendingAll(http, filters, { max = 5, sort = "Award Amount" } = {}) {
  const body = { filters, fields: ["Award ID", "Recipient Name", "Award Amount", "Awarding Agency", "Start Date", "Description"], limit: 100, sort, order: "desc" };
  const all = [];
  let more = true;
  let status = null;
  let pages = 0;
  for (let page = 1; more && page <= max; page++) {
    const r = await http.get(USA, { method: "POST", body: JSON.stringify({ ...body, page }), headers: { "content-type": "application/json", accept: "application/json" }, timeout: 20000 });
    status = r.status || r.error;
    let d = null;
    try {
      d = JSON.parse(r.text);
    } catch {
      d = null;
    }
    if (!d?.results) {
      if (page === 1) return { error: status, results: null };
      break;
    }
    pages++;
    all.push(...d.results);
    more = !!d.page_metadata?.hasNext;
  }
  return { results: all, more, pages };
}

async function usaspending(ctx) {
  const { http, add, miss, subject } = ctx;
  const filters = { recipient_search_text: [subject.company], award_type_codes: ["A", "B", "C", "D"], time_period: [{ start_date: "2007-10-01", end_date: new Date().toISOString().slice(0, 10) }] };
  const res = await usaspendingAll(http, filters);
  if (!res.results) {
    if ([403, 429].includes(res.error)) ctx.status?.("blocked", `USAspending ${res.error}`);
    return miss("co.gov", `USAspending ${res.error}: not checked`, { blocked: true });
  }
  const rows = res.results.filter((x) => same(subject.company, x["Recipient Name"]));
  const related = [...new Set(res.results.filter((x) => !same(subject.company, x["Recipient Name"])).map((x) => x["Recipient Name"]))];
  const web = `https://www.usaspending.gov/search/?hash=&keyword=${encodeURIComponent(subject.company)}`;
  if (!rows.length) return add({ var: "co.gov", value: `No federal contracts to "${subject.company}" in USAspending (FY2008-now)${related.length ? `; ${related.length} similarly named recipient${related.length === 1 ? "" : "s"} not counted (e.g. ${related.slice(0, 2).join("; ")})` : ""}`, url: web, grade: res.more || related.length ? "p" : "v", tier: "A", detail: { otherRecipients: related.slice(0, 5), pagesRead: res.pages, truncated: res.more } });
  const total = rows.reduce((s, x) => s + (x["Award Amount"] || 0), 0);
  const agencies = {};
  for (const x of rows) agencies[x["Awarding Agency"]] = (agencies[x["Awarding Agency"]] || 0) + (x["Award Amount"] || 0);
  let byDate = [...rows].sort((a, b) => String(b["Start Date"] || "").localeCompare(String(a["Start Date"] || "")));
  if (res.more) {
    // the amount-sorted pages stop before the newest small awards: read the newest ones directly
    const recent = await usaspendingAll(http, filters, { max: 1, sort: "Start Date" });
    const fresh = (recent.results || []).filter((x) => same(subject.company, x["Recipient Name"]));
    if (fresh.length) byDate = [...fresh, ...byDate].filter((x, i, a) => a.findIndex((y) => y["Award ID"] === x["Award ID"]) === i).sort((a, b) => String(b["Start Date"] || "").localeCompare(String(a["Start Date"] || "")));
  }
  const latest = byDate[0]?.["Start Date"];
  add({ var: "co.gov", value: `${rows.length}${res.more ? "+" : ""} federal contract awards, ${money(total)}${res.more ? " in the largest " + rows.length + " read" : " total"}; top agencies ${Object.entries(agencies).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a, v]) => `${a} ${money(v)}`).join(", ")}; latest start ${latest}`, url: web, grade: "v", tier: "A", date: latest, detail: { agencies, recipients: [...new Set(rows.map((x) => x["Recipient Name"]))], relatedRecipients: related.slice(0, 10), pagesRead: res.pages, truncated: res.more } });
  // the newest real awards first (at least $25k, last five years): what they do for the government now
  const since = new Date(Date.now() - 5 * 365 * 864e5).toISOString().slice(0, 10);
  const notable = byDate.filter((x) => (x["Award Amount"] || 0) >= 25000 && String(x["Start Date"] || "") >= since);
  for (const x of notable.slice(0, 3)) add({ var: "co.gov", value: `${money(x["Award Amount"])} ${x["Awarding Agency"]} ${x["Start Date"]}: ${String(x.Description || "").slice(0, 120)}`, url: `https://www.usaspending.gov/award/${x.generated_internal_id}`, grade: "v", tier: "A", date: x["Start Date"] });
}

async function lobbying(ctx) {
  const { http, add, miss, subject } = ctx;
  const name = normCompany(subject.company);
  const u = `https://lda.gov/api/v1/filings/?client_name=${encodeURIComponent(subject.company)}&page_size=25&ordering=-dt_posted`;
  const r = await http.json(u, { timeout: 20000 });
  if (!r.data) {
    if ([403, 429].includes(r.status)) ctx.status?.("blocked", `lda.gov ${r.status}`);
    return miss("politics.company_pac", `lda.gov lobbying API ${r.status || r.error}: not checked`, { blocked: true });
  }
  const rows = (r.data.results || []).filter((f) => same(subject.company, f.client?.name || ""));
  const web = `https://lda.gov/filings/public/filing/search/?client=${encodeURIComponent(subject.company)}`;
  // "none" is verified only when the API itself counted zero; otherwise the first page held only namesakes
  if (!rows.length) return add({ var: "politics.company_pac", value: `No federal lobbying filings with "${subject.company}" as client (lda.gov)`, url: web, grade: r.data.count === 0 ? "v" : "p", tier: "A", detail: { query: name, apiCount: r.data.count } });
  const spend = rows.reduce((s, f) => s + Number(f.income || f.expenses || 0), 0);
  const firms = [...new Set(rows.map((f) => f.registrant?.name).filter(Boolean))];
  const issues = [...new Set(rows.flatMap((f) => (f.lobbying_activities || []).map((a) => a.general_issue_code_display)).filter(Boolean))];
  const years = [...new Set(rows.map((f) => f.filing_year))].sort();
  // r.data.count is the API's fuzzy name search (other clients that share a word): never print it;
  // count only the filings whose client is the company itself, in the page read
  add({ var: "politics.company_pac", value: `Lobbies: ${rows.length} LDA filings as client in the latest ${(r.data.results || []).length} retrieved (${years[0]}${years.length > 1 ? "-" + years.at(-1) : ""}), ${money(spend)} reported in them; firms ${firms.slice(0, 3).join(", ")}; issues ${issues.slice(0, 4).join(", ")}`, url: web, grade: "v", tier: "A", date: rows[0]?.dt_posted?.slice(0, 10), detail: { firms, issues, years, apiFuzzyCount: r.data.count, matched: rows.length } });
  add({ var: "co.gov", value: `Federal lobbying on ${issues.slice(0, 5).join(", ") || "unspecified issues"} (${firms.length} firm${firms.length === 1 ? "" : "s"})`, url: web, grade: "v", tier: "A" });
}

/** FEC_API_KEY when set, else the public DEMO_KEY. Never a key lifted from fec.gov's pages. */
export function fecKey(env = process.env) {
  return env.FEC_API_KEY || "DEMO_KEY";
}

async function pac(ctx) {
  const { http, add, miss, subject, env } = ctx;
  const key = fecKey(env);
  const q = normCompany(subject.company);
  const u = `https://api.open.fec.gov/v1/committees/?q=${encodeURIComponent(q)}&per_page=50&api_key=${key}`;
  const r = await http.json(u, { timeout: 15000 });
  const web = `https://www.fec.gov/data/committees/?q=${encodeURIComponent(q)}`;
  if (!r.data) {
    if (r.status === 429 || r.status === 403) ctx.status?.("blocked", `FEC ${r.status}${key === "DEMO_KEY" ? " on DEMO_KEY" : ""}`);
    return miss("politics.company_pac", `FEC committees API ${r.status || r.error}${r.status === 429 ? ` (rate limit${key === "DEMO_KEY" ? " on the shared DEMO_KEY; set FEC_API_KEY" : ""})` : ""}: company PAC unknown, not checked`, { blocked: true });
  }
  // the company's own PAC: a non-candidate committee whose connected organisation is the company
  const rows = (r.data.results || []).filter((c) => isCompanyPac(c, subject.company));
  if (!rows.length) return add({ var: "politics.company_pac", value: `No FEC-registered PAC connected to ${subject.company}`, url: web, grade: (r.data.results || []).length ? "p" : "v", tier: "A", detail: { checked: (r.data.results || []).length, namesakes: (r.data.results || []).slice(0, 8).map((c) => c.name) } });
  for (const c of rows.slice(0, 3)) add({ var: "politics.company_pac", value: `${c.name} (${c.committee_id}), ${c.committee_type_full || c.committee_type}${c.cycles?.length ? `, active cycles ${c.cycles.slice(-3).join(", ")}` : ""}${c.last_file_date ? `, last filed ${c.last_file_date}` : ""}`, url: `https://www.fec.gov/data/committee/${c.committee_id}/`, grade: "v", tier: "A", date: c.last_file_date || null, detail: c });
}

export default {
  id: "gov",
  /** The ledger variables this module fills (config/form buckets read them to say "no tool yet"). */
  vars: ["co.gov", "politics.company_pac"],
  label: "Government: federal awards, lobbying, company PAC",
  lane: "fast",
  needs: ["company"],
  env: ["FEC_API_KEY"],
  budgetMs: 50000, // USAspending pages are read one after another (up to 5 x 100 awards)
  async run(ctx) {
    await Promise.all([usaspending(ctx), lobbying(ctx), pac(ctx)]);
  },
};
