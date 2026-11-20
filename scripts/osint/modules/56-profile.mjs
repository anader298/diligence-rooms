// Company profile from open registries: Wikidata (founded, HQ, headcount, parent, CEO),
// GDELT news in the last 90 days, DOL Form 5500 benefit plans (participants = headcount
// check, works for private companies), ProPublica Nonprofit Explorer for nonprofits.
import { normCompany, sameCompany, money } from "../colib.mjs";
import { normName, NICKNAMES } from "../core.mjs";

// given names, for telling "Kim Varga" (a person) from "Varga" (the company) in a headline
const FIRST_NAMES = new Set([...Object.keys(NICKNAMES), ...Object.values(NICKNAMES).flat(), ..."mary anna emma olivia sophia james david mark paul kevin brian jason ryan eric scott adam aaron sean shane travis steve mitchell nathan josh travis glenn".split(" ")]);
import { secBase } from "./50-sec.mjs";

// the record names the company itself, not another company sharing a word with it
const same = (a, b) => sameCompany(a, b);

export const BUSINESS_CUE = /\b(inc|corp|co\.|company|shares?|stocks?|earnings|revenue|quarter(?:ly)?|results|sales|profit|loss|ceo|cfo|cto|coo|executive|plant|factory|layoffs?|jobs|hiring|acquir\w*|acquisition|merger|deal|launch\w*|announc\w*|reports?|partner\w*|engines?|products?|customers?|guidance|investors?|nasdaq|nyse|ipo|funding|raises?|valuation|hires|appoints?|names|startup|software|platform|unveils|expands|opens|recall|lawsuit|sues|sued|contract|order)\b/i;

/**
 * True when a one-word company name in a headline is a person's surname: "Kim Varga breaks
 * silence" or "Varga might not be available" (an athlete), not Varga Inc.
 */
export function headlineIsPerson(title, company) {
  const w = normName(company).replace(/\b(inc|corp|corporation|co|company|ltd|llc|plc|holdings?)\b/g, " ").replace(/\s+/g, " ").trim();
  if (!w || w.includes(" ")) return false;
  for (const m of String(title).matchAll(/\b([A-Z][a-z]+)\s+([A-Z][\w'’]+)/g)) if (normName(m[2]) === w && FIRST_NAMES.has(normName(m[1]))) return true;
  const t = normName(title);
  return new RegExp(`(^| )${w} [^.]{0,40}?\\b(says|said|wont|will not|might not|breaks silence|to address media|captain|ruled out|injur\\w*|selected|dropped)\\b`).test(t) && !/\b(inc|corp|shares|stock|earnings|revenue|quarter|sales|engines?|company|ceo|plant|factory|announces|reports)\b/i.test(title);
}

const wikidata = {
  id: "wikidata",
  /** The ledger variables this module fills (config/form buckets read them to say "no tool yet"). */
  vars: ["co.facts", "co.leadership", "co.owners"],
  label: "Wikidata: founded, HQ, headcount, parent, CEO",
  lane: "slow", // after the SEC address and the first web-archive capture, which it is checked against
  needs: ["company"],
  budgetMs: 20000,
  async run(ctx) {
    const { http, add, miss, subject, shared } = ctx;
    const API = "https://www.wikidata.org/w/api.php";
    const s = await http.json(`${API}?action=wbsearchentities&search=${encodeURIComponent(subject.company)}&language=en&type=item&limit=7&format=json`, { timeout: 10000 });
    const ids = (s.data?.search || []).map((x) => x.id);
    if (!ids.length) return miss("co.facts", `no Wikidata item for "${subject.company}"`);
    const e = await http.json(`${API}?action=wbgetentities&ids=${ids.join("|")}&props=claims|labels|descriptions&languages=en&format=json`, { timeout: 10000 });
    const ents = Object.values(e.data?.entities || {});
    const dom = (subject.domain || "").replace(/^www\./, "");
    const site = (x) => (x.claims?.P856 || []).map((c) => c.mainsnak?.datavalue?.value).filter(Boolean);
    const isCo = (x) => /(company|corporation|manufacturer|business|enterprise|firm|developer|provider|startup|maker|software|organi[sz]ation)/i.test(x.descriptions?.en?.value || "");
    const pick = (dom && ents.find((x) => site(x).some((w) => w.includes(dom)))) || ents.find((x) => isCo(x) && same(subject.company, x.labels?.en?.value || ""));
    if (!pick) return miss("co.facts", `Wikidata has items named like "${subject.company}" but none with website ${dom || "?"} or a company description`);
    const anchored = dom && site(pick).some((w) => w.includes(dom));
    // deprecated statements are values Wikidata itself marks wrong or outdated; a preferred one beats the rest
    const claim = (p) => {
      const all = (pick.claims?.[p] || []).filter((c) => c.rank !== "deprecated");
      const pref = all.filter((c) => c.rank === "preferred");
      return pref.length ? pref : all;
    };
    const val = (c) => c.mainsnak?.datavalue?.value;
    const refIds = [...new Set(["P159", "P749", "P169", "P452", "P414", "P17"].flatMap((p) => claim(p).map((c) => val(c)?.id)).filter(Boolean))];
    const lab = refIds.length ? await http.json(`${API}?action=wbgetentities&ids=${refIds.join("|")}&props=labels&languages=en&format=json`, { timeout: 10000 }) : null;
    const L = (id) => lab?.data?.entities?.[id]?.labels?.en?.value || id;
    const latest = (p) => claim(p).map((c) => ({ v: val(c), t: c.qualifiers?.P585?.[0]?.datavalue?.value?.time || "" })).sort((a, b) => (a.t < b.t ? 1 : -1))[0];
    const url = `https://www.wikidata.org/wiki/${pick.id}`;
    const facts = {};
    const inc = val(claim("P571")[0])?.time;
    if (inc) facts.founded = inc.slice(1, 5);
    // the SEC business address is the registrant's own filing; Wikidata's HQ is community-edited and often stale
    if (subject.company) await secBase(ctx).catch(() => null);
    const secAddr = shared.secAddress;
    if (secAddr?.city) facts.hq = `${secAddr.city}${secAddr.state ? ", " + secAddr.state : ""} (SEC business address)`;
    else if (claim("P159").length) facts.hq = claim("P159").map((c) => L(val(c)?.id)).join(", ") + " (Wikidata)";
    const emp = latest("P1128");
    if (emp?.v?.amount) facts.employees = `${Number(emp.v.amount).toLocaleString()}${emp.t ? ` (${emp.t.slice(1, 5)})` : ""}`;
    if (claim("P749").length) facts.parent = claim("P749").map((c) => L(val(c)?.id)).join(", ");
    if (claim("P169").length) facts.ceo = L(val(claim("P169").at(-1))?.id);
    if (shared.sic) facts.industry = `${shared.sic} (SEC SIC code)`;
    else if (claim("P452").length) facts.industry = claim("P452").slice(0, 3).map((c) => L(val(c)?.id)).join(", ") + " (Wikidata)";
    if (claim("P414").length) facts.exchange = claim("P414").map((c) => L(val(c)?.id)).join(", ");
    const rev = latest("P2139");
    if (rev?.v?.amount) facts.revenue = `${money(Number(rev.v.amount))}${rev.t ? ` (${rev.t.slice(1, 5)})` : ""}`;
    if (!Object.keys(facts).length) return miss("co.facts", `Wikidata ${pick.id} has no founding, HQ or headcount claims`);
    let setFallback = false;
    if (emp?.v?.amount) {
      shared.employeesFallback = Number(emp.v.amount);
      shared.employeesFallbackSource = `Wikidata ${emp.t.slice(1, 5) || "(undated)"}`;
      setFallback = true;
    }
    // one community-edited source is never "verified"; a website match makes it a fair reading
    const grade = anchored ? "p" : "w";
    if (facts.founded && shared.firstSeenYear && Number(facts.founded) > shared.firstSeenYear + 1) facts.founded += ` (the domain served a page from ${shared.firstSeenYear}, possibly under an earlier owner or entity)`;
    const wrow = add({ var: "co.facts", value: "Wikidata: " + Object.entries(facts).map(([k, v]) => `${k} ${v}`).join("; "), url, grade, tier: "A", anchors: anchored ? ["website-match"] : ["name-match"], detail: { id: pick.id, label: pick.labels?.en?.value, description: pick.descriptions?.en?.value, note: "community-edited; checked against the SEC address and SIC code where the company files", ...facts } });
    if (setFallback && wrow?.id) (shared.refs ||= {}).employeesFallback = wrow.id;
    if (facts.ceo) add({ var: "co.leadership", value: `${facts.ceo}, CEO (Wikidata)`, url, grade: "p", tier: "A" });
    if (facts.parent) add({ var: "co.owners", value: `Parent: ${facts.parent}`, url, grade, tier: "A" });
  },
};

const gdelt = {
  id: "company-news",
  /** The ledger variables this module fills (config/form buckets read them to say "no tool yet"). */
  vars: ["news.company"],
  label: "Company news, last 90 days (GDELT, Google News RSS fallback)",
  lane: "fast",
  needs: ["company"],
  budgetMs: 25000,
  async run(ctx) {
    const { http, add, miss, subject } = ctx;
    const q = `"${normCompany(subject.company).replace(/\b\w/g, (c) => c.toUpperCase())}"`;
    const u = `http://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=artlist&maxrecords=25&timespan=90d&format=json&sort=datedesc`;
    let r = await http.json(u, { timeout: 15000 });
    if (!r.data && /limit requests/i.test(r.text || "")) {
      await new Promise((res) => setTimeout(res, 5500));
      r = await http.json(u, { timeout: 15000, cache: false });
    }
    const arts = r.data ? (r.data.articles || []).filter((a) => (a.language || "English") === "English") : [];
    const seen = new Set();
    let n = 0;
    const push = (title, src, url, d, engine, grade = "p") => {
      const k = title.toLowerCase().slice(0, 60);
      if (seen.has(k) || n >= 8) return;
      seen.add(k);
      n++;
      add({ var: "news.company", value: `${title} (${src}${d ? ", " + d : ""})`, url, grade, tier: "C", date: d, detail: { source: engine, note: grade === "w" ? "company named in the article body only" : "company named in the headline" } });
    };
    // the company's whole name as a phrase ("Sentrylink", not "Fantasy Alarm"); a one-word name must stand alone
    const phrase = " " + normName(subject.company).replace(/\b(inc|corp|corporation|co|company|ltd|llc|plc|holdings?)\b/g, " ").replace(/\s+/g, " ").trim() + " ";
    // a one-word company that is also a surname ("Varga", "Lund's") must not be a person's name in
    // the headline: "Kim Varga breaks silence" is an athlete, not Varga Inc.
    const asPerson = (t) => headlineIsPerson(t, subject.company);
    const named = (t) => phrase.trim().length > 1 && (" " + normName(t) + " ").includes(phrase) && !asPerson(t);
    // a one-word name is also a street, a surname, a physics term: without a business word in the
    // headline the article is only Weak ("Varga Highway project", "lattice phonons")
    const businessy = (t) => !/^\S+$/.test(phrase.trim()) || BUSINESS_CUE.test(t) || (subject.domain && String(t).toLowerCase().includes(subject.domain.toLowerCase()));
    arts.sort((a, b) => named(b.title) - named(a.title));
    for (const a of arts) push(a.title, a.domain, a.url, a.seendate ? `${a.seendate.slice(0, 4)}-${a.seendate.slice(4, 6)}-${a.seendate.slice(6, 8)}` : null, "GDELT", named(a.title) && businessy(a.title) ? "p" : "w");
    if (n) return;
    // fallback: Google News RSS, titles that name the company only
    const g = await http.get(`https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:90d")}&hl=en-US&gl=US&ceid=US:en`, { timeout: 10000 });
    for (const it of (g.text || "").matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const x = it[1];
      const title = decode(x.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "");
      const link = x.match(/<link>([\s\S]*?)<\/link>/)?.[1];
      const src = decode(x.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || "");
      const pd = x.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1];
      if (!title || !named(title.replace(/ - [^-]+$/, ""))) continue;
      push(title.replace(/ - [^-]+$/, ""), src, link, pd ? new Date(pd).toISOString().slice(0, 10) : null, "Google News RSS", businessy(title) ? "p" : "w");
    }
    if (!n) miss("news.company", `no company-named articles in 90 days: GDELT ${r.data ? "0 hits" : r.status === 429 || /limit requests/i.test(r.text || "") ? "rate-limited (one call per 5 s)" : r.status || r.error}; Google News RSS ${g.ok ? "no title naming the company" : g.status || g.error}`);
  },
};

const decode = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

const form5500 = {
  id: "form5500",
  /** The ledger variables this module fills (config/form buckets read them to say "no tool yet"). */
  vars: ["co.benefit_plans", "co.facts"],
  label: "DOL Form 5500: benefit plans and participant counts",
  lane: "fast",
  needs: ["company"],
  budgetMs: 20000,
  async run(ctx) {
    const { http, add, miss, subject, shared } = ctx;
    const name = normCompany(subject.company).toUpperCase();
    const u = `https://www.efast.dol.gov/services/afs?q.parser=lucene&size=100&q=${encodeURIComponent(`plansponsor:"${name}"`)}`;
    const r = await http.json(u, { timeout: 15000 });
    if (!r.data) return miss("co.benefit_plans", `DOL EFAST2 search ${r.status || r.error}`);
    const hits = (r.data.hits?.hit || []).map((h) => h.fields).filter((f) => same(subject.company, f.plansponsor));
    if (!hits.length) return miss("co.benefit_plans", `no Form 5500 filings with sponsor "${name}" in DOL EFAST2`);
    // newest filing per plan
    const byPlan = new Map();
    for (const f of hits) {
      const k = f.ein + "-" + f.pn;
      const p = byPlan.get(k);
      if (!p || f.planyear > p.planyear || (f.planyear === p.planyear && f.datereceived > p.datereceived)) byPlan.set(k, f);
    }
    const plans = [...byPlan.values()].sort((a, b) => b.planyear - a.planyear || Number(b.participantsboy || 0) - Number(a.participantsboy || 0));
    const recent = plans.filter((p) => Number(p.planyear) >= Number(plans[0].planyear) - 2);
    const page = `https://www.efast.dol.gov/5500search/`;
    const lastNonZero = (p) => hits.filter((f) => f.ein === p.ein && f.pn === p.pn && Number(f.participantsboy) > 0).sort((a, b) => b.planyear - a.planyear)[0];
    for (const p of recent.slice(0, 4)) {
      let n = Number(p.participantsboy || 0);
      if (!n) {
        const nz = lastNonZero(p);
        if (nz) {
          const prow = add({ var: "co.benefit_plans", value: `${p.planname}: ${Number(nz.participantsboy).toLocaleString()} participants (plan year ${nz.planyear}); newest filing ${p.planyear} reports none${Number(p.planyear) > Number(nz.planyear) ? " (plan may have closed or moved to a PEO)" : ""}`, url: page, grade: "v", tier: "A", date: nz.datereceived?.slice(0, 10), detail: { latest: p, lastWithParticipants: nz } });
          if (Number(p.pn) < 500 && !shared.employeesFallback) {
            shared.employeesFallback = Number(nz.participantsboy);
            shared.employeesFallbackSource = `Form 5500 participants ${nz.planyear} (stale)`;
            if (prow?.id) (shared.refs ||= {}).employeesFallback = prow.id;
          }
          continue;
        }
      }
      add({ var: "co.benefit_plans", value: `${p.planname}: ${n ? n.toLocaleString() + " participants" : "participants not reported"} (plan year ${p.planyear})${Number(p.assetseoy) ? `, assets ${money(Number(p.assetseoy))}` : ""}`, url: page, grade: "v", tier: "A", date: p.datereceived?.slice(0, 10), detail: { ...p, pdf: p.pdfpath ? `https://www.efast.dol.gov/portal/app/disseminatePublic?execution=e1s1&pdfpath=${p.pdfpath}` : null, search: page } });
    }
    const ret = recent.filter((p) => Number(p.pn) < 500 && Number(p.participantsboy) > 0).sort((a, b) => Number(b.participantsboy) - Number(a.participantsboy))[0];
    if (ret) {
      shared.planParticipants = Number(ret.participantsboy);
      shared.ein = ret.ein;
      const own = !shared.employeesFallback;
      if (own) {
        shared.employeesFallback = Number(ret.participantsboy);
        shared.employeesFallbackSource = `Form 5500 ${ret.planname} participants ${ret.planyear} (includes former staff with balances)`;
      }
      const frow = add({ var: "co.facts", value: `EIN ${ret.ein}; ~${Number(ret.participantsboy).toLocaleString()} retirement-plan participants (${ret.planyear}): headcount check`, url: page, grade: "p", tier: "A", detail: { note: "participants include former employees still holding balances; treat as an upper bound on headcount", plan: ret } });
      if (own && frow?.id) (shared.refs ||= {}).employeesFallback = frow.id;
    }
  },
};

const nonprofit = {
  id: "nonprofit",
  /** The ledger variables this module fills (config/form buckets read them to say "no tool yet"). */
  vars: ["co.facts"],
  label: "ProPublica Nonprofit Explorer (nonprofits only)",
  lane: "fast",
  needs: ["company"],
  budgetMs: 15000,
  async run(ctx) {
    const { http, add, miss, subject } = ctx;
    if (!/(foundation|association|institute|society|university|college|hospital|fund|trust|council|center|centre|alliance|museum|charit|ministr|church|school|nonprofit|non-profit)/i.test(subject.company)) return;
    const r = await http.json(`https://projects.propublica.org/nonprofits/api/v2/search.json?q=${encodeURIComponent(subject.company)}`, { timeout: 12000 });
    const org = (r.data?.organizations || []).find((o) => same(subject.company, o.name));
    if (!org) return miss("co.facts", `ProPublica Nonprofit Explorer: no organisation named "${subject.company}"`);
    const d = await http.json(`https://projects.propublica.org/nonprofits/api/v2/organizations/${org.ein}.json`, { timeout: 12000 });
    const f = d.data?.filings_with_data?.[0];
    add({ var: "co.facts", value: `Nonprofit ${org.name} (EIN ${org.ein}, ${org.city}, ${org.state})${f ? `: revenue ${money(f.totrevenue)}, expenses ${money(f.totfuncexpns)}, assets ${money(f.totassetsend)} (FY${f.tax_prd_yr})` : ""}`, url: `https://projects.propublica.org/nonprofits/organizations/${org.ein}`, grade: "v", tier: "A", detail: { org, filing: f } });
  },
};

export default [wikidata, gdelt, form5500, nonprofit];
