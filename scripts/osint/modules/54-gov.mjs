// Government money and influence: federal awards (USAspending), lobbying (lda.gov) and a
// company PAC (FEC committees). All keyless; FEC uses FEC_API_KEY, else fec.gov's own public
// web key, else DEMO_KEY.
import { normCompany, money } from "../colib.mjs";

const same = (a, b) => {
  const x = normCompany(a).split(" ");
  const y = normCompany(b);
  return x.length && x.every((t) => y.split(" ").includes(t));
};

async function usaspending(ctx) {
  const { http, add, miss, subject } = ctx;
  const body = {
    filters: { recipient_search_text: [subject.company], award_type_codes: ["A", "B", "C", "D"], time_period: [{ start_date: "2007-10-01", end_date: new Date().toISOString().slice(0, 10) }] },
    fields: ["Award ID", "Recipient Name", "Award Amount", "Awarding Agency", "Start Date", "Description"],
    limit: 100,
    sort: "Award Amount",
    order: "desc",
  };
  const r = await http.get("https://api.usaspending.gov/api/v2/search/spending_by_award/", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", accept: "application/json" }, timeout: 20000 });
  let d = null;
  try {
    d = JSON.parse(r.text);
  } catch {}
  if (!d?.results) return miss("co.gov", `USAspending ${r.status || r.error}`);
  const rows = d.results.filter((x) => same(subject.company, x["Recipient Name"]));
  const web = `https://www.usaspending.gov/search/?hash=&keyword=${encodeURIComponent(subject.company)}`;
  if (!rows.length) return add({ var: "co.gov", value: `No federal contracts to "${subject.company}" in USAspending (FY2008-now)`, url: web, grade: "v", tier: "A", detail: { otherRecipients: [...new Set(d.results.map((x) => x["Recipient Name"]))].slice(0, 5) } });
  const total = rows.reduce((s, x) => s + (x["Award Amount"] || 0), 0);
  const agencies = {};
  for (const x of rows) agencies[x["Awarding Agency"]] = (agencies[x["Awarding Agency"]] || 0) + (x["Award Amount"] || 0);
  const latest = rows.map((x) => x["Start Date"]).sort().at(-1);
  add({ var: "co.gov", value: `${rows.length}${rows.length === 100 ? "+" : ""} federal contract awards, ${money(total)} total; top agencies ${Object.entries(agencies).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a, v]) => `${a} ${money(v)}`).join(", ")}; latest start ${latest}`, url: web, grade: "v", tier: "A", date: latest, detail: { agencies, recipients: [...new Set(rows.map((x) => x["Recipient Name"]))] } });
  for (const x of rows.slice(0, 3)) add({ var: "co.gov", value: `${money(x["Award Amount"])} ${x["Awarding Agency"]} ${x["Start Date"]}: ${String(x.Description || "").slice(0, 120)}`, url: `https://www.usaspending.gov/award/${x.generated_internal_id}`, grade: "v", tier: "A", date: x["Start Date"] });
}

async function lobbying(ctx) {
  const { http, add, miss, subject } = ctx;
  const name = normCompany(subject.company);
  const u = `https://lda.gov/api/v1/filings/?client_name=${encodeURIComponent(subject.company)}&page_size=25&ordering=-dt_posted`;
  const r = await http.json(u, { timeout: 20000 });
  if (!r.data) return miss("politics.company_pac", `lda.gov lobbying API ${r.status || r.error}`);
  const rows = (r.data.results || []).filter((f) => same(subject.company, f.client?.name || ""));
  const web = `https://lda.gov/filings/public/filing/search/?client=${encodeURIComponent(subject.company)}`;
  if (!rows.length) return add({ var: "politics.company_pac", value: `No federal lobbying filings with "${subject.company}" as client (lda.gov)`, url: web, grade: "v", tier: "A", detail: { query: name, apiCount: r.data.count } });
  const spend = rows.reduce((s, f) => s + Number(f.income || f.expenses || 0), 0);
  const firms = [...new Set(rows.map((f) => f.registrant?.name).filter(Boolean))];
  const issues = [...new Set(rows.flatMap((f) => (f.lobbying_activities || []).map((a) => a.general_issue_code_display)).filter(Boolean))];
  const years = [...new Set(rows.map((f) => f.filing_year))].sort();
  add({ var: "politics.company_pac", value: `Lobbies: ${r.data.count} LDA filings as client (${years[0]}-${years.at(-1)}), ${money(spend)} in the latest ${rows.length}; firms ${firms.slice(0, 3).join(", ")}; issues ${issues.slice(0, 4).join(", ")}`, url: web, grade: "v", tier: "A", date: rows[0]?.dt_posted?.slice(0, 10), detail: { firms, issues, years } });
  add({ var: "co.gov", value: `Federal lobbying on ${issues.slice(0, 5).join(", ") || "unspecified issues"} (${firms.length} firm${firms.length === 1 ? "" : "s"})`, url: web, grade: "v", tier: "A" });
}

async function fecKey(http, env) {
  if (env.FEC_API_KEY) return { key: env.FEC_API_KEY, headers: {} };
  const r = await http.get("https://www.fec.gov/data/committees/", { timeout: 10000 });
  const k = r.text?.match(/API_KEY_PUBLIC\s*=\s*['"]([A-Za-z0-9]{30,})['"]/)?.[1];
  return k ? { key: k, headers: { referer: "https://www.fec.gov/" } } : { key: "DEMO_KEY", headers: {} };
}

async function pac(ctx) {
  const { http, add, miss, subject, env } = ctx;
  const { key, headers } = await fecKey(http, env);
  const q = normCompany(subject.company);
  const u = `https://api.open.fec.gov/v1/committees/?q=${encodeURIComponent(q)}&per_page=20&api_key=${key}`;
  const r = await http.json(u, { headers, timeout: 15000 });
  if (!r.data) return miss("politics.company_pac", `FEC committees API ${r.status}${r.status === 429 ? " (rate limit; set FEC_API_KEY)" : ""}`);
  const rows = (r.data.results || []).filter((c) => same(subject.company, c.name) || same(subject.company, c.sponsor_candidate_list?.[0] || "") || (c.organization_type === "C" && normCompany(c.name).includes(q)));
  const web = `https://www.fec.gov/data/committees/?q=${encodeURIComponent(q)}`;
  if (!rows.length) return add({ var: "politics.company_pac", value: `No FEC-registered PAC named for ${subject.company}`, url: web, grade: "v", tier: "A" });
  for (const c of rows.slice(0, 3)) add({ var: "politics.company_pac", value: `${c.name} (${c.committee_id}), ${c.committee_type_full || c.committee_type}${c.cycles?.length ? `, active cycles ${c.cycles.slice(-3).join(", ")}` : ""}${c.last_file_date ? `, last filed ${c.last_file_date}` : ""}`, url: `https://www.fec.gov/data/committee/${c.committee_id}/`, grade: "v", tier: "A", date: c.last_file_date || null, detail: c });
}

export default {
  id: "gov",
  label: "Government: federal awards, lobbying, company PAC",
  lane: "fast",
  needs: ["company"],
  env: ["FEC_API_KEY"],
  budgetMs: 30000,
  async run(ctx) {
    await Promise.all([usaspending(ctx), lobbying(ctx), pac(ctx)]);
  },
};
