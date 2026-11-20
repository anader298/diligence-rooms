// Read the public profiles that pass the identity score (verified or likely: an anchor beyond the
// name, such as the employer or a known city). Accounts that only share the name are not read,
// so a namesake's chess.com town never becomes the subject's home metro. GitHub repos and
// languages, Bluesky and Mastodon recent posts, Medium and Substack titles, LinkedIn's public
// summary line, TikTok and other bios. Maps them to place, voice, code, hobbies, themes and the
// most active platform. Everything here is only as good as the account match; the identity
// module (late lane) scores each account, and rows carry the account in `detail` for that.

import { companyIn, hobbiesIn, topTerms, pool, stripTags, decodeEntities } from "../person-lib.mjs";
import { scoreAll } from "./30-identity.mjs";

/** Decode until stable: LinkedIn double-encodes ("G&amp;amp;A"). */
const decodeAll = (s) => {
  let x = String(s || "");
  for (let i = 0; i < 4; i++) {
    const y = decodeEntities(x);
    if (y === x) break;
    x = y;
  }
  return x;
};

const day = (s) => (s ? String(s).slice(0, 10) : null);

/** LinkedIn's public og:description: "... · Experience: X · Education: Y · Location: Z · 500+ connections". */
export function parseLinkedInDesc(desc) {
  const d = decodeAll(desc);
  const get = (k) => (d.match(new RegExp(`${k}:\\s*([^·]+?)\\s*(?:·|$)`)) || [])[1]?.trim() || null;
  return { experience: get("Experience"), education: get("Education"), location: get("Location"), connections: (d.match(/(\d[\d,+]*) connections/) || [])[1] || null };
}

export default {
  id: "profiles",
  /** The ledger variables this module fills (config/form buckets read them to say "no tool yet"). */
  vars: ["social.themes", "place.home_metro", "social.linkpage", "career.code", "voice.writing", "career.education", "career.timeline", "social.top_posts", "social.work_posts", "social.most_active", "hobby.sports", "hobby.cooking", "hobby.endurance", "hobby.media", "hobby.teams"],
  label: "Read confirmed public profiles (bio, posts, code, places, hobbies)",
  lane: "slow",
  needs: ["name"],
  env: ["GITHUB_TOKEN"],
  budgetMs: 25000,
  async run(ctx) {
    const { subject, http, shared, env } = ctx;
    // Identity first: only accounts with an anchor beyond the name are read.
    const scored = scoreAll(subject, shared);
    const ok = new Map(scored.filter((c) => c.verdict === "verified" || c.verdict === "likely").map((c) => [`${c.site}|${String(c.handle || c.url).toLowerCase()}`, c]));
    const verdictOf = (a) => ok.get(`${a.site}|${String(a.handle || a.url).toLowerCase()}`);
    const accts = (shared.accounts || []).filter((a) => verdictOf(a)).map((a) => ({ ...a, bio: a.bio ? decodeAll(a.bio) : a.bio, identity: verdictOf(a).verdict, anchors: [...new Set([...(a.anchors || []), ...verdictOf(a).families])] }));
    // LinkedIn profiles seen only in search results: their snippet carries Experience/Education/Location.
    for (const c of ok.values()) {
      if (c.site !== "linkedin" || accts.some((a) => a.site === "linkedin" && String(a.handle).toLowerCase() === String(c.handle).toLowerCase())) continue;
      if (c.snippet) accts.push({ site: "linkedin", handle: c.handle, url: c.url, bio: decodeAll(c.snippet), identity: c.verdict, anchors: c.families, fromSearch: true });
    }
    const skipped = scored.filter((c) => !ok.has(`${c.site}|${String(c.handle || c.url).toLowerCase()}`) && c.families.includes("name")).length;
    if (!accts.length) {
      ctx.miss("social.themes", `no account passed the identity check (${skipped} account(s) share the name but nothing ties them to ${subject.company || "the subject"}); none read`);
      return;
    }
    const gh = env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {};
    const texts = [];
    const activity = [];
    const places = new Set();
    const anchorsOf = (a) => a.anchors || [];
    // verified or likely accounts only reach this point, so their facts are partly verified.
    const gradeOf = () => "p";

    await pool(accts, 6, async (a) => {
      const base = { url: a.url, tier: "C", anchors: anchorsOf(a), detail: { site: a.site, handle: a.handle, identity: a.identity } };
      if (a.bio) texts.push({ a, text: a.bio, kind: "bio" });
      if (a.location) {
        ctx.add({ ...base, var: "place.home_metro", value: `${a.location} (${a.site} profile location)`, grade: gradeOf(a) });
        places.add(JSON.stringify({ place: a.location, from: a.url }));
      }
      if (a.blog) ctx.add({ ...base, var: "social.linkpage", value: a.blog, url: /^https?:/.test(a.blog) ? a.blog : "https://" + a.blog, grade: gradeOf(a) });
      for (const u of a.extra?.urls || []) ctx.add({ ...base, var: "social.linkpage", value: u, url: u, grade: gradeOf(a) });

      if (a.site === "github") {
        const r = await http.json(`https://api.github.com/users/${a.handle}/repos?per_page=100&sort=pushed`, { headers: gh, timeout: 9000 });
        const repos = (r.data || []).filter((x) => !x.fork);
        const langs = {};
        for (const x of repos) if (x.language) langs[x.language] = (langs[x.language] || 0) + 1;
        const top = Object.entries(langs).sort((p, q) => q[1] - p[1]).slice(0, 5);
        const starred = [...repos].sort((p, q) => q.stargazers_count - p.stargazers_count).slice(0, 3);
        ctx.add({ ...base, var: "career.code", value: `GitHub @${a.handle}: ${a.extra?.repos ?? repos.length} public repos${top.length ? `; languages ${top.map(([l, n]) => `${l} (${n})`).join(", ")}` : ""}${starred[0] ? `; most starred ${starred.map((x) => `${x.name} ★${x.stargazers_count}`).join(", ")}` : ""}${repos[0] ? `; last push ${day(repos[0].pushed_at)}` : ""}`, grade: gradeOf(a), tier: "A", detail: { ...base.detail, languages: langs, repos: repos.slice(0, 10).map((x) => ({ name: x.name, desc: x.description, stars: x.stargazers_count, pushed: x.pushed_at })) } });
        for (const x of repos.slice(0, 30)) if (x.description) texts.push({ a, text: x.description, kind: "repo" });
        if (a.company) texts.push({ a, text: a.company, kind: "company" });
        activity.push({ a, n: repos.length, what: "repos", last: repos[0]?.pushed_at });
      } else if (a.site === "bluesky") {
        const r = await http.json(`https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(a.extra?.did || a.extra?.handle || a.handle + ".bsky.social")}&limit=50&filter=posts_no_replies`, { timeout: 9000 });
        const posts = (r.data?.feed || []).map((f) => f.post).filter((p) => p?.record?.text);
        for (const p of posts) texts.push({ a, text: p.record.text, kind: "post", date: p.record.createdAt, likes: p.likeCount || 0, url: `https://bsky.app/profile/${p.author.handle}/post/${p.uri.split("/").pop()}` });
        activity.push({ a, n: a.extra?.posts ?? posts.length, what: "posts", last: posts[0]?.record?.createdAt });
      } else if (a.site === "mastodon" && a.extra?.id) {
        const r = await http.json(`https://mastodon.social/api/v1/accounts/${a.extra.id}/statuses?limit=40&exclude_replies=true`, { timeout: 9000 });
        for (const p of r.data || []) texts.push({ a, text: stripTags(p.content), kind: "post", date: p.created_at, likes: p.favourites_count || 0, url: p.url });
        activity.push({ a, n: a.extra?.posts ?? 0, what: "posts", last: a.extra?.last });
      } else if (a.site === "medium" && a.extra?.posts?.length) {
        ctx.add({ ...base, var: "voice.writing", value: `Medium @${a.handle}: ${a.extra.posts.slice(0, 5).join(" · ")}`, grade: gradeOf(a), detail: { ...base.detail, posts: a.extra.posts } });
        activity.push({ a, n: a.extra.posts.length, what: "posts" });
      } else if (a.site === "substack") {
        const r = await http.get(`https://${a.handle}.substack.com/feed`, { timeout: 9000 });
        const titles = [...(r.text || "").matchAll(/<item>[\s\S]*?<title><!\[CDATA\[(.*?)\]\]><\/title>[\s\S]*?<pubDate>(.*?)<\/pubDate>/g)].map((m) => ({ title: m[1], date: m[2] }));
        if (titles.length) ctx.add({ ...base, var: "voice.writing", value: `Substack ${a.handle}: ${titles.slice(0, 5).map((t) => t.title).join(" · ")}`, grade: gradeOf(a), date: day(new Date(titles[0].date).toISOString()), detail: { ...base.detail, posts: titles } });
        activity.push({ a, n: titles.length, what: "posts" });
      } else if (a.site === "linkedin") {
        const li = parseLinkedInDesc(a.bio);
        if (li.location) {
          ctx.add({ ...base, var: "place.home_metro", value: `${li.location} (LinkedIn public profile)`, grade: gradeOf(a) });
          places.add(JSON.stringify({ place: li.location, from: a.url }));
        }
        if (li.education) ctx.add({ ...base, var: "career.education", value: `${li.education} (LinkedIn public profile)`, grade: gradeOf(a) });
        if (li.experience) ctx.add({ ...base, var: "career.timeline", value: `Current per LinkedIn: ${li.experience}`, grade: gradeOf(a) });
        const capped = /\+/.test(li.connections || "");
        activity.push({ a, n: Number(String(li.connections || "0").replace(/\D/g, "")) || 0, what: capped ? "+ connections (LinkedIn shows 500+ at most)" : "connections" });
      } else if (a.followers != null) {
        activity.push({ a, n: a.followers, what: "followers" });
      }
    });

    // Hobbies from bios and posts (one row per hobby, with the words that triggered it).
    const hob = new Map();
    for (const t of texts) {
      for (const h of hobbiesIn(t.text)) {
        const k = h.var + "|" + h.label;
        if (!hob.has(k)) hob.set(k, { ...h, hits: [], a: t.a });
        hob.get(k).hits.push({ word: h.word, kind: t.kind, site: t.a.site, url: t.url || t.a.url });
      }
    }
    for (const h of hob.values()) {
      ctx.add({ var: h.var, value: `${h.label}: "${h.hits[0].word}" in the ${h.hits[0].kind} on ${h.hits[0].site}${h.hits.length > 1 ? ` (+${h.hits.length - 1} more)` : ""}`, url: h.hits[0].url, grade: h.hits.length > 2 ? "p" : "w", tier: "C", anchors: h.a.anchors || [], detail: { hits: h.hits.slice(0, 8) } });
    }

    // Themes and top posts from post text (12 months).
    const yearAgo = Date.now() - 365 * 864e5;
    const posts = texts.filter((t) => t.kind === "post" && (!t.date || Date.parse(t.date) > yearAgo));
    if (posts.length) {
      const terms = topTerms(posts.map((p) => p.text));
      if (terms.length) ctx.add({ var: "social.themes", value: terms.map(([w, n]) => `${w} (${n})`).join(", "), grade: "w", tier: "C", detail: { posts: posts.length, sites: [...new Set(posts.map((p) => p.a.site))] } });
      const top = [...posts].sort((p, q) => q.likes - p.likes).slice(0, 3);
      for (const p of top) if (p.likes > 0) ctx.add({ var: "social.top_posts", value: `${p.likes} likes: "${p.text.slice(0, 160)}"`, url: p.url, date: day(p.date), grade: "w", tier: "C", anchors: p.a.anchors || [] });
      for (const p of posts.filter((p) => companyIn(p.text, subject)).slice(0, 3)) ctx.add({ var: "social.work_posts", value: p.text.slice(0, 200), url: p.url, date: day(p.date), grade: "p", tier: "C", anchors: ["company", ...(p.a.anchors || [])] });
    } else ctx.miss("social.themes", `no public posts in the last 12 months on ${[...new Set(accts.map((a) => a.site))].join(", ")}`);

    if (activity.some((x) => x.n > 0)) {
      const best = [...activity].sort((p, q) => (q.n || 0) - (p.n || 0))[0];
      ctx.add({ var: "social.most_active", value: `${best.a.site} @${best.a.handle} (${best.n} ${best.what}${best.last ? `, last ${day(best.last)}` : ""})`, url: best.a.url, grade: "w", tier: "C", anchors: best.a.anchors || [], detail: activity.map((x) => ({ site: x.a.site, handle: x.a.handle, n: x.n, what: x.what, last: x.last || null })) });
    }

    // Headshot for the reverse-image module: an avatar from an account tied to the company.
    if (!shared.headshot) {
      const a = accts.find((x) => x.avatar && (x.anchors || []).includes("company")) || accts.find((x) => x.avatar && x.site === "linkedin");
      if (a) {
        shared.headshot = a.avatar;
        shared.headshotFrom = `${a.site} @${a.handle}`;
      }
    }
    shared.places = [...(shared.places || []), ...[...places].map((x) => JSON.parse(x))];
  },
};
