// sec-frames: the company against its SEC peers. XBRL frames give every filer's value for one
// concept and calendar period in one call (revenue, net income, total assets); EDGAR's company
// list by SIC code (Atom, 100 a page) says which filers share the company's industry code. The
// join gives a rank, the industry median and the nearest peers by size. Public, User-Agent only.
// About 4 frame calls (0.3-0.5 MB each) plus 1-10 small list pages.

import { SEC_UA } from "../core.mjs";
import { money } from "../colib.mjs";
import { secBase } from "./50-sec.mjs";

const H = () => ({ "user-agent": SEC_UA() });
const FRAMES = "https://data.sec.gov/api/xbrl/frames/us-gaap";
const REV_TAGS = ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax"];

/** CIKs (numbers) and names in one EDGAR company-list Atom page. */
export function parseSicAtom(xml) {
  const out = [];
  for (const m of String(xml || "").matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const cik = Number((m[1].match(/<cik>(\d+)<\/cik>/) || [])[1]);
    const name = ((m[1].match(/<name>([^<]*)<\/name>/) || [])[1] || "").replace(/&amp;/g, "&");
    if (cik) out.push({ cik, name });
  }
  return out;
}

/** Merge frame rows by CIK (largest value wins when a filer reports both revenue tags). */
export function mergeFrames(...frames) {
  const by = new Map();
  for (const f of frames) for (const d of f?.data || []) if (!by.has(d.cik) || d.val > by.get(d.cik).val) by.set(d.cik, d);
  return by;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

/**
 * The company's standing among peers on one measure: { rank, n, median, value, nearest[] }.
 * peers: Set of CIKs in the same SIC (the company included); by: Map cik -> frame row.
 */
export function standing(cik, peers, by, nNear = 4) {
  const me = by.get(cik);
  if (!me) return null;
  const rows = [...peers].map((c) => by.get(c)).filter(Boolean).sort((a, b) => b.val - a.val);
  if (rows.length < 3) return null;
  const rank = rows.findIndex((r) => r.cik === cik) + 1;
  const nearest = rows.filter((r) => r.cik !== cik).sort((a, b) => Math.abs(Math.log(Math.abs(a.val) + 1) - Math.log(Math.abs(me.val) + 1)) - Math.abs(Math.log(Math.abs(b.val) + 1) - Math.log(Math.abs(me.val) + 1))).slice(0, nNear);
  return { rank, n: rows.length, median: median(rows.map((r) => r.val)), value: me.val, end: me.end, nearest: nearest.map((r) => ({ cik: r.cik, name: r.entityName, val: r.val, end: r.end })) };
}

export default {
  id: "sec-frames",
  /** The ledger variables this module fills (config/form buckets read them to say "no tool yet"). */
  vars: ["co.peers"],
  label: "SEC XBRL frames: revenue, profit and assets against same-SIC peers",
  lane: "fast",
  needs: ["company"],
  budgetMs: 15000,
  async run(ctx) {
    const { http } = ctx;
    const b = await secBase(ctx);
    if (!b?.cik) return ctx.miss("co.peers", b?.none ? `"${ctx.subject.company}" is not an SEC registrant: no XBRL peer frames` : `SEC lookup failed (${b?.error || "unknown"}): peers not checked`);
    const sic = b.sub?.sic;
    const sicName = b.sub?.sicDescription || `SIC ${sic}`;
    if (!sic) return ctx.miss("co.peers", "the SEC record carries no SIC code: peers not checked");
    // the newest full calendar year with the company in the revenue frame
    const y0 = new Date().getUTCFullYear() - 1;
    const frame = (tag, period) => http.json(`${FRAMES}/${tag}/USD/${period}.json`, { headers: H(), timeout: 12000 });
    // EDGAR's SIC list is alphabetical, 100 a page; a page sometimes takes 6 s or more. Paging
    // stops at a 6 s deadline and the peer set is then marked partial rather than waited for.
    const deadline = Date.now() + 6000;
    let partial = false;
    const peersP = (async () => {
      const set = new Map();
      const page = async (s) => {
        const u = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&SIC=${sic}&type=10-K&dateb=&owner=include&count=100&start=${s}&output=atom`;
        const r = await http.get(u, { headers: H(), timeout: 3000 });
        return r.ok || Date.now() > deadline - 3000 ? r : http.get(u, { headers: H(), timeout: 3000 });
      };
      for (let start = 0; start < 1500; start += 500) {
        if (Date.now() > deadline) {
          partial = true;
          break;
        }
        const pages = await Promise.all([0, 100, 200, 300, 400].map((o) => page(start + o)));
        let short = false;
        for (const p of pages) {
          const list = parseSicAtom(p.text);
          for (const x of list) set.set(x.cik, x.name);
          if (!p.ok) partial = true;
          else if (list.length < 100) short = true;
        }
        if (short) break;
      }
      return set;
    })();
    let year = y0;
    let rev = mergeFrames(...(await Promise.all(REV_TAGS.map((t) => frame(t, `CY${year}`)))).map((r) => r.data));
    if (!rev.has(b.cik)) {
      year = y0 - 1;
      rev = mergeFrames(...(await Promise.all(REV_TAGS.map((t) => frame(t, `CY${year}`)))).map((r) => r.data));
    }
    const [ni, assets, peerMap] = await Promise.all([frame("NetIncomeLoss", `CY${year}`), frame("Assets", `CY${year}Q4I`), peersP]);
    const peers = new Set(peerMap.keys());
    peers.add(b.cik);
    if (peers.size < 4) return ctx.miss("co.peers", `EDGAR lists fewer than 3 other 10-K filers under SIC ${sic} (${sicName})`);
    const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&SIC=${sic}&type=10-K`;
    const line = (label, s, fmt = money) => `${label} ${fmt(s.value)} (FY ending ${s.end}): #${s.rank} of ${s.n} filers in SIC ${sic} ${sicName} reporting it for CY${year}${partial ? " (partial SIC list)" : ""}; peer median ${fmt(s.median)}; nearest by size: ${s.nearest.map((x) => `${x.name} ${fmt(x.val)}`).join("; ")}`;
    let n = 0;
    const r = standing(b.cik, peers, rev);
    if (r) {
      ctx.add({ var: "co.peers", value: line("Revenue", r), url, grade: "v", tier: "A", date: r.end, anchors: ["cik", "sic"], detail: { measure: "revenue", tags: REV_TAGS, year, sic, sicName, partialPeerList: partial, ...r } });
      n++;
    }
    const nb = mergeFrames(ni.data);
    const s2 = standing(b.cik, peers, nb);
    if (s2) {
      const margins = [...peers].map((c) => (rev.get(c)?.val > 0 && nb.get(c) ? nb.get(c).val / rev.get(c).val : null)).filter((x) => x != null);
      const myMargin = rev.get(b.cik)?.val > 0 ? nb.get(b.cik).val / rev.get(b.cik).val : null;
      ctx.add({ var: "co.peers", value: line("Net income", s2) + (myMargin != null && margins.length > 2 ? `; net margin ${(myMargin * 100).toFixed(1)}% against a peer median of ${(median(margins) * 100).toFixed(1)}%` : ""), url, grade: "v", tier: "A", date: s2.end, anchors: ["cik", "sic"], detail: { measure: "net income", year, sic, ...s2, margin: myMargin, peerMedianMargin: margins.length > 2 ? median(margins) : null } });
      n++;
    }
    const s3 = standing(b.cik, peers, mergeFrames(assets.data));
    if (s3) {
      ctx.add({ var: "co.peers", value: line("Total assets", s3), url, grade: "v", tier: "A", date: s3.end, anchors: ["cik", "sic"], detail: { measure: "assets", year, sic, ...s3 } });
      n++;
    }
    if (!n) ctx.miss("co.peers", `${b.title || ctx.subject.company} is not in the CY${year} XBRL frames for revenue, net income or assets (non-calendar or foreign filer), or fewer than 3 same-SIC peers report them`);
  },
};
