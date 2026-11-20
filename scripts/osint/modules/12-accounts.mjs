// Username sweep: candidate handles (from --handles, from the name, from profile URLs the search
// module found) checked against ~35 sites that give a clear "this account exists" answer.
//
// A 200 status alone proves nothing on sites that serve a page for any username (TikTok,
// Pinterest, Twitch, Telegram, Steam): there an account counts only when the page carries real
// profile data, and it is confirmed as his only when the display name matches the person.
// Normal browser user agent only; sites that show nothing to it are recorded as misses.

import { metaTags } from "../core.mjs";
import { nameMatch, nameParts, nameVariants, derivedHandles, handleFromUrl, companyIn, placeIn, pool, stripTags, blockedMiss } from "../person-lib.mjs";

const AZ = /^[a-z0-9]+$/i;
const AZD = /^[a-z0-9-]+$/i;
const AZU = /^[a-z0-9_]+$/i;
const AZDU = /^[a-z0-9_-]+$/i;
const ANY = /^[a-z0-9._-]+$/i;

const og = (r) => metaTags(r.text || "");
const notFound = (r) => !r.ok || r.status === 404;

/** Each site: url(h), ok (allowed handle chars), check(res, h) -> profile | null. */
export const SITES = [
  { site: "github", ok: AZD, url: (h) => `https://api.github.com/users/${h}`, api: true,
    check: (r) => { const d = r.data; return d?.login ? { name: d.name, bio: d.bio, company: d.company, location: d.location, blog: d.blog, avatar: d.avatar_url, followers: d.followers, extra: { twitter: d.twitter_username, repos: d.public_repos, created: d.created_at }, url: d.html_url } : null; } },
  { site: "gitlab", ok: AZDU, url: (h) => `https://gitlab.com/api/v4/users?username=${h}`, api: true,
    check: (r) => { const d = r.data?.[0]; return d ? { name: d.name, avatar: d.avatar_url, url: d.web_url } : null; } },
  { site: "keybase", ok: AZU, url: (h) => `https://keybase.io/_/api/1.0/user/lookup.json?usernames=${h}&fields=basics,profile`, api: true,
    check: (r, h) => { const d = r.data?.them?.[0]; return d ? { name: d.profile?.full_name, bio: d.profile?.bio, location: d.profile?.location, url: `https://keybase.io/${h}` } : null; } },
  { site: "hackernews", ok: AZDU, url: (h) => `https://hacker-news.firebaseio.com/v0/user/${h}.json`, api: true,
    check: (r, h) => { const d = r.data; return d?.id ? { bio: stripTags(d.about || ""), followers: d.karma, extra: { karma: d.karma, created: d.created }, url: `https://news.ycombinator.com/user?id=${h}` } : null; } },
  { site: "devto", ok: AZU, url: (h) => `https://dev.to/api/users/by_username?url=${h}`, api: true,
    check: (r, h) => { const d = r.data; return d?.username ? { name: d.name, bio: d.summary, location: d.location, avatar: d.profile_image, blog: d.website_url, url: `https://dev.to/${h}` } : null; } },
  { site: "mastodon", ok: AZU, url: (h) => `https://mastodon.social/api/v1/accounts/lookup?acct=${h}`, api: true,
    check: (r) => { const d = r.data; return d?.id ? { name: d.display_name, bio: stripTags(d.note || ""), avatar: d.avatar, followers: d.followers_count, extra: { id: d.id, posts: d.statuses_count, last: d.last_status_at }, url: d.url } : null; } },
  { site: "bluesky", ok: AZD, url: (h) => `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${h}.bsky.social`, api: true,
    check: (r) => { const d = r.data; return d?.did ? { name: d.displayName, bio: d.description, avatar: d.avatar, followers: d.followersCount, extra: { did: d.did, posts: d.postsCount, handle: d.handle }, url: `https://bsky.app/profile/${d.handle}` } : null; } },
  { site: "chess.com", ok: AZDU, url: (h) => `https://api.chess.com/pub/player/${h}`, api: true,
    check: (r) => { const d = r.data; return d?.username ? { name: d.name, location: d.location, avatar: d.avatar, url: d.url, extra: { joined: d.joined, last_online: d.last_online } } : null; } },
  { site: "lichess", ok: AZDU, url: (h) => `https://lichess.org/api/user/${h}`, api: true,
    check: (r, h) => { const d = r.data; if (!d?.id || d.disabled) return null; const p = d.profile || {}; return { name: p.realName || [p.firstName, p.lastName].filter(Boolean).join(" ") || null, bio: p.bio, location: p.location, url: `https://lichess.org/@/${h}` }; } },
  { site: "dockerhub", ok: AZ, url: (h) => `https://hub.docker.com/v2/users/${h}/`, api: true,
    check: (r, h) => { const d = r.data; return d?.username ? { name: d.full_name, location: d.location, company: d.company, url: `https://hub.docker.com/u/${h}` } : null; } },
  { site: "gravatar", ok: ANY, url: (h) => `https://en.gravatar.com/${h}.json`, api: true,
    check: (r) => { const d = r.data?.entry?.[0]; return d ? { name: d.name?.formatted || d.displayName, bio: d.aboutMe, location: d.currentLocation, avatar: d.thumbnailUrl, url: d.profileUrl, extra: { urls: (d.urls || []).map((u) => u.value), accounts: (d.accounts || []).map((a) => a.url) } } : null; } },
  { site: "npm", ok: AZDU, url: (h) => `https://registry.npmjs.org/-/v1/search?text=maintainer:${h}&size=5`, api: true,
    check: (r, h) => { const o = r.data?.objects || []; return o.length ? { bio: `maintains ${r.data.total} npm package(s): ${o.map((x) => x.package.name).join(", ")}`, url: `https://www.npmjs.com/~${h}` } : null; } },
  { site: "youtube", ok: /^[a-z0-9._-]{3,30}$/i, url: (h) => `https://www.youtube.com/@${h}`,
    check: (r) => { if (notFound(r)) return null; const m = og(r); return m["og:title"] ? { name: m["og:title"], bio: m["og:description"], avatar: m["og:image"] } : null; } },
  { site: "x", ok: /^[a-z0-9_]{1,15}$/i, url: (h) => `https://x.com/${h}`,
    check: (r) => { if (notFound(r)) return null; const m = og(r); const t = m["og:title"] || ""; if (!/\(@/.test(t)) return null; return { name: t.replace(/\s*\(@.*$/, ""), bio: m["og:description"], avatar: m["og:image"] }; } },
  { site: "linkedin", ok: /^[a-z0-9-]{3,100}$/i, url: (h) => `https://www.linkedin.com/in/${h}`,
    check: (r) => { if (r.status !== 200) return null; const m = og(r); const t = m["og:title"] || ""; if (!t) return null; const [name, ...rest] = t.replace(/\s*\|\s*LinkedIn.*$/, "").split(" - "); return { name, bio: m["og:description"], company: rest.join(" - ") || null, avatar: m["og:image"] }; } },
  { site: "tiktok", ok: /^[a-z0-9._]{2,24}$/i, url: (h) => `https://www.tiktok.com/@${h}`, mustName: true,
    check: (r) => { const m = (r.text || "").match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/); if (!m) return null; try { const d = JSON.parse(m[1]).__DEFAULT_SCOPE__["webapp.user-detail"]; if (d?.statusCode !== 0) return null; const u = d.userInfo.user, s = d.userInfo.stats; return { name: u.nickname, bio: u.signature, avatar: u.avatarLarger, followers: s?.followerCount, extra: { videos: s?.videoCount, hearts: s?.heartCount, region: u.region, private: u.privateAccount } }; } catch { return null; } } },
  { site: "pinterest", ok: AZU, url: (h) => `https://www.pinterest.com/${h}/`,
    check: (r, h) => { const m = og(r); const d = m["og:description"] || m.description || ""; const x = d.match(new RegExp(`See what (.+?) \\(${h}\\) has discovered`, "i")); return x ? { name: x[1] } : null; } },
  { site: "myspace", ok: ANY, url: (h) => `https://myspace.com/${h}`,
    check: (r, h) => { if (notFound(r)) return null; const m = og(r); const d = m["og:description"] || ""; const x = d.match(new RegExp(`^(.+?) \\(${h}\\)'s profile`, "i")); return x ? { name: x[1], bio: d } : null; } },
  { site: "about.me", ok: ANY, url: (h) => `https://about.me/${h}`,
    check: (r) => { if (notFound(r)) return null; const m = og(r); const t = m["og:title"] || ""; return /on about\.me/.test(t) ? { name: t.replace(/ on about\.me.*/, ""), bio: m["og:description"], avatar: m["og:image"] } : null; } },
  { site: "medium", ok: ANY, url: (h) => `https://medium.com/feed/@${h}`,
    check: (r) => { if (notFound(r) || !/<rss/.test(r.text || "")) return null; const t = (r.text.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || [])[1] || ""; const posts = [...r.text.matchAll(/<item>[\s\S]*?<title><!\[CDATA\[(.*?)\]\]><\/title>/g)].map((x) => x[1]); return { name: t.replace(/^Stories by /, "").replace(/ on Medium$/, ""), bio: posts.slice(0, 3).join(" · "), extra: { posts } }; } },
  { site: "substack", ok: AZ, url: (h) => `https://${h}.substack.com/`,
    check: (r) => { if (notFound(r)) return null; const m = og(r); const author = (r.text.match(/"author":\{"@type":"Person","name":"([^"]+)"/) || r.text.match(/"author_name":"([^"]+)"/) || [])[1]; return m["og:title"] ? { name: author || m["og:title"].replace(/ \| Substack$/, ""), bio: m["og:description"] } : null; } },
  { site: "linktree", ok: ANY, url: (h) => `https://linktr.ee/${h}`,
    check: (r) => { if (notFound(r)) return null; const m = og(r); return m["og:title"] ? { name: m["og:title"].replace(/ \|.*$/, "").replace(/ Songs, .*$/, ""), bio: m["og:description"], avatar: m["og:image"] } : null; } },
  { site: "calendly", ok: AZDU, url: (h) => `https://calendly.com/${h}`,
    check: (r) => { if (notFound(r)) return null; const m = og(r); return m["og:title"] && !/404/.test(m["og:title"]) ? { name: m["og:title"], bio: m["og:description"] } : null; } },
  { site: "dribbble", ok: AZDU, url: (h) => `https://dribbble.com/${h}`,
    check: (r) => { if (notFound(r)) return null; const m = og(r); return m["og:title"] ? { name: m["og:title"], bio: m["og:description"], avatar: m["og:image"] } : null; } },
  { site: "kaggle", ok: AZDU, url: (h) => `https://www.kaggle.com/${h}`,
    check: (r) => { if (notFound(r)) return null; const m = og(r); return m["og:title"] ? { name: m["og:title"], bio: m["og:description"] } : null; } },
  { site: "soundcloud", ok: AZDU, url: (h) => `https://soundcloud.com/${h}`,
    check: (r) => { if (notFound(r)) return null; const m = og(r); return m["og:title"] ? { name: m["og:title"], bio: m["og:description"], avatar: m["og:image"] } : null; } },
  { site: "flickr", ok: ANY, url: (h) => `https://www.flickr.com/people/${h}/`,
    check: (r) => { if (notFound(r)) return null; const m = og(r); return m["og:title"] && m["og:title"] !== "Flickr" ? { name: m["og:title"], bio: m["og:description"] } : null; } },
  { site: "vimeo", ok: AZDU, url: (h) => `https://vimeo.com/${h}`,
    check: (r) => { if (notFound(r)) return null; const m = og(r); const t = m["og:title"] && m["og:title"] !== "Vimeo" ? m["og:title"] : (m.title || "").replace(/ on Vimeo$/, ""); return t && t !== "Vimeo" ? { name: t, bio: m["og:description"] } : null; } },
  { site: "untappd", ok: AZDU, url: (h) => `https://untappd.com/user/${h}`,
    check: (r) => { if (notFound(r)) return null; const m = og(r); return m["og:title"] ? { name: m["og:title"], bio: m["og:description"] } : null; } },
  { site: "patreon", ok: AZDU, url: (h) => `https://www.patreon.com/${h}`,
    check: (r) => { if (notFound(r)) return null; const m = og(r); return m["og:title"] && !/Not found/.test(m["og:title"]) ? { name: m["og:title"].replace(/ \| .*$/, ""), bio: m["og:description"] } : null; } },
  { site: "wordpress", ok: AZ, url: (h) => `https://${h}.wordpress.com/`,
    check: (r, h) => { if (notFound(r) || !String(r.url).includes(`${h}.wordpress.com`)) return null; const m = og(r); return { name: m["og:title"] || m.title, bio: m["og:description"] }; } },
  { site: "telegram", ok: /^[a-z0-9_]{5,32}$/i, url: (h) => `https://t.me/${h}`, mustName: true,
    check: (r) => { const m = og(r); const t = m["og:title"] || ""; return t && !/^Telegram: Contact @/.test(t) ? { name: t, bio: m["og:description"], avatar: m["og:image"] } : null; } },
  { site: "twitch", ok: /^[a-z0-9_]{4,25}$/i, url: (h) => `https://www.twitch.tv/${h}`, mustName: true,
    check: (r) => { const m = og(r); const t = m["og:title"] || ""; return t && t !== "Twitch" ? { name: t.replace(/ - Twitch$/, ""), bio: m["og:description"] } : null; } },
  { site: "steam", ok: AZDU, url: (h) => `https://steamcommunity.com/id/${h}`, mustName: true,
    check: (r) => { const m = og(r); const t = m["og:title"] || ""; return t && !/:: Error/.test(t) ? { name: t.replace(/^Steam Community :: /, "") } : null; } },
];

/** Sites that serve the same shell to a browser for every username, or block scripts. Probed once. */
export const NO_SIGNAL = [
  { site: "instagram", url: (h) => `https://www.instagram.com/${h}/`, why: "serves a login shell with no profile data to a browser user agent (crawler UAs not used); covered by site:instagram.com search" },
  { site: "threads", url: (h) => `https://www.threads.com/@${h}`, why: "serves the same shell for every handle to a browser user agent; covered by search" },
  { site: "facebook", url: (h) => `https://www.facebook.com/${h}`, why: "returns HTTP 400 to scripts; covered by site:facebook.com search" },
  { site: "reddit", url: (h) => `https://www.reddit.com/user/${h}/about.json`, why: "about.json returns 403 to scripts" },
  { site: "strava", url: null, why: "profiles are numeric ids, not handles; covered by site:strava.com search" },
  { site: "letterboxd, beacons, ko-fi, codepen, tumblr, last.fm, pypi", url: null, why: "behind a Cloudflare or JS challenge for scripts (measured 19 Nov 2026)" },
];

/** Handles to try, most likely first: explicit, from search profile URLs, then derived from the name. */
export function candidateHandles(subject, shared = {}) {
  const explicit = (subject.handles || []).map((h) => h.replace(/^@/, ""));
  const fromSearch = [];
  for (const p of shared.searchProfiles || []) {
    const h = p.handle || handleFromUrl(p.url);
    if (h && !/^\d+$/.test(h)) fromSearch.push(h);
  }
  const all = [...explicit, ...fromSearch.slice(0, 4), ...derivedHandles(subject)];
  const seen = new Set();
  const out = [];
  for (const h of all) {
    const k = h.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ handle: h, source: explicit.includes(h) ? "given" : fromSearch.includes(h) ? "search" : "derived" });
  }
  return out.slice(0, 11);
}

export default {
  id: "accounts",
  /** The ledger variables this module fills (config/form buckets read them to say "no tool yet"). */
  vars: ["social.accounts"],
  label: "Username sweep across ~35 sites",
  lane: "sweep",
  needs: ["name"],
  env: ["GITHUB_TOKEN"],
  budgetMs: 32000,
  async run(ctx) {
    const { subject, http, shared, env } = ctx;
    const handles = candidateHandles(subject, shared);
    const jobs = [];
    for (const s of SITES) for (const h of handles) if (s.ok.test(h.handle)) jobs.push({ s, h });
    const ghHeaders = env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {};
    const deadline = Date.now() + 26000;
    const blocked = {};

    const results = await pool(jobs, 24, async ({ s, h }) => {
      if (Date.now() > deadline) return null;
      const url = s.url(h.handle);
      const opts = { timeout: 9000, headers: s.site === "github" ? ghHeaders : {}, cache: !!s.api };
      const r = s.api ? await http.json(url, opts) : await http.get(url, opts);
      if ([403, 429, 999].includes(r.status) || r.status === 0) {
        blocked[s.site] = r.status || r.error;
        return null;
      }
      const p = s.check(r, h.handle);
      if (!p) return null;
      return { site: s.site, handle: h.handle, source: h.source, url: p.url || url, mustName: !!s.mustName, ...p };
    });

    // Name search APIs: accounts whose handle is nothing like the name.
    const extra = [];
    const bs = await http.json(`https://public.api.bsky.app/xrpc/app.bsky.actor.searchActors?q=${encodeURIComponent(subject.name)}&limit=10`, { timeout: 8000 });
    for (const a of bs.data?.actors || []) if (nameMatch(a.displayName, subject)) extra.push({ site: "bluesky", handle: a.handle, source: "name-search", url: `https://bsky.app/profile/${a.handle}`, name: a.displayName, bio: a.description, avatar: a.avatar, extra: { did: a.did } });
    const gs = await http.json(`https://api.github.com/search/users?q=${encodeURIComponent(`fullname:"${subject.name}"`)}&per_page=5`, { timeout: 8000, headers: ghHeaders });
    const ghLogins = (gs.data?.items || []).map((i) => i.login).filter((l) => !results.some((x) => x?.site === "github" && x.handle.toLowerCase() === l.toLowerCase()));
    for (const l of ghLogins.slice(0, 3)) {
      const r = await http.json(`https://api.github.com/users/${l}`, { timeout: 8000, headers: ghHeaders });
      const p = SITES[0].check(r);
      if (p) extra.push({ site: "github", handle: l, source: "name-search", ...p });
    }

    // The no-signal sites get one honest probe each: a hit only if the page names him.
    const probes = [];
    for (const n of NO_SIGNAL.filter((n) => n.url)) {
      for (const h of handles.slice(0, 2)) {
        const r = await http.get(n.url(h.handle), { timeout: 8000, cache: false });
        const m = metaTags(r.text || "");
        const t = `${m["og:title"] || ""} ${m["og:description"] || ""}`;
        if (r.status === 200 && nameMatch(t, subject)) probes.push({ site: n.site, handle: h.handle, source: h.source, url: n.url(h.handle), name: m["og:title"], bio: m["og:description"], avatar: m["og:image"], mustName: true });
        else n.probed = `${n.url(h.handle)} → ${r.status || r.error}${m["og:title"] ? `, title "${m["og:title"].slice(0, 40)}"` : ""}`;
      }
    }
    const found = [...results.filter(Boolean), ...extra, ...probes];
    const last = nameParts(subject.name).last.replace(/ /g, "");
    const firsts = [...new Set(nameVariants(subject).map((n) => nameParts(n).first))].filter((f) => f.length > 2);
    const accounts = (shared.accounts ||= []);
    for (const a of found) {
      const text = [a.name, a.bio, a.company, a.location].filter(Boolean).join(" · ");
      a.nameMatch = nameMatch(a.name || "", subject) || (!a.mustName && nameMatch(a.bio || "", subject));
      a.anchors = [];
      if (a.nameMatch) a.anchors.push("name");
      if (companyIn(text, subject)) a.anchors.push("company");
      if (placeIn(a.location || a.bio || "", subject, shared)) a.anchors.push("place");
      a.confirmed = a.nameMatch || a.source === "given";
      // An unmatched account under a short handle without the surname (gabrielb) is noise.
      // Unmatched accounts are kept only under handles that spell out first and last name
      // (gabrielvenhaus, gabe.venhaus); short forms like gabrielb or dwhitlock are mostly namesakes.
      if (!a.confirmed && a.source === "derived" && !(a.handle.toLowerCase().includes(last) && firsts.some((f) => a.handle.toLowerCase().includes(f)))) continue;
      accounts.push(a);
    }
    // No ledger rows here: a display name that matches is not proof. The identity module (late
    // lane) scores every account and writes the verified and likely ones to social.accounts.
    const conf = accounts.filter((a) => a.confirmed);
    if (!conf.length) ctx.miss("social.accounts", `username sweep: ${handles.length} handles (${handles.map((h) => h.handle).join(", ")}) × ${SITES.length} sites, no account whose display name matches ${subject.name}`);
    for (const [site, st] of Object.entries(blocked)) if (!found.some((f) => f.site === site)) blockedMiss(ctx, "social.accounts", `${site} (username sweep)`, { status: typeof st === "number" ? st : 0, error: typeof st === "string" ? st : null }, site === "github" ? "set GITHUB_TOKEN (free) or retry later" : "the site refuses scripts; check by hand", { partial: true });
    for (const n of NO_SIGNAL) if (!probes.some((p) => p.site === n.site)) ctx.miss("social.accounts", `${n.site}: not checkable by handle (not checked) — ${n.why}${n.probed ? ` (probe: ${n.probed})` : ""}`);
    shared.sweep = { handles, checked: jobs.length };
    // Headshot for the reverse-image module (slow lane): an avatar from an account tied to the company.
    if (!shared.headshot) {
      const a = conf.find((x) => x.avatar && x.anchors.includes("company"));
      if (a) {
        shared.headshot = a.avatar;
        shared.headshotFrom = `${a.site} @${a.handle}`;
      }
    }
    ctx.log(`${jobs.length} checks over ${handles.length} handles; ${found.length} exist, ${conf.length} name-matched`);
  },
};
