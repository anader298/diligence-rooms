// article-extract (heavy, opt-in: --heavy article-extract [--articles url1,url2]). Reads the main
// text of chosen article pages with trafilatura in a Python sidecar (scripts/osint/py/extract_text.py,
// Apache-2.0, installed by pip). The Node runner fetches the pages (cache, spacing, budget); the
// sidecar only parses. Inputs: --articles, else up to five article URLs already in the ledger
// that name the subject (news, quotes, press). Output: byline, date, outlet, the sentences that
// name the subject and the quotes attributed to them.

import { runSidecar, depMiss } from "../sidecar.mjs";
import { namesSubject } from "../core.mjs";
import { nameMatch, lastIn, companyIn, hostOf, pool, isBlocked } from "../person-lib.mjs";
import { sentences } from "../colib.mjs";
import { extractQuotes } from "./26-quotes.mjs";

const ARTICLE_VARS = new Set(["news.articles", "voice.quotes", "voice.writing", "news.company", "co.exec_changes"]);
const NOT_ARTICLE = /(youtube\.com|youtu\.be|linkedin\.com|x\.com|twitter\.com|facebook\.com|instagram\.com|sec\.gov\/cgi-bin|\.pdf($|\?)|news\.google\.com\/rss)/i;

/** Article URLs to read: the ones given, else ledger rows that name the subject, best graded first. */
export function articleUrls(opts = {}, rows = [], subject = {}, max = 5) {
  const given = (opts.articles || []).filter((u) => /^https?:\/\//.test(u));
  if (given.length) return given.slice(0, 20).map((url) => ({ url, from: "--articles" }));
  const rank = { v: 0, p: 1, w: 2 };
  const seen = new Set();
  return rows
    .filter((r) => ARTICLE_VARS.has(r.var) && r.url && /^https?:\/\//.test(r.url) && !NOT_ARTICLE.test(r.url) && (r.grade in rank) && namesSubject(`${r.value} ${JSON.stringify(r.detail || "")}`, subject))
    .sort((a, b) => rank[a.grade] - rank[b.grade])
    .filter((r) => !seen.has(r.url) && seen.add(r.url))
    .slice(0, max)
    .map((r) => ({ url: r.url, from: `ledger ${r.id}` }));
}

/** A refusal page, not an article: a refusal status, or a short page that is mostly a challenge.
 *  (person-lib's isBlocked also fires on full articles whose head mentions a captcha library.) */
export function refused(res) {
  if (!res?.ok || !res.text) return true;
  return res.text.length < 30000 && isBlocked(res);
}

/** What an extracted article says about the subject. */
export function readArticle(res, subject) {
  const text = res.text || "";
  const named = nameMatch(text, subject) || nameMatch(res.title || "", subject);
  const about = named ? sentences(text).filter((s) => nameMatch(s, subject) || lastIn(s, subject)).slice(0, 8) : [];
  const quotes = named ? extractQuotes(text, subject).slice(0, 6) : [];
  return { named, about, quotes, words: text.split(/\s+/).filter(Boolean).length, company: companyIn(text, subject) };
}

export default {
  id: "article-extract",
  label: "Article text: byline, date, what it says about them (opt-in)",
  lane: "heavy",
  flag: "--heavy article-extract --articles <urls>",
  needs: ["name"],
  deps: { python: ["trafilatura"] },
  budgetMs: 60000,
  async run(ctx) {
    const { subject, http, opts = {} } = ctx;
    const want = articleUrls(opts, ctx.rows || [], subject);
    if (!want.length) return ctx.miss("news.article_text", "article extract not run: no article URLs (pass --articles, or the news and quote modules must find articles that name the subject)");
    const pages = await pool(want, 4, async (w) => ({ ...w, res: await http.get(w.url, { timeout: 12000 }) }));
    const docs = pages.filter((p) => p?.res && !refused(p.res));
    for (const p of pages.filter((p) => p && !docs.includes(p))) ctx.miss("news.article_text", `${hostOf(p.url)}: blocked or unreadable (HTTP ${p.res?.status || p.res?.error}), unknown: ${p.url}`);
    if (!docs.length) return ctx.status("partial", "every article page refused the fetch");
    const r = await runSidecar("extract_text", { docs: docs.map((d) => ({ url: d.url, html: d.res.text })) }, { timeoutMs: 45000, env: ctx.env });
    if (r.missing) return depMiss(ctx, "news.article_text", "article extract", r.missing, null, ["trafilatura"]);
    if (!r.ok) {
      ctx.status("error", `sidecar: ${r.error}`);
      return ctx.miss("news.article_text", `article extract not run: sidecar failed (${r.error})`);
    }
    for (const res of r.data.results || []) {
      if (res.error || !res.text) {
        ctx.miss("news.article_text", `${hostOf(res.url)}: no main text extracted (${res.error || "empty"})`);
        continue;
      }
      const a = readArticle(res, subject);
      if (!a.named) {
        ctx.miss("news.article_text", `${hostOf(res.url)}: "${String(res.title || "").slice(0, 80)}" does not name ${subject.name} in its main text`);
        continue;
      }
      const head = [res.sitename || hostOf(res.url), res.date, res.author && `by ${res.author}`].filter(Boolean).join(", ");
      ctx.add({
        var: "news.article_text",
        value: `${res.title || res.url} (${head}): ${a.about.length} sentence(s) about ${subject.name}${a.quotes.length ? `, ${a.quotes.length} quote(s)` : ""}${a.about[0] ? ` — "${a.about[0].slice(0, 220)}"` : ""}`,
        url: res.url,
        date: res.date || null,
        grade: a.company ? "p" : "w",
        tier: "B",
        anchors: a.company ? ["name", "company"] : ["name"],
        detail: { title: res.title, author: res.author, date: res.date, outlet: res.sitename, words: a.words, about: a.about, quotes: a.quotes, excerpt: res.text.slice(0, 4000), extractor: "trafilatura" },
      });
      for (const q of a.quotes) ctx.add({ var: "voice.quotes", value: `"${q}"`, url: res.url, date: res.date || null, grade: a.company ? "p" : "w", tier: "B", anchors: a.company ? ["name", "company"] : ["name"], detail: { source: "article-extract", title: res.title, outlet: res.sitename } });
    }
  },
};
