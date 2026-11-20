// SEC EDGAR: the company (CIK, filings, XBRL financials, 8-K exec changes) and the person
// (Form 3/4 trades and holdings, proxy pay and bio, 8-K mentions). Keyless; SEC asks for a
// contact in the User-Agent (SEC_USER_AGENT).
import { SEC_UA, nameIn, normName } from "../core.mjs";
import { matchCompany, cik10, pickRevenue, latestFact, money, pct, parseForm4, parseSCT, htmlText, bioFrom, educationFrom, careerFrom, startFrom, sentences } from "../colib.mjs";

const H = () => ({ "user-agent": SEC_UA() });
const ARCH = "https://www.sec.gov/Archives/edgar/data";
const docUrl = (cik, acc, doc) => `${ARCH}/${Number(cik)}/${acc.replace(/-/g, "")}/${doc}`;
const filingIndex = (cik, acc) => `${ARCH}/${Number(cik)}/${acc.replace(/-/g, "")}/`;

/** Resolve the registrant once per run; both SEC modules await the same promise. */
export function secBase(ctx) {
  ctx.shared._sec ??= (async () => {
    const { subject, http } = ctx;
    const t = await http.json("https://www.sec.gov/files/company_tickers.json", { headers: H(), timeout: 15000 });
    if (!t.data) return { error: `company_tickers.json ${t.status || t.error}` };
    const m = matchCompany(t.data, { name: subject.company, ticker: subject.ticker });
    if (!m) return { none: true };
    const sub = await http.json(`https://data.sec.gov/submissions/CIK${cik10(m.cik)}.json`, { headers: H(), timeout: 15000 });
    if (!sub.data) return { ...m, error: `submissions ${sub.status}` };
    const r = sub.data.filings.recent;
    const filings = r.form.map((form, i) => ({ form, date: r.filingDate[i], acc: r.accessionNumber[i], doc: r.primaryDocument[i], items: r.items?.[i] || "", desc: r.primaryDocDescription?.[i] || "", report: r.reportDate?.[i] || "" }));
    for (const f of filings) f.url = docUrl(m.cik, f.acc, f.doc);
    Object.assign(ctx.shared, { cik: m.cik, ticker: m.ticker, secName: sub.data.name, fiscalYearEnd: sub.data.fiscalYearEnd, secFilings: filings, sic: sub.data.sicDescription });
    return { ...m, sub: sub.data, filings };
  })();
  return ctx.shared._sec;
}

const company = {
  id: "sec",
  label: "SEC EDGAR: company filings and XBRL financials",
  lane: "fast",
  needs: ["company"],
  budgetMs: 30000,
  async run(ctx) {
    const { http, add, miss, shared } = ctx;
    const b = await secBase(ctx);
    if (b.error && !b.cik) return miss("co.filings", `SEC lookup failed (${b.error})`);
    if (b.none) {
      shared.private = true;
      for (const v of ["co.filings", "co.facts", "co.quarter", "co.cash"]) miss(v, `"${ctx.subject.company}" is not in SEC company_tickers.json (not a US-listed registrant)`);
      return;
    }
    const { cik, ticker, filings, sub } = b;
    const browse = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}`;
    add({ var: "co.filings", value: `${sub.name} (${ticker}), CIK ${cik}, ${sub.sicDescription || "SIC " + sub.sic}, FY ends ${sub.fiscalYearEnd?.replace(/(\d\d)(\d\d)/, "$1/$2")}`, url: browse, grade: "v", tier: "A", anchors: ["cik"], detail: { cik, ticker, exchanges: sub.exchanges, state: sub.stateOfIncorporation, website: sub.website, addresses: sub.addresses?.business, formerNames: sub.formerNames } });

    // the filings worth reading, newest first
    const want = { "10-K": 1, "10-Q": 2, "DEF 14A": 1, "S-1": 1, "8-K": 6, "20-F": 1, "10-K/A": 1 };
    const seen = {};
    for (const f of filings) {
      if (f.date < new Date(Date.now() - 3 * 365 * 864e5).toISOString().slice(0, 10)) break;
    if (!want[f.form] || (seen[f.form] = (seen[f.form] || 0) + 1) > want[f.form]) continue;
      add({ var: "co.filings", value: `${f.form} filed ${f.date}${f.items ? " · items " + f.items : ""}${f.report ? " · period " + f.report : ""}`, url: f.url, grade: "v", tier: "A", date: f.date, detail: { form: f.form, accession: f.acc, items: f.items } });
    }

    // 8-K item 5.02 (officer/director departures and appointments), last 24 months
    const cutoff = new Date(Date.now() - 730 * 864e5).toISOString().slice(0, 10);
    const changes = filings.filter((f) => f.form === "8-K" && f.items.includes("5.02") && f.date >= cutoff).slice(0, 6);
    await Promise.all(
      changes.map(async (f) => {
        const r = await http.get(f.url, { headers: H(), timeout: 12000 });
        const t = htmlText(r.text);
        const i = t.search(/Item\s*5\.02/i);
        const body = i >= 0 ? t.slice(i, i + 1600) : t.slice(0, 1600);
        const what = sentences(body.replace(/^Item\s*5\.02[^.]*?(Officers|Arrangements)\.?/i, "")).filter((s) => /(appoint|resign|retire|depart|named|terminat|elect|promot|succeed|transition|step)/i.test(s)).slice(0, 2).join(" ");
        add({ var: "co.exec_changes", value: `${f.date}: ${(what || body).slice(0, 320)}`, url: f.url, grade: r.ok ? "v" : "w", tier: "A", date: f.date, detail: { items: f.items } });
      }),
    );
    if (!changes.length) miss("co.exec_changes", `no 8-K item 5.02 since ${cutoff} in EDGAR submissions`);

    // XBRL company facts
    const fx = await http.json(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik10(cik)}.json`, { headers: H(), timeout: 20000 });
    const furl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik10(cik)}.json`;
    if (!fx.data) return miss("co.facts", `XBRL companyfacts ${fx.status || fx.error}`);
    const rev = pickRevenue(fx.data);
    if (rev?.annual) {
      shared.revenue = rev.annual.val;
      shared.revenueYoY = rev.annualYoY;
      shared.revenueSource = `XBRL ${rev.concept} FY ending ${rev.annual.end}`;
      add({ var: "co.facts", value: `Revenue ${money(rev.annual.val)} FY ending ${rev.annual.end}${rev.annualYoY != null ? ` (${pct(rev.annualYoY)} YoY)` : ""}`, url: furl, grade: "v", tier: "A", date: rev.annual.end, detail: { concept: rev.concept, annual: rev.annual, prior: rev.priorAnnual } });
    } else miss("co.facts", "no annual revenue concept in XBRL companyfacts");
    if (rev?.quarter) {
      shared.quarter = rev.quarter;
      shared.quarterYoY = rev.quarterYoY;
      add({ var: "co.quarter", value: `Revenue ${money(rev.quarter.val)} for quarter ending ${rev.quarter.end} (${rev.quarter.fp} FY${rev.quarter.fy})${rev.quarterYoY != null ? `, ${pct(rev.quarterYoY)} YoY` : ""}`, url: furl, grade: "v", tier: "A", date: rev.quarter.end, detail: { concept: rev.concept, quarter: rev.quarter, yearAgo: rev.priorQuarter } });
    }
    const ni = latestFact(fx.data, ["NetIncomeLoss", "ProfitLoss"], { duration: "annual" });
    if (ni) add({ var: "co.facts", value: `Net income ${money(ni.val)} FY ending ${ni.end}`, url: furl, grade: "v", tier: "A", date: ni.end, detail: ni });
    const niq = latestFact(fx.data, ["NetIncomeLoss", "ProfitLoss"], { duration: "quarter" });
    if (niq && rev?.quarter && niq.end === rev.quarter.end) add({ var: "co.quarter", value: `Net income ${money(niq.val)} for quarter ending ${niq.end}`, url: furl, grade: "v", tier: "A", date: niq.end, detail: niq });
    const rpo = latestFact(fx.data, ["RevenueRemainingPerformanceObligation"]);
    if (rpo) add({ var: "co.kpis", value: `RPO ${money(rpo.val)} at ${rpo.end}`, url: furl, grade: "v", tier: "A", date: rpo.end, detail: rpo });
    const cash = latestFact(fx.data, ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", "Cash"]);
    const debt = latestFact(fx.data, ["LongTermDebt", "LongTermDebtNoncurrent", "ConvertibleNotesPayable", "LongTermDebtAndCapitalLeaseObligations", "SeniorNotes"]);
    if (cash || debt) {
      shared.cash = cash?.val;
      add({ var: "co.cash", value: [cash && `Cash ${money(cash.val)}`, debt && `debt ${money(debt.val)}`].filter(Boolean).join(", ") + ` at ${(cash || debt).end}`, url: furl, grade: "v", tier: "A", date: (cash || debt).end, detail: { cash, debt } });
    } else miss("co.cash", "no cash or debt concept in XBRL");
    const emp = latestFact(fx.data, ["EntityNumberOfEmployees"], { unit: "pure", ns: "dei" }) || latestFact(fx.data, ["EntityNumberOfEmployees"], { unit: "employee", ns: "dei" });
    if (emp) {
      shared.employees = emp.val;
      shared.employeesSource = `XBRL dei ${emp.end}`;
      add({ var: "co.facts", value: `${emp.val.toLocaleString()} employees at ${emp.end}`, url: furl, grade: "v", tier: "A", date: emp.end, detail: emp });
    }
    const shares = latestFact(fx.data, ["EntityCommonStockSharesOutstanding"], { unit: "shares", ns: "dei" });
    if (shares) shared.sharesOutstanding = shares.val;
  },
};

const person = {
  id: "sec-person",
  label: "SEC EDGAR: the person in Forms 3/4, proxy and 8-Ks",
  lane: "fast",
  needs: ["name", "company"],
  budgetMs: 40000,
  async run(ctx) {
    const { http, add, miss, subject, shared } = ctx;
    const b = await secBase(ctx);
    if (!b.cik) {
      for (const v of ["money.trades", "money.holdings", "money.comp"]) miss(v, b.none ? `${subject.company} is not an SEC registrant: no Forms 3/4 or proxy` : `SEC lookup failed (${b.error})`);
      return;
    }
    const cik = b.cik;
    const q = encodeURIComponent(`"${subject.name}"`);
    let fts = await http.json(`https://efts.sec.gov/LATEST/search-index?q=${q}&forms=4,3,DEF%2014A,8-K`, { headers: H(), timeout: 15000 });
    if (!fts.data) fts = await http.json(`https://efts.sec.gov/LATEST/search-index?q=${q}`, { headers: H(), timeout: 15000 });
    const hits = (fts.data?.hits?.hits || []).map((h) => ({ ...h._source, file: h._id.split(":")[1], adsh: h._source.adsh || h._id.split(":")[0] }));
    const atCo = hits.filter((h) => (h.ciks || []).map(Number).includes(cik));
    // the person's own filer CIK from "Whitlock Dana  (CIK 0009990001)"
    let ownerCik = null;
    for (const h of atCo) {
      for (const d of h.display_names || []) {
        const m = d.match(/^(.*?)\s+\(CIK (\d+)\)/);
        if (m && nameIn(m[1], subject.name) && Number(m[2]) !== cik) ownerCik = Number(m[2]);
      }
    }
    const tasks = [];
    if (ownerCik) tasks.push(insider(ctx, cik, ownerCik));
    else for (const v of ["money.trades", "money.holdings"]) miss(v, `no Form 3/4 filer named "${subject.name}" at CIK ${cik} in EDGAR full-text search (not a Section 16 officer, or files under another name)`);
    tasks.push(proxy(ctx, b.filings));
    tasks.push(mentions(ctx, cik, atCo.filter((h) => h.root_forms?.includes("8-K") || h.form === "8-K")));
    await Promise.all(tasks);
  },
};

async function insider(ctx, cik, ownerCik) {
  const { http, add, miss, subject, shared } = ctx;
  const own = await http.json(`https://data.sec.gov/submissions/CIK${cik10(ownerCik)}.json`, { headers: H(), timeout: 15000 });
  if (!own.data) return miss("money.trades", `owner submissions CIK ${ownerCik}: ${own.status}`);
  const r = own.data.filings.recent;
  const list = r.form.map((form, i) => ({ form, date: r.filingDate[i], acc: r.accessionNumber[i], doc: r.primaryDocument[i] })).filter((f) => ["3", "4", "5", "3/A", "4/A"].includes(f.form));
  const recent = list.filter((f) => f.form.startsWith("4")).slice(0, 10);
  const form3 = list.filter((f) => f.form.startsWith("3")).at(-1);
  const pick = [...recent, ...(form3 ? [form3] : [])];
  const docs = await Promise.all(
    pick.map(async (f) => {
      const raw = f.doc.replace(/^xsl[^/]+\//, "");
      const url = docUrl(ownerCik, f.acc, raw);
      const x = await http.get(url, { headers: H(), timeout: 10000 });
      return x.ok ? { ...f, url, view: docUrl(ownerCik, f.acc, f.doc), p: parseForm4(x.text) } : null;
    }),
  );
  const ok = docs.filter((d) => d && (!d.p.issuerCik || Number(d.p.issuerCik) === cik));
  if (!ok.length) return miss("money.trades", `Form 4 XML fetch failed for owner CIK ${ownerCik}`);
  const latest = ok.find((d) => d.p.title) || ok[0];
  if (latest.p.title) shared.roleTitle ??= latest.p.title;
  if (latest.p.title) add({ var: "role.title", value: latest.p.title, url: latest.view, grade: "v", tier: "A", date: latest.date, anchors: ["sec-owner-cik"], detail: { source: `Form ${latest.form} officerTitle`, isDirector: latest.p.isDirector, isOfficer: latest.p.isOfficer, ownerCik } });
  if (form3) add({ var: "role.start", value: `Section 16 insider since ${form3.date} (first Form 3)`, url: docUrl(ownerCik, form3.acc, form3.doc), grade: "p", tier: "A", date: form3.date, detail: { note: "date of becoming a reporting officer/director, not necessarily the current seat" } });

  // trades: open-market buys/sales row by row, everything else summarised
  const trades = ok.flatMap((d) => d.p.trades.map((t) => ({ ...t, filed: d.date, url: d.view })));
  const open = trades.filter((t) => ["P", "S"].includes(t.code) && !t.derivative);
  for (const t of open.slice(0, 8)) {
    add({ var: "money.trades", value: `${t.date}: ${t.code === "S" ? "sold" : "bought"} ${t.shares?.toLocaleString()} shares${t.price ? ` at $${t.price}` : ""}${t.price && t.shares ? ` (${money(t.price * t.shares)})` : ""}, ${t.after?.toLocaleString()} left`, url: t.url, grade: "v", tier: "A", date: t.date, detail: t });
  }
  const byCode = {};
  for (const t of trades) byCode[t.what] = (byCode[t.what] || 0) + 1;
  const sold = open.filter((t) => t.code === "S").reduce((s, t) => s + (t.shares || 0) * (t.price || 0), 0);
  const bought = open.filter((t) => t.code === "P").reduce((s, t) => s + (t.shares || 0) * (t.price || 0), 0);
  add({ var: "money.trades", value: `${ok.length} recent ownership filings: ${open.filter((t) => t.code === "S").length} open-market sales (${money(sold)}), ${open.filter((t) => t.code === "P").length} purchases (${money(bought)})`, url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${ownerCik}&type=4`, grade: "v", tier: "A", date: ok[0].date, detail: { byType: byCode, filings: ok.map((d) => ({ form: d.form, date: d.date, url: d.view })) } });

  // holdings: newest direct common position
  const direct = trades.filter((t) => !t.derivative && t.after != null).sort((a, b) => (a.filed < b.filed ? 1 : -1))[0];
  const held = ok.flatMap((d) => d.p.holdings.filter((h) => !h.derivative).map((h) => ({ ...h, filed: d.date })))[0];
  const pos = direct || held;
  if (pos) {
    const px = open.find((t) => t.price)?.price;
    shared.personShares = pos.after;
    add({ var: "money.holdings", value: `${pos.after.toLocaleString()} ${pos.security || "shares"} held ${pos.direct === "I" ? "indirectly" : "directly"} after ${pos.filed}${px ? ` (≈ ${money(pos.after * px)} at $${px})` : ""}`, url: direct?.url || latest.view, grade: "v", tier: "A", date: pos.filed, detail: { position: pos, derivativeRows: trades.filter((t) => t.derivative).length } });
  }
}

async function proxy(ctx, filings) {
  const { http, add, miss, subject, shared } = ctx;
  const def = filings.find((f) => f.form === "DEF 14A");
  if (!def) return miss("money.comp", "no DEF 14A in recent EDGAR filings");
  const r = await http.get(def.url, { headers: H(), timeout: 25000 });
  if (!r.ok) return miss("money.comp", `DEF 14A fetch ${r.status || r.error}`);
  const sct = parseSCT(r.text, subject.name);
  if (sct.isNeo && sct.years.length) {
    const y = sct.years[0];
    const parts = Object.entries(y.cells)
      .filter(([k, v]) => v && !/total/i.test(k))
      .map(([k, v]) => `${k.replace(/compensation/i, "").replace(/\s+/g, " ").trim()} ${money(v)}`);
    shared.proxyComp = { year: y.year, total: y.total, cells: y.cells };
    add({ var: "money.comp", value: `FY${y.year} total ${money(y.total)} (${parts.join(", ")})${sct.years[1] ? `; FY${sct.years[1].year} ${money(sct.years[1].total)}` : ""}${sct.years[2] ? `, FY${sct.years[2].year} ${money(sct.years[2].total)}` : ""}`, url: def.url, grade: "v", tier: "A", date: def.date, anchors: ["proxy-neo"], detail: { label: sct.label, header: sct.header, years: sct.years } });
  } else if (sct.found) {
    shared.neos = sct.neos;
    miss("money.comp", `not a named executive officer in the ${def.date} proxy Summary Compensation Table (NEOs: ${sct.neos.join(", ")})`);
  } else miss("money.comp", `no Summary Compensation Table parsed in the ${def.date} DEF 14A`);

  if (!nameIn(r.text.slice(0, 3e6), subject.name)) return;
  const text = htmlText(r.text);
  const bio = bioFrom(text, subject.name);
  if (bio && bio.length > 120) {
    for (const s of careerFrom(bio).slice(0, 8)) add({ var: "career.timeline", value: s, url: def.url, grade: "v", tier: "A", date: def.date, detail: { source: "DEF 14A executive officer bio" } });
    for (const s of educationFrom(bio)) add({ var: "career.education", value: s, url: def.url, grade: "v", tier: "A", date: def.date });
    const st = startFrom(bio);
    if (st) add({ var: "role.start", value: `In the current seat since ${st} (proxy bio)`, url: def.url, grade: "v", tier: "A", date: def.date, detail: { bio: bio.slice(0, 600) } });
  }
  // age from the executive officers table: "Dana Whitlock 51 Executive Vice President"
  const age = text.match(new RegExp(`${subject.name.replace(/\s+/g, "\\s+")}\\s*,?\\s+(\\d{2})\\s+[A-Z]`));
  if (age) shared.personAge = Number(age[1]);
  // what the pay plan says they are judged on
  const last = subject.name.split(/\s+/).at(-1);
  const pri = sentences(text).filter((s) => s.includes(last) && /(bonus|incentive|plan|objective|metric|performance|weighted|tied to|based on)/i.test(s) && s.length < 500 && (s.match(/\d/g) || []).length / s.length < 0.06);
  for (const s of pri.slice(0, 3)) add({ var: "voice.priorities", value: s, url: def.url, grade: "p", tier: "A", date: def.date, detail: { source: "DEF 14A compensation discussion" } });
}

async function mentions(ctx, cik, hits) {
  const { http, add, miss, subject } = ctx;
  const seen = new Set();
  const docs = hits.filter((h) => !seen.has(h.adsh + h.file) && seen.add(h.adsh + h.file)).sort((a, b) => (a.file_date < b.file_date ? 1 : -1)).slice(0, 4);
  if (!docs.length) return miss("voice.quotes", `no 8-K or press exhibit in EDGAR full-text search mentions "${subject.name}"`);
  const last = subject.name.split(/\s+/).at(-1);
  await Promise.all(
    docs.map(async (h) => {
      const url = docUrl(cik, h.adsh, h.file);
      const r = await http.get(url, { headers: H(), timeout: 12000 });
      if (!r.ok) return;
      const t = htmlText(r.text).replace(/[“”]/g, '"');
      // a quote is theirs when the attribution right after it names them: "...," said Dana Whitlock
      for (const m of t.matchAll(/"([^"]{40,600})"/g)) {
        const after = t.slice(m.index + m[0].length, m.index + m[0].length + 100);
        const before = t.slice(Math.max(0, m.index - 160), m.index);
        const SAY = "(?:said|says|added|noted|commented|stated|explained)";
        const post = after.match(new RegExp(`^\\s*,?\\s*${SAY}\\s+((?:Mr\\.|Ms\\.|Dr\\.)?\\s*[A-Z][\\w'-]+(?:\\s+[A-Z][\\w'-]+){0,2})`)) || after.match(new RegExp(`^\\s*,?\\s*((?:Mr\\.|Ms\\.|Dr\\.)?\\s*[A-Z][\\w'-]+(?:\\s+[A-Z][\\w'-]+){0,2}),?[^".]{0,60}?\\s${SAY}\\b`));
        const pre = before.match(new RegExp(`([A-Z][\\w'-]+)(?:,[^,]{0,60},)?\\s+${SAY}[^"]{0,40}$`));
        const who = post ? post[1] : pre ? pre[1] : "";
        if (who && (who.includes(last) || nameIn(who, subject.name))) add({ var: "voice.quotes", value: `"${m[1].trim()}"`, url, grade: "v", tier: "A", date: h.file_date, detail: { form: h.form, file: h.file, attribution: (post ? after : before).trim().slice(0, 100) } });
      }
      const body = t.replace(/^.*?(?:FOR IMMEDIATE RELEASE|Item\s*5\.02[^.]*\.)\s*/i, "");
      for (const s of sentences(body).filter((s) => s.includes(last) && /(appoint|named|promot|join|hire|elevat|succeed)/i.test(s) && s.length < 600).slice(0, 1)) {
        add({ var: "co.exec_changes", value: `${h.file_date}: ${s.slice(0, 300)}`, url, grade: "v", tier: "A", date: h.file_date, anchors: ["names-subject"] });
        add({ var: "role.start", value: `${h.file_date}: ${s.slice(0, 220)}`, url, grade: "p", tier: "A", date: h.file_date });
      }
    }),
  );
}

export default [company, person];
