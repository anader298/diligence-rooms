// The company's own site: leadership/team pages (names, titles, bios, headshots), the
// subject's bio page if there is one, and press/news titles that name them.
import { nameIn, normName, metaTags } from "../core.mjs";
import { parseLeadership, htmlText, bioFrom, educationFrom, careerFrom, startFrom, titleFromBio, looksLikeTitle, sentences } from "../colib.mjs";

const PATHS = ["/leadership", "/about/leadership", "/company/leadership", "/about-us/leadership", "/about/leadership-team", "/about/team", "/about/management", "/team", "/our-team", "/management", "/leadership-team", "/about/executive-team", "/about/meet-the-team/executive-team/", "/about-us", "/about", "/company", "/who-we-are"];
const NEWS = ["/news", "/press", "/newsroom", "/press-releases", "/company/news", "/about/news", "/company/newsroom", "/blog/news"];

const abs = (base, href) => {
  try {
    return new URL(href, base).href.replace(/#.*$/, "");
  } catch {
    return null;
  }
};

async function sitemapHints(http, root) {
  const out = new Set();
  const r = await http.get(root + "/sitemap.xml", { timeout: 8000 });
  if (!r.ok) return [];
  let locs = [...r.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
  const subs = locs.filter((l) => /sitemap.*\.xml/i.test(l) && /(page|post-type-page|pages|company|about)/i.test(l)).slice(0, 2);
  for (const s of subs) {
    const x = await http.get(s, { timeout: 8000 });
    if (x.ok) locs = locs.concat([...x.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]));
  }
  for (const l of locs) if (/(leadership|executive|management|our-team|meet-the-team|\/team\/?$|board-of-directors)/i.test(l) && !/\.xml$/i.test(l)) out.add(l);
  return [...out].slice(0, 6);
}

export default {
  id: "leadership",
  label: "Company site: leadership team, bio, headshot, press",
  lane: "fast",
  needs: ["domain"],
  budgetMs: 30000,
  async run(ctx) {
    const { http, add, miss, subject, shared } = ctx;
    const root = `https://${subject.domain.replace(/^www\./, "")}`;
    const hints = await sitemapHints(http, root);
    const urls = [...new Set([...hints, ...PATHS.map((p) => root + p)])];
    const pages = (
      await Promise.all(
        urls.map(async (u) => {
          const r = await http.get(u, { timeout: 10000 });
          if (!r.ok || !/<html|<body|<div/i.test(r.text)) return null;
          return { url: r.url || u, html: r.text, people: parseLeadership(r.text) };
        }),
      )
    ).filter(Boolean);
    // one entry per final URL (many paths redirect to the same page)
    const byUrl = new Map();
    for (const p of pages) if (!byUrl.has(p.url)) byUrl.set(p.url, p);
    const uniq = [...byUrl.values()];
    const best = uniq.filter((p) => p.people.length >= 2).sort((a, b) => b.people.length - a.people.length)[0];

    if (best) {
      const team = best.people.slice(0, 20);
      shared.leadership = team.map(({ name, title }) => ({ name, title }));
      for (const p of team.slice(0, 15)) add({ var: "co.leadership", value: `${p.name}, ${p.title}`, url: best.url, grade: "v", tier: "C", detail: { bio: p.bio?.slice(0, 500) || null, img: p.img } });
    } else miss("co.leadership", `no leadership/team page with names and titles on ${subject.domain} (tried ${urls.length} paths incl. sitemap hints)`);

    // ---- the subject: on a team page, or on their own bio page
    let me = null;
    for (const p of uniq) {
      const hit = p.people.find((x) => nameIn(x.name, subject.name));
      if (hit) {
        me = { ...hit, url: p.url };
        break;
      }
    }
    const slug = normName(subject.name).replace(/ /g, "-");
    let own = null;
    for (const p of uniq) {
      const m = [...p.html.matchAll(/href=["']([^"']+)["']/g)].map((x) => x[1]).find((h) => h.toLowerCase().includes(slug) && !/linkedin|twitter|facebook|mailto/i.test(h));
      if (m) {
        own = abs(p.url, m);
        break;
      }
    }
    if (own) {
      const r = await http.get(own, { timeout: 10000 });
      if (r.ok) {
        const text = htmlText(r.text);
        const mt = metaTags(r.text);
        const meta = htmlText(htmlText(mt["og:description"] || mt.description || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
        const first = subject.name.split(/\s+/)[0];
        const metaBio = meta.length > 200 && (meta.includes(first) || meta.includes(subject.name.split(/\s+/).at(-1))) ? meta : "";
        const fromBody = bioFrom(text, subject.name);
        const bio = metaBio && metaBio.length > fromBody.length * 0.6 ? metaBio : fromBody || metaBio;
        const img = [...r.text.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]).find((t) => normName(t).includes(normName(subject.name).split(" ").at(-1)));
        const src = img?.match(/(?:data-lazy-src|data-src|src)=["']([^"']+)/i)?.[1];
        me = { ...(me || {}), name: me?.name || subject.name, bio: bio.length > (me?.bio?.length || 0) ? bio : me?.bio, img: me?.img || (src && abs(own, src)) || metaTags(r.text)["og:image"], url: own, title: me?.title || text.match(new RegExp(`${subject.name}\\s+([A-Z][^.]{5,90}?)\\s+(?:As |${subject.name.split(" ")[0]} )`))?.[1] };
      }
    }
    if (!me) {
      for (const v of ["career.timeline", "pic.headshot"]) miss(v, `"${subject.name}" not on ${subject.domain} leadership/team pages${own ? "" : " and no bio page link"}`);
    } else {
      const title = me.title && looksLikeTitle(me.title) ? me.title : me.bio ? titleFromBio(me.bio) : null;
      if (title) {
        shared.roleTitle ??= title;
        add({ var: "role.title", value: title, url: me.url, grade: "v", tier: "C", anchors: ["company-site"] });
      }
      const bio = me.bio || "";
      if (bio) {
        add({ var: "career.timeline", value: bio.length > 600 ? bio.slice(0, 600) + "..." : bio, url: me.url, grade: "v", tier: "C", detail: { source: "company bio", full: bio } });
        for (const s of careerFrom(bio).slice(0, 5)) if (bio.length > 600 && !bio.slice(0, 600).includes(s.slice(0, 80))) add({ var: "career.timeline", value: s, url: me.url, grade: "v", tier: "C" });
        for (const s of educationFrom(bio)) add({ var: "career.education", value: s, url: me.url, grade: "v", tier: "C" });
        const st = startFrom(bio);
        if (st) add({ var: "role.start", value: `Since ${st} (company bio)`, url: me.url, grade: "v", tier: "C" });
        const mandate = sentences(bio).find((s) => /(responsible for|leads|oversees|in charge of|charged with|driving)/i.test(s));
        if (mandate) add({ var: "role.mandate", value: mandate, url: me.url, grade: "v", tier: "C" });
        const pats = bio.match(/(\d+)\+?\s+(?:U\.S\.\s+)?patents/i);
        if (pats) add({ var: "career.wins", value: `${pats[0]} (company bio)`, url: me.url, grade: "p", tier: "C" });
      }
      if (me.img) {
        shared.headshot ??= me.img;
        add({ var: "pic.headshot", value: me.img, url: me.url, grade: "v", tier: "C", image: me.img, anchors: ["company-site"] });
      }
      // reports-to: the top of the team page, when the subject is not the top
      const ceo = (shared.leadership || []).find((p) => /\b(chief executive|ceo|president)\b/i.test(p.title));
      if (ceo && !nameIn(ceo.name, subject.name) && /\b(vp|vice president|chief|cfo|cto|coo|cio|cmo|cro|evp|svp|general manager|head of)\b/i.test(title || "")) add({ var: "role.reports_to", value: `Likely ${ceo.name} (${ceo.title}): top of the leadership page`, url: best?.url || me.url, grade: "i", tier: "C" });
    }

    // ---- press and news titles that name the subject
    const last = subject.name.split(/\s+/).at(-1);
    const news = (await Promise.all(NEWS.map(async (p) => {
      const r = await http.get(root + p, { timeout: 8000 });
      return r.ok ? { url: r.url || root + p, html: r.text } : null;
    }))).filter(Boolean);
    const links = new Map();
    for (const n of news) {
      for (const m of n.html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{20,400}?)<\/a>/gi)) {
        const t = htmlText(m[2]);
        if (t.length < 25 || t.length > 220 || t.split(" ").length < 5) continue;
        const u = abs(n.url, m[1]);
        if (!u || !/(news|press|release|blog|story|stories|article|20\d\d)/i.test(new URL(u).pathname) || new URL(u).pathname.split("/").filter(Boolean).length < 2) continue;
        if (u && !links.has(u)) links.set(u, t);
      }
    }
    const mine = [...links].filter(([, t]) => t.includes(last));
    for (const [u, t] of mine.slice(0, 5)) add({ var: "news.company", value: t, url: u, grade: "v", tier: "C", anchors: ["names-subject"] });
    if (news.length && !mine.length) {
      const latest = [...links].slice(0, 5);
      for (const [u, t] of latest) add({ var: "news.company", value: t, url: u, grade: "p", tier: "C" });
    }
    if (!news.length) miss("news.company", `no /news or /press page on ${subject.domain}`);
  },
};
