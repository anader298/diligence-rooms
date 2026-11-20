// linkpages (slow lane, after the sweep): the person's own list of links. Linktree pages
// (the __NEXT_DATA__ JSON: page title, bio, social icons and links) for given handles and the
// handles of confirmed accounts, and rel="me" links on a personal site named by a confirmed
// account (GitHub blog field, profile website). The company domain is skipped: it is not his.
// A page counts when its title names him or the handle was given; its social links then join
// the candidate list (and shared.officialLinks when the handle was given).

import { nameMatch, handleFromUrl, platformOf, hostOf, isBlocked, blockedMiss } from "../person-lib.mjs";
import { metaTags as meta } from "../core.mjs";
import { makeAccount, pushAccount } from "./40-actor-search.mjs";

/** Read a Linktree page: { title, bio, avatar, social: [url], links: [{ title, url }] } or null. */
export function parseLinktree(html) {
  const m = String(html || "").match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  let pp;
  try {
    pp = JSON.parse(m[1]).props?.pageProps;
  } catch {
    return null;
  }
  if (!pp?.account && !pp?.username) return null;
  const a = pp.account || {};
  return {
    username: pp.username || a.username,
    title: pp.pageTitle || a.pageTitle || null,
    bio: pp.description || a.description || null,
    avatar: pp.customAvatar || a.profilePictureUrl || null,
    social: (pp.socialLinks || a.socialLinks || []).map((s) => s.url).filter(Boolean),
    links: (pp.links || a.links || []).filter((l) => l.url).map((l) => ({ title: l.title || null, url: l.url })).slice(0, 30),
  };
}

/** rel="me" links on a page (a and link tags). */
export function relMeLinks(html) {
  const out = new Set();
  for (const m of String(html || "").matchAll(/<(?:a|link)\s[^>]*>/gi)) {
    const tag = m[0];
    if (!/\brel=["'][^"']*\bme\b[^"']*["']/i.test(tag)) continue;
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (href && /^https?:\/\//i.test(href)) out.add(href);
  }
  return [...out];
}

export default {
  id: "linkpages",
  /** The ledger variables this module fills (config/form buckets read them to say "no tool yet"). */
  vars: ["social.linkpage"],
  label: "Link-in-bio pages and personal-site rel=me links",
  lane: "slow",
  needs: ["name"],
  budgetMs: 12000,
  async run(ctx) {
    const { subject, http, shared } = ctx;
    const accts = shared.accounts || [];
    const ok = (a) => a.confirmed || a.source === "given";
    const given = (subject.handles || []).map((h) => h.replace(/^@/, ""));
    const handles = [...new Set([...given, ...accts.filter((a) => a.site === "linktree" && ok(a)).map((a) => a.handle), ...accts.filter(ok).map((a) => a.handle)].filter((h) => h && /^[a-z0-9._-]{2,40}$/i.test(h)).map((h) => h.toLowerCase()))].slice(0, 4);
    const company = String(subject.domain || "").toLowerCase().replace(/^www\./, "");
    const sites = [...new Set(accts.filter(ok).flatMap((a) => [a.blog, a.extra?.blog, a.extra?.website]).filter((u) => u && /^https?:\/\/|^[a-z0-9-]+\.[a-z]/i.test(u)).map((u) => (/^https?:/i.test(u) ? u : `https://${u}`)))].filter((u) => {
      const h = hostOf(u);
      return h && !(company && (h === company || h.endsWith("." + company))) && !platformOf(u);
    }).slice(0, 3);
    if (!handles.length && !sites.length) return ctx.miss("social.linkpage", "no given or confirmed handle and no personal site to read");
    const [lt, ps] = await Promise.all([
      Promise.all(handles.map(async (h) => ({ h, r: await http.get(`https://linktr.ee/${h}`, { timeout: 6000 }) }))),
      Promise.all(sites.map(async (u) => ({ u, r: await http.get(u, { timeout: 6000 }) }))),
    ]);
    let n = 0;
    for (const { h, r } of lt) {
      if (isBlocked(r) && r.status !== 404) {
        blockedMiss(ctx, "social.linkpage", `Linktree @${h}`, r, "retry later", { partial: true });
        continue;
      }
      const p = r.ok ? parseLinktree(r.text) : null;
      if (!p) continue;
      const isGiven = given.some((g) => g.toLowerCase() === h);
      const named = nameMatch(`${p.title || ""}`, subject) || nameMatch(p.bio || "", subject);
      if (!isGiven && !named) continue;
      n++;
      const url = `https://linktr.ee/${p.username || h}`;
      pushAccount(shared, makeAccount({ site: "linktree", handle: p.username || h, url, name: p.title, bio: p.bio, avatar: p.avatar, source: isGiven ? "given" : "linkpage", extra: { social: p.social } }, subject, shared));
      for (const s of p.social) {
        pushAccount(shared, makeAccount({ site: platformOf(s) || hostOf(s), handle: handleFromUrl(s), url: s, source: "linkpage", extra: { via: url } }, subject, shared));
        if (isGiven) (shared.officialLinks ||= []).push(s);
      }
      ctx.add({ var: "social.linkpage", value: `Linktree ${url}${p.title ? ` "${p.title}"` : ""}: ${p.social.length} social link(s) ${p.social.map((s) => hostOf(s)).join(", ")}${p.links.length ? `; ${p.links.length} link(s), e.g. ${p.links.slice(0, 4).map((l) => l.title || hostOf(l.url)).join(", ")}` : ""}`, url, grade: isGiven || named ? "p" : "w", tier: "B", anchors: [isGiven ? "given" : "name"], image: p.avatar, detail: p });
    }
    for (const { u, r } of ps) {
      if (!r.ok) continue;
      const me = relMeLinks(r.text);
      const m = meta(r.text);
      if (!me.length) continue;
      n++;
      const root = accts.find((a) => [a.blog, a.extra?.blog, a.extra?.website].some((b) => b && hostOf(/^https?:/.test(b) ? b : `https://${b}`) === hostOf(u)));
      const tied = root && (root.source === "given" || (root.anchors || []).includes("company"));
      for (const s of me) {
        if (!platformOf(s)) continue;
        pushAccount(shared, makeAccount({ site: platformOf(s), handle: handleFromUrl(s), url: s, source: "rel-me", extra: { via: u } }, subject, shared));
        if (tied) (shared.officialLinks ||= []).push(s);
      }
      ctx.add({ var: "social.linkpage", value: `Personal site ${hostOf(u)}${m.title ? ` ("${m.title.slice(0, 60)}")` : ""} links with rel=me to ${me.map((s) => hostOf(s)).join(", ")}${root ? ` (named on ${root.site} @${root.handle})` : ""}`, url: u, grade: tied || nameMatch(m.title || "", subject) ? "p" : "w", tier: "B", anchors: root?.anchors || [], detail: { site: u, relMe: me, from: root ? `${root.site} @${root.handle}` : null } });
    }
    // a 404 is an answer (no such page); no answer at all is "couldn't check"
    const answered = [...lt, ...ps].some(({ r }) => r.ok || r.status === 404);
    if (!n) ctx.miss("social.linkpage", `no Linktree page naming ${subject.name} under ${handles.join(", ") || "no handle"}${sites.length ? `; no rel=me links on ${sites.join(", ")}` : ""}${answered ? "" : "; no page answered, not checked"}`, { blocked: !answered });
  },
};
