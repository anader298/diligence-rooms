// wikipedia: the person's English Wikipedia article, when there is one. Search "<name>" with the
// company; an article counts only when its title names the person and its summary names the
// company (or words of the person's title). The REST summary gives a short bio and a thumbnail;
// 24 months of pageviews give the attention line and the spike months, which usually mark news
// (appointment, deal, departure). Text is CC BY-SA 4.0: attribute when quoting (detail.terms).

import { nameMatch, companyIn, normName } from "../person-lib.mjs";
import { SEC_UA } from "../core.mjs";

const W = "https://en.wikipedia.org";
// Wikimedia asks API clients for a descriptive User-Agent with a contact; a browser UA gets 429s.
const H = () => ({ "user-agent": `diligence-rooms-osint/1.0 (${SEC_UA().split(" ").pop()})` });
const TERMS = "Wikipedia text is CC BY-SA 4.0; attribute and link when quoting";
const GENERIC = new Set("vice president senior director manager head of and the chief officer executive general global lead principal associate assistant deputy group svp evp vp sr jr business".split(" "));

/** Candidate article titles from a list=search response that name the subject. */
export function wikiTitles(json, subject) {
  return (json?.query?.search || []).map((s) => s.title).filter((t) => nameMatch(t.replace(/\s*\(.*\)$/, ""), subject));
}

/** Does the summary tie the article to the subject's company or title? */
export function wikiAnchors(summary, subject) {
  const text = `${summary?.description || ""} ${summary?.extract || ""}`;
  const out = [];
  if (companyIn(text, subject)) out.push("company");
  const tw = normName(subject.title || "").split(" ").filter((w) => w.length > 3 && !GENERIC.has(w));
  if (tw.length && tw.some((w) => (" " + normName(text) + " ").includes(" " + w + " "))) out.push("title");
  return out;
}

/** Months whose views are well above the run of the series: [{ month, views, x }], biggest first. */
export function viewSpikes(items, { factor = 2.5, max = 5 } = {}) {
  const v = (items || []).map((i) => ({ month: `${String(i.timestamp).slice(0, 4)}-${String(i.timestamp).slice(4, 6)}`, views: i.views }));
  if (v.length < 4) return { months: v, median: null, spikes: [] };
  const sorted = v.map((x) => x.views).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const spikes = v.filter((x) => median > 0 && x.views >= factor * median).map((x) => ({ ...x, x: Math.round((x.views / median) * 10) / 10 })).sort((a, b) => b.views - a.views).slice(0, max);
  return { months: v, median, spikes };
}

const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");

export default {
  id: "wikipedia",
  /** The ledger variables this module fills (config/form buckets read them to say "no tool yet"). */
  vars: ["bio.wikipedia", "news.attention"],
  label: "Wikipedia article and pageview spikes",
  lane: "fast",
  needs: ["name"],
  budgetMs: 10000,
  async run(ctx) {
    const { subject, http } = ctx;
    const q = (s) => http.json(`${W}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(s)}&srlimit=5&format=json`, { timeout: 5000, headers: H() });
    let titles = [];
    const first = await q(`"${subject.name}"${subject.company ? ` ${subject.company}` : ""}`);
    titles = wikiTitles(first.data, subject);
    if (!titles.length && subject.company) titles = wikiTitles((await q(`"${subject.name}"`)).data, subject);
    if (!titles.length) return ctx.miss("bio.wikipedia", `English Wikipedia: no article titled ${subject.name}${first.ok ? "" : ` (search HTTP ${first.status || first.error}), not checked`}`, { blocked: !first.ok });
    let pick = null;
    let unread = 0;
    for (const t of titles.slice(0, 3)) {
      const s = await http.json(`${W}/api/rest_v1/page/summary/${encodeURIComponent(t.replace(/ /g, "_"))}`, { timeout: 5000, headers: H() });
      if (!s.ok) unread++;
      if (!s.ok || s.data?.type === "disambiguation") continue;
      const anchors = wikiAnchors(s.data, subject);
      if (anchors.length) {
        pick = { t, s: s.data, anchors };
        break;
      }
    }
    if (!pick) return ctx.miss("bio.wikipedia", `English Wikipedia: ${titles.slice(0, 3).map((t) => `"${t}"`).join(", ")} found, but none names ${subject.company || "the company"}${subject.title ? ` or "${subject.title}"` : ""} (a namesake, not used)${unread ? `; ${unread} article summar${unread === 1 ? "y" : "ies"} not read` : ""}`, { blocked: unread > 0 && unread === Math.min(titles.length, 3) });
    const { s } = pick;
    const url = s.content_urls?.desktop?.page || `${W}/wiki/${encodeURIComponent(pick.t.replace(/ /g, "_"))}`;
    ctx.add({ var: "bio.wikipedia", value: `${s.title}${s.description ? ` — ${s.description}` : ""}: ${String(s.extract || "").slice(0, 400)}`, url, grade: "p", tier: "A", anchors: ["name", ...pick.anchors], image: s.thumbnail?.source || null, date: s.timestamp ? String(s.timestamp).slice(0, 10) : null, detail: { title: s.title, wikibase: s.wikibase_item || null, description: s.description || null, revised: s.timestamp || null, thumbnail: s.originalimage?.source || s.thumbnail?.source || null, terms: TERMS } });
    const end = new Date();
    end.setUTCDate(0); // last day of the previous month
    const start = new Date(Date.UTC(end.getUTCFullYear() - 2, end.getUTCMonth() + 1, 1));
    const pv = await http.json(`https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${encodeURIComponent(s.titles?.canonical || pick.t.replace(/ /g, "_"))}/monthly/${ymd(start)}00/${ymd(end)}00`, { timeout: 5000, headers: H() });
    if (!pv.ok) return ctx.miss("news.attention", `Wikipedia pageviews: HTTP ${pv.status || pv.error}, not checked`, { blocked: true });
    const { months, median, spikes } = viewSpikes(pv.data?.items);
    const total = months.reduce((a, x) => a + x.views, 0);
    const pvUrl = `https://pageviews.wmcloud.org/?project=en.wikipedia.org&pages=${encodeURIComponent(pick.t.replace(/ /g, "_"))}&range=latest-730`;
    ctx.add({ var: "news.attention", value: `Wikipedia "${s.title}": ${total.toLocaleString()} views in ${months.length} months (median ${median?.toLocaleString() ?? "?"} a month)${spikes.length ? `; spikes ${spikes.map((x) => `${x.month} (${x.views.toLocaleString()}, ${x.x}×)`).join(", ")}` : "; no spikes"}`, url: pvUrl, grade: "v", tier: "A", detail: { months, median, spikes } });
    for (const x of spikes) ctx.add({ var: "news.attention", value: `${x.month}: ${x.views.toLocaleString()} Wikipedia views, ${x.x}× the monthly median: look for news that month`, url: pvUrl, grade: "v", tier: "C", date: `${x.month}-01`, detail: x });
  },
};
