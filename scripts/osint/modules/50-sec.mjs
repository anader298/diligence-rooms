// SEC EDGAR: the company (CIK, filings, XBRL financials, 8-K exec changes) and the person
// (Form 3/4 trades and holdings, proxy pay and bio, 8-K mentions). Keyless; SEC asks for a
// contact in the User-Agent (SEC_USER_AGENT).
import { SEC_UA, nameIn, nameForms, namesSubject } from "../core.mjs";
import { matchCompany, cik10, pickRevenue, latestFact, latestDebt, CASH, money, pct, parseForm4, parseSCT, htmlText, bioFrom, isBio, titleFromBio, educationFrom, careerFrom, startFrom, sentences, departureFrom } from "../colib.mjs";

const H = () => ({ "user-agent": SEC_UA() });
const ARCH = "https://www.sec.gov/Archives/edgar/data";
const docUrl = (cik, acc, doc) => `${ARCH}/${Number(cik)}/${acc.replace(/-/g, "")}/${doc}`;
const filingIndex = (cik, acc) => `${ARCH}/${Number(cik)}/${acc.replace(/-/g, "")}/`;

/** Resolve the registrant once per run; both SEC modules await the same promise. */
export function secBase(ctx) {
  ctx.shared._sec ??= (async () => {
    const { subject, http } = ctx;
    const t = await http.json("https://www.sec.gov/files/company_tickers.json", { headers: H(), timeout: 15000 });
    if (!t.data) return { error: `company_tickers.json ${t.status || t.error}`, blocked: [403, 429].includes(t.status) };
    const m = matchCompany(t.data, { name: subject.company, ticker: subject.ticker });
    if (!m) return { none: true };
    const sub = await http.json(`https://data.sec.gov/submissions/CIK${cik10(m.cik)}.json`, { headers: H(), timeout: 15000 });
    if (!sub.data) return { ...m, error: `submissions ${sub.status}`, blocked: [403, 429].includes(sub.status) };
    const r = sub.data.filings.recent;
    const filings = r.form.map((form, i) => ({ form, date: r.filingDate[i], acc: r.accessionNumber[i], doc: r.primaryDocument[i], items: r.items?.[i] || "", desc: r.primaryDocDescription?.[i] || "", report: r.reportDate?.[i] || "" }));
    for (const f of filings) f.url = docUrl(m.cik, f.acc, f.doc);
    const ba = sub.data.addresses?.business;
    const secAddress = ba?.city ? { city: titleCase(ba.city), state: ba.stateOrCountryDescription || ba.stateOrCountry || null, street: ba.street1 || null } : null;
    Object.assign(ctx.shared, { cik: m.cik, ticker: m.ticker, secName: sub.data.name, fiscalYearEnd: sub.data.fiscalYearEnd, secFilings: filings, sic: sub.data.sicDescription, secAddress });
    return { ...m, sub: sub.data, filings };
  })();
  return ctx.shared._sec;
}

/** Up to `max` characters ending at a sentence end (or a word end with "…"), never mid-word. */
export function wholeSentences(text, max = 360) {
  const t = String(text || "").replace(/^[-–;,.\s]+/, "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  // a sentence end, not an abbreviation ("Tessellate, Inc. ("Tessellate")", "Mr. Lund", "U.S. operations")
  let end = -1;
  for (const m of cut.matchAll(/[.;](?=\s)/g)) {
    const before = cut.slice(Math.max(0, m.index - 6), m.index + 1);
    if (/\b(Inc|Corp|Co|Ltd|LLC|L\.P|N\.A|Mr|Ms|Mrs|Dr|Jr|Sr|St|No|U\.S|vs|etc)\.$/i.test(before) || /\b[A-Z]\.$/.test(before)) continue;
    end = m.index;
  }
  if (end > max * 0.4) return cut.slice(0, end + 1);
  return cut.replace(/\s+\S*$/, "") + "…";
}

const titleCase = (s) => String(s || "").toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const ref = (shared, key, row) => {
  if (row?.id) (shared.refs ||= {})[key] = row.id;
  return row;
};

const company = {
  id: "sec",
  /** The ledger variables this module fills (config/form buckets read them to say "no tool yet"). */
  vars: ["co.filings", "co.exec_changes", "co.facts", "co.quarter", "co.kpis", "co.cash"],
  label: "SEC EDGAR: company filings and XBRL financials",
  lane: "fast",
  needs: ["company"],
  budgetMs: 30000,
  async run(ctx) {
    const { http, add, miss, shared } = ctx;
    const b = await secBase(ctx);
    if (b.error && !b.cik) {
      if (b.blocked) ctx.status?.("blocked", `SEC ${b.error}`);
      return miss("co.filings", `SEC lookup ${b.blocked ? "blocked" : "failed"} (${b.error}): not checked`);
    }
    if (b.none) {
      shared.private = true;
      for (const v of ["co.filings", "co.facts", "co.quarter", "co.cash"]) miss(v, `"${ctx.subject.company}" is not in SEC company_tickers.json (not a US-listed registrant)`);
      return;
    }
    const { cik, ticker, filings, sub } = b;
    const browse = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}`;
    ref(shared, "fiscalYearEnd", add({ var: "co.filings", value: `${sub.name} (${ticker}), CIK ${cik}, ${sub.sicDescription || "SIC " + sub.sic}, FY ends ${sub.fiscalYearEnd?.replace(/(\d\d)(\d\d)/, "$1/$2")}${shared.secAddress ? `, business address ${shared.secAddress.city}${shared.secAddress.state ? ", " + shared.secAddress.state : ""}` : ""}`, url: browse, grade: "v", tier: "A", anchors: ["cik"], detail: { cik, ticker, exchanges: sub.exchanges, state: sub.stateOfIncorporation, website: sub.website, addresses: sub.addresses?.business, formerNames: sub.formerNames } }));

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
        // drop the item heading in any of its forms ("Departure of Directors or Certain Officers;
        // Election of Directors; Appointment of Certain Officers; Compensatory Arrangements of ...")
        const lead = body
          .replace(/^Item\s*5\.02\.?\s*/i, "")
          .replace(/^[-–\s]*(?:(?:Departure of Directors or (?:Certain|Principal) Officers|Election of Directors|Appointment of (?:Certain|Principal) Officers|Compensatory Arrangements of Certain Officers)[;,.]?\s*)+/i, "")
          .replace(/^\([a-f]\)\s*(?:Departure|Election|Appointment|Compensatory)[^.]{0,80}?(?:Officers?|Directors?)\s*/i, "")
          .replace(/^[;,.\s]+/, "");
        const what = sentences(lead).filter((s) => /(appoint|resign|retire|depart|named|terminat|elect|promot|succeed|transition|step)/i.test(s)).slice(0, 2).join(" ");
        // the full 8-K text, not the 320-character row, decides whether the subject is leaving
        if (namesSubject(body, ctx.subject)) {
          const d = departureFrom(body, ctx.subject);
          if (d) (shared.departures ||= []).push({ ...d, newCompany: null, date: f.date, url: f.url, text: body.slice(0, 300), source: "sec 8-K item 5.02" });
        }
        // an annual-meeting vote filed under 5.02/5.07 is not an executive change
        if (/\b(annual meeting|special meeting)\b[^.]{0,80}\b(stockholders|shareholders)\b[^.]{0,40}\bvot/i.test(lead.slice(0, 300)) && !/(appoint|resign|retire|depart|succeed|step)/i.test(what)) return;
        let text = wholeSentences(what || lead || body, 360);
        if (!/[.!?…)"”]$/.test(text)) text += "…"; // the source ran out mid-sentence: say so
        add({ var: "co.exec_changes", value: `${f.date}: ${text}`, url: f.url, grade: r.ok ? "v" : "w", tier: "A", date: f.date, detail: { items: f.items } });
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
      shared.revenueSource = `XBRL ${rev.annualConcept} FY ending ${rev.annual.end}`;
      const row = add({ var: "co.facts", value: `Revenue ${money(rev.annual.val)} FY ending ${rev.annual.end}${rev.annualYoY != null ? ` (${pct(rev.annualYoY)} YoY)` : ""}`, url: furl, grade: "v", tier: "A", date: rev.annual.end, detail: { concept: rev.annualConcept, annual: rev.annual, prior: rev.priorAnnual } });
      ref(shared, "revenue", row);
      ref(shared, "revenueYoY", row);
    } else miss("co.facts", `no annual revenue in XBRL companyfacts (checked ${["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet", "and 10 more revenue concepts"].join(", ")})`);
    if (rev?.quarter) {
      shared.quarter = rev.quarter;
      shared.quarterYoY = rev.quarterYoY;
      const row = add({ var: "co.quarter", value: `Revenue ${money(rev.quarter.val)} for quarter ending ${rev.quarter.end} (${rev.quarter.fp} FY${rev.quarter.fy})${rev.quarterYoY != null ? `, ${pct(rev.quarterYoY)} YoY` : ""}`, url: furl, grade: "v", tier: "A", date: rev.quarter.end, detail: { concept: rev.quarterConcept, quarter: rev.quarter, yearAgo: rev.priorQuarter } });
      if (rev.quarterYoY != null) ref(shared, "revenueYoY", row);
    }
    const ni = latestFact(fx.data, ["NetIncomeLoss", "ProfitLoss"], { duration: "annual" });
    if (ni) add({ var: "co.facts", value: `Net income ${money(ni.val)} FY ending ${ni.end}`, url: furl, grade: "v", tier: "A", date: ni.end, detail: ni });
    const niq = latestFact(fx.data, ["NetIncomeLoss", "ProfitLoss"], { duration: "quarter" });
    if (niq && rev?.quarter && niq.end === rev.quarter.end) add({ var: "co.quarter", value: `Net income ${money(niq.val)} for quarter ending ${niq.end}`, url: furl, grade: "v", tier: "A", date: niq.end, detail: niq });
    const rpo = latestFact(fx.data, ["RevenueRemainingPerformanceObligation"]);
    // a concept the filer stopped tagging years ago is not the current figure
    const newestEnd = rev?.quarter?.end || rev?.annual?.end || null;
    if (rpo && newestEnd && (Date.parse(newestEnd) - Date.parse(rpo.end)) / 864e5 > 550) miss("co.kpis", `RPO last tagged in XBRL at ${rpo.end}; not current, not shown`);
    else if (rpo) add({ var: "co.kpis", value: `RPO ${money(rpo.val)} at ${rpo.end}`, url: furl, grade: "v", tier: "A", date: rpo.end, detail: rpo });
    // each balance-sheet figure carries its own date; a debt value more than a year older than the
    // cash date is a concept the filer stopped using, so it is reported as stale, never as current
    const cash = latestFact(fx.data, CASH);
    const debtAny = latestDebt(fx.data);
    const debt = debtAny && cash && (new Date(cash.end) - new Date(debtAny.end)) / 864e5 > 370 ? null : debtAny;
    if (cash || debt) {
      shared.cash = cash?.val;
      const sameDay = cash && debt && cash.end === debt.end;
      const parts = [cash && `Cash ${money(cash.val)}${sameDay ? "" : ` at ${cash.end}`}`, debt && `debt ${money(debt.val)} (${debt.concept})${sameDay ? "" : ` at ${debt.end}`}`].filter(Boolean);
      const value = parts.join(", ") + (sameDay ? ` at ${cash.end}` : "") + (!debt && debtAny ? `; newest debt figure in XBRL is ${money(debtAny.val)} at ${debtAny.end} (stale, not shown as current)` : "");
      add({ var: "co.cash", value, url: furl, grade: "v", tier: "A", date: (cash || debt).end, detail: { cash, debt: debt || null, staleDebt: !debt && debtAny ? debtAny : null } });
    } else miss("co.cash", "no cash or debt concept in XBRL");
    const emp = latestFact(fx.data, ["EntityNumberOfEmployees"], { unit: "pure", ns: "dei" }) || latestFact(fx.data, ["EntityNumberOfEmployees"], { unit: "employee", ns: "dei" });
    if (emp) {
      shared.employees = emp.val;
      shared.employeesSource = `XBRL dei ${emp.end}`;
      ref(shared, "employees", add({ var: "co.facts", value: `${emp.val.toLocaleString()} employees at ${emp.end}`, url: furl, grade: "v", tier: "A", date: emp.end, detail: emp }));
    }
    const shares = latestFact(fx.data, ["EntityCommonStockSharesOutstanding"], { unit: "shares", ns: "dei" });
    if (shares) shared.sharesOutstanding = shares.val;
  },
};

const person = {
  id: "sec-person",
  /** The ledger variables this module fills (config/form buckets read them to say "no tool yet"). */
  vars: ["money.trades", "money.holdings", "money.comp", "role.title", "role.start", "career.timeline", "career.education", "voice.priorities", "voice.quotes", "co.exec_changes"],
  label: "SEC EDGAR: the person in Forms 3/4, proxy and 8-Ks",
  lane: "fast",
  needs: ["name", "company"],
  budgetMs: 40000,
  async run(ctx) {
    const { http, add, miss, subject, shared } = ctx;
    const b = await secBase(ctx);
    if (!b.cik) {
      if (b.blocked) ctx.status?.("blocked", `SEC ${b.error}`);
      for (const v of ["money.trades", "money.holdings", "money.comp"]) miss(v, b.none ? `${subject.company} is not an SEC registrant: no Forms 3/4 or proxy` : `SEC lookup ${b.blocked ? "blocked" : "failed"} (${b.error}): not checked`);
      return;
    }
    const cik = b.cik;
    // people file under the formal name and are introduced by the short one: search every form
    const forms = nameForms(subject).slice(0, 5);
    const FTS = "https://efts.sec.gov/LATEST/search-index";
    const search = (names, forms4 = true) => http.json(`${FTS}?q=${encodeURIComponent(names.map((n) => `"${n}"`).join(" OR "))}${forms4 ? "&forms=4,3,DEF%2014A,8-K" : ""}`, { headers: H(), timeout: 15000 });
    // EDGAR full-text search answers 500 now and then: retry once, then one name at a time
    let fts = await search(forms);
    if (!fts.data) fts = await search(forms, false);
    let raw = fts.data?.hits?.hits || null;
    if (!raw) {
      const each = await Promise.all(forms.map((n) => search([n])));
      if (each.some((x) => x.data)) raw = each.flatMap((x) => x.data?.hits?.hits || []);
      fts = each.find((x) => x.data) || each[0] || fts;
    }
    if (!raw && [403, 429].includes(fts.status)) ctx.status?.("blocked", `EDGAR full-text search ${fts.status}`);
    else if (!raw) ctx.status?.("partial", `EDGAR full-text search ${fts.status || fts.error}`);
    // filings print "William P. Renner" and file as "Renner William P": the quoted first+last phrase misses both
    const bySurname = await http.json(`${FTS}?q=${encodeURIComponent(`"${subject.name.split(/\s+/).at(-1)}"`)}&ciks=${cik10(cik)}&forms=4,3`, { headers: H(), timeout: 15000 });
    if (bySurname.data?.hits?.hits) raw = [...(raw || []), ...bySurname.data.hits.hits];
    const hits = (raw || []).map((h) => ({ ...h._source, file: h._id.split(":")[1], adsh: h._source.adsh || h._id.split(":")[0] }));
    const atCo = hits.filter((h) => (h.ciks || []).map(Number).includes(cik));
    // the person's own filer CIK from "Whitlock Dana  (CIK 0009990001)"
    let ownerCik = null;
    for (const h of atCo) {
      for (const d of h.display_names || []) {
        const m = d.match(/^(.*?)\s+\(CIK (\d+)\)/);
        if (m && namesSubject(m[1], subject) && Number(m[2]) !== cik) ownerCik = Number(m[2]);
      }
    }
    const tasks = [];
    const searched = forms.map((n) => `"${n}"`).join(" / ");
    if (ownerCik) tasks.push(insider(ctx, cik, ownerCik));
    else for (const v of ["money.trades", "money.holdings"]) miss(v, `no Form 3/4 filer named ${searched} at CIK ${cik} in EDGAR full-text search${raw ? "" : ` (search failed: ${fts.status || fts.error}, so unknown)`} (not a Section 16 officer, or files under another name: try --aliases)`);
    tasks.push(proxy(ctx, b.filings));
    tasks.push(mentions(ctx, cik, atCo.filter((h) => h.root_forms?.includes("8-K") || h.form === "8-K")));
    await Promise.all(tasks);
  },
};

/** Record a title candidate; the estimates and the job ranking use the strongest one. */
function titleSeen(shared, title, source, row) {
  if (!title) return;
  (shared.titles ||= []).push({ title, source, ref: row?.id || null });
}

async function insider(ctx, cik, ownerCik) {
  const { http, add, miss, subject, shared } = ctx;
  const own = await http.json(`https://data.sec.gov/submissions/CIK${cik10(ownerCik)}.json`, { headers: H(), timeout: 15000 });
  if (!own.data) return miss("money.trades", `owner submissions CIK ${ownerCik}: ${own.status}`);
  const r = own.data.filings.recent;
  const list = r.form.map((form, i) => ({ form, date: r.filingDate[i], acc: r.accessionNumber[i], doc: r.primaryDocument[i] })).filter((f) => ["3", "4", "5", "3/A", "4/A"].includes(f.form));
  const recent = list.filter((f) => f.form.startsWith("4")).slice(0, 10);
  // every Form 3 (newest first, up to 4): an owner who sits on another board files Form 3s there too
  const form3s = list.filter((f) => f.form.startsWith("3")).slice(0, 4);
  const pick = [...recent, ...form3s.filter((f) => !recent.includes(f))];
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
  // newest filing with a usable title; "See Remarks" is resolved from the remarks text by parseForm4
  const latest = ok.find((d) => d.p.title) || ok[0];
  if (latest.p.title) {
    const row = add({ var: "role.title", value: latest.p.title, url: latest.view, grade: "v", tier: "A", date: latest.date, anchors: ["sec-owner-cik"], detail: { source: `Form ${latest.form} ${/^see remarks?/i.test(latest.p.officerTitle || "") ? "remarks (officerTitle says See Remarks)" : "officerTitle"}`, isDirector: latest.p.isDirector, isOfficer: latest.p.isOfficer, ownerCik } });
    titleSeen(shared, latest.p.title, "form4", row);
  } else if (ok.some((d) => d.p.officerTitle)) miss("role.title", `Form 4 officer title is "${ok.find((d) => d.p.officerTitle).p.officerTitle}" with no title in the remarks`);
  // Form 3s filed for THIS issuer only (ok is already filtered by issuer CIK), oldest last
  const f3s = ok.filter((d) => d.form.startsWith("3"));
  if (f3s.length) {
    const f3 = f3s[0]; // the newest: a second Form 3 means the person left and came back
    const when = f3.p.period || f3.date;
    const earlier = f3s.slice(1).map((d) => d.p.period || d.date);
    add({ var: "career.timeline", value: `Section 16 reporting insider at ${shared.secName || ctx.subject.company} since ${when} (${earlier.length ? "latest" : "first"} Form 3${f3.p.title ? `, title then: ${f3.p.title}` : ""}${earlier.length ? `; an earlier stint began ${earlier.at(-1)}` : ""})`, url: f3.view, grade: "v", tier: "A", date: when, anchors: ["sec-owner-cik"], detail: { filed: f3.date, eventDate: f3.p.period || null, earlierForm3: earlier, note: "the date they became a reporting officer or director, not necessarily the start of the current seat" } });
  }

  // trades: open-market buys/sales row by row, everything else summarised
  const trades = ok.flatMap((d) => d.p.trades.map((t) => ({ ...t, filed: d.date, url: d.view })));
  const open = trades.filter((t) => ["P", "S"].includes(t.code) && !t.derivative).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  for (const t of open.slice(0, 8)) {
    add({ var: "money.trades", value: `${t.date}: ${t.code === "S" ? "sold" : "bought"} ${t.shares?.toLocaleString()} shares${t.price ? ` at $${t.price}` : ""}${t.price && t.shares ? ` (${money(t.price * t.shares)})` : ""}, ${t.after?.toLocaleString()} left`, url: t.url, grade: "v", tier: "A", date: t.date, detail: t });
  }
  const byCode = {};
  for (const t of trades) byCode[t.what] = (byCode[t.what] || 0) + 1;
  const sold = open.filter((t) => t.code === "S").reduce((s, t) => s + (t.shares || 0) * (t.price || 0), 0);
  const bought = open.filter((t) => t.code === "P").reduce((s, t) => s + (t.shares || 0) * (t.price || 0), 0);
  add({ var: "money.trades", value: `${ok.length} recent ownership filings: ${open.filter((t) => t.code === "S").length} open-market sales (${money(sold)}), ${open.filter((t) => t.code === "P").length} purchases (${money(bought)})`, url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${ownerCik}&type=4`, grade: "v", tier: "A", date: ok[0].date, detail: { byType: byCode, filings: ok.map((d) => ({ form: d.form, date: d.date, url: d.view })) } });

  // holdings: the last non-derivative row of the newest filing that has one (rows run in date order)
  const newest = ok.find((d) => d.p.trades.some((t) => !t.derivative && t.after != null) || d.p.holdings.some((h) => !h.derivative && h.after != null));
  let pos = null;
  if (newest) {
    const tr = newest.p.trades.filter((t) => !t.derivative && t.after != null && (t.direct || "D") === "D");
    const t = tr.at(-1) || newest.p.trades.filter((x) => !x.derivative && x.after != null).at(-1);
    const h = newest.p.holdings.filter((x) => !x.derivative && x.after != null).at(-1);
    pos = t ? { ...t, asOf: t.date || newest.p.period || newest.date, url: newest.view } : h ? { ...h, asOf: newest.p.period || newest.date, url: newest.view } : null;
  }
  if (pos) {
    // value at the newest price on record: a price in the same filing, else the latest trade's, dated
    const pxT = newest.p.trades.filter((t) => t.price).at(-1) || trades.filter((t) => t.price).sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
    const px = pxT?.price;
    shared.personShares = pos.after;
    add({ var: "money.holdings", value: `${pos.after.toLocaleString()} ${pos.security || "shares"} held ${pos.direct === "I" ? "indirectly" : "directly"} after ${pos.asOf}${px ? ` (≈ ${money(pos.after * px)} at $${px}${pxT.date && pxT.date !== pos.asOf ? `, price of ${pxT.date}` : ""})` : ""}`, url: pos.url || latest.view, grade: "v", tier: "A", date: pos.asOf, detail: { position: pos, filed: newest.date, derivativeRows: trades.filter((t) => t.derivative).length } });
  }
}

async function proxy(ctx, filings) {
  const { http, add, miss, subject, shared } = ctx;
  const def = filings.find((f) => f.form === "DEF 14A");
  if (!def) return miss("money.comp", "no DEF 14A in recent EDGAR filings");
  const r = await http.get(def.url, { headers: H(), timeout: 25000 });
  if (!r.ok) return miss("money.comp", `DEF 14A fetch ${r.status || r.error}`);
  const sct = parseSCT(r.text, subject);
  if (sct.isNeo && sct.years.length) {
    const y = sct.years[0];
    const parts = Object.entries(y.cells)
      .filter(([k, v]) => v && !/total/i.test(k))
      .map(([k, v]) => `${k.replace(/compensation/i, "").replace(/\s+/g, " ").trim()} ${money(v)}`);
    shared.proxyComp = { year: y.year, total: y.total, cells: y.cells };
    const row = add({ var: "money.comp", value: `FY${y.year} total ${money(y.total)} (${parts.join(", ")})${sct.years[1] ? `; FY${sct.years[1].year} ${money(sct.years[1].total)}` : ""}${sct.years[2] ? `, FY${sct.years[2].year} ${money(sct.years[2].total)}` : ""}`, url: def.url, grade: "v", tier: "A", date: def.date, anchors: ["proxy-neo"], detail: { label: sct.label, header: sct.header, years: sct.years } });
    (shared.refs ||= {}).proxyComp = row?.id;
    if (sct.title) {
      const trow = add({ var: "role.title", value: sct.title, url: def.url, grade: "v", tier: "A", date: def.date, anchors: ["proxy-neo"], detail: { source: `DEF 14A Summary Compensation Table ("${sct.label}")` } });
      titleSeen(shared, sct.title, "proxy", trow);
    }
  } else if (sct.isNeo) {
    shared.neos = sct.neos;
    if (sct.title) titleSeen(shared, sct.title, "proxy", null);
    miss("money.comp", `named in the ${def.date} proxy Summary Compensation Table ("${sct.label}") but the pay rows did not parse`);
  } else if (sct.found) {
    shared.neos = sct.neos;
    miss("money.comp", `not a named executive officer in the ${def.date} proxy Summary Compensation Table (NEOs: ${sct.neos.join(", ")})`);
  } else miss("money.comp", `no Summary Compensation Table parsed in the ${def.date} DEF 14A`);

  const head = r.text.slice(0, 3e6);
  if (!namesSubject(head, subject) && !new RegExp(`\\b(?:Mr|Ms|Mrs|Dr)\\.?\\s+${subject.name.split(/\s+/).at(-1)}\\b`).test(head)) return;
  const text = htmlText(r.text);
  const bio = bioFrom(text, subject);
  // only a real officer bio feeds career rows; a pay paragraph that names them does not
  if (bio && bio.length > 120 && isBio(bio)) {
    for (const s of careerFrom(bio).slice(0, 8)) add({ var: "career.timeline", value: s, url: def.url, grade: "v", tier: "A", date: def.date, detail: { source: "DEF 14A executive officer bio" } });
    for (const s of educationFrom(bio)) add({ var: "career.education", value: s, url: def.url, grade: "v", tier: "A", date: def.date });
    // the current title from the bio's present-perfect line ("has served as our President, Platforms Business since ...")
    if (!(shared.titles || []).some((t) => t.source === "proxy")) {
      const bt = titleFromBio(bio);
      if (bt) {
        const trow = add({ var: "role.title", value: bt, url: def.url, grade: "v", tier: "A", date: def.date, detail: { source: "DEF 14A executive officer bio" } });
        titleSeen(shared, bt, "proxy", trow);
      }
    }
    const st = startFrom(bio);
    if (st) add({ var: "role.start", value: `In the current seat since ${st} (proxy bio)`, url: def.url, grade: "v", tier: "A", date: def.date, detail: { bio: bio.slice(0, 600) } });
  }
  // age from the executive officers table or bio: "Dana Whitlock 51 Executive Vice President" / "Daniel Holloway, age 50"
  for (const n of nameForms(subject)) {
    const age = text.match(new RegExp(`${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}\\s*,?\\s+(?:age\\s+)?(\\d{2})\\b[\\s,]+(?:[A-Z]|has|is|was)`));
    if (age) {
      shared.personAge = Number(age[1]);
      break;
    }
  }
  // what the pay plan says they are judged on; table footnotes are not priorities
  const last = subject.name.split(/\s+/).at(-1);
  const pri = sentences(text).filter((s) => s.includes(last) && /(bonus|incentive|plan|objective|metric|performance|weighted|tied to|based on)/i.test(s) && !/^(\(\d+\)\s*)?(The actual payout|These columns|The amounts? (?:shown|reported|in this column)|Represents|Reflects|Amounts? (?:shown|reported))/i.test(s) && s.length < 500 && (s.match(/\d/g) || []).length / s.length < 0.06);
  for (const s of pri.slice(0, 3)) add({ var: "voice.priorities", value: s, url: def.url, grade: "p", tier: "A", date: def.date, detail: { source: "DEF 14A compensation discussion" } });
}

async function mentions(ctx, cik, hits) {
  const { http, add, miss, subject, shared } = ctx;
  const seen = new Set();
  const docs = hits.filter((h) => !seen.has(h.adsh + h.file) && seen.add(h.adsh + h.file)).sort((a, b) => (a.file_date < b.file_date ? 1 : -1)).slice(0, 4);
  if (!docs.length) return miss("voice.quotes", `no 8-K or press exhibit in EDGAR full-text search mentions ${nameForms(subject).map((n) => `"${n}"`).join(" / ")}`);
  const last = subject.name.split(/\s+/).at(-1);
  const cutoff = new Date(Date.now() - 730 * 864e5).toISOString().slice(0, 10);
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
        if (who && (who.includes(last) || namesSubject(who, subject))) add({ var: "voice.quotes", value: `"${m[1].trim()}"`, url, grade: "v", tier: "A", date: h.file_date, detail: { form: h.form, file: h.file, attribution: (post ? after : before).trim().slice(0, 100) } });
      }
      const body = t.replace(/^.*?(?:FOR IMMEDIATE RELEASE|Item\s*5\.02[^.]*\.)\s*/i, "");
      const named = sentences(body).filter((s) => s.includes(last) && s.length < 600);
      // a filing that says they are leaving: the company's own word, so it is graded verified
      for (const s of named) {
        const dep = departureFrom(s, subject);
        if (dep) {
          (shared.departures ||= []).push({ ...dep, date: h.file_date, url, text: s.slice(0, 300), source: `SEC ${h.form || "8-K"}` });
          break;
        }
      }
      for (const s of named.filter((s) => /(appoint|named|promot|join|hire|elevat|succeed|resign|retire|depart|step down|stepped down)/i.test(s)).slice(0, 1)) {
        // outside the 24-month window an appointment is career history, not a recent executive change
        if (h.file_date >= cutoff) add({ var: "co.exec_changes", value: `${h.file_date}: ${s.slice(0, 300)}`, url, grade: "v", tier: "A", date: h.file_date, anchors: ["names-subject"] });
        else add({ var: "career.timeline", value: `${h.file_date}: ${s.slice(0, 300)}`, url, grade: "v", tier: "A", date: h.file_date, anchors: ["names-subject"], detail: { source: `SEC ${h.form || "8-K"}` } });
      }
    }),
  );
}

export default [company, person];
