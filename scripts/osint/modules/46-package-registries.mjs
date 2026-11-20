// package-registries (slow lane, after the sweep): packages published under the person's handles.
// crates.io users and their crates (the API asks for a User-Agent with a contact), RubyGems
// owners, and the PyPI user page. npm and Docker Hub are already in the sweep (12-accounts).
// An account counts when its name matches the person or the handle was given / already confirmed;
// those become career.code rows, and every account found joins the candidate list.
// PyPI user pages sit behind a JavaScript challenge for scripts (measured 19 Nov 2026): recorded
// as "not checked", not "none".

import { nameMatch, derivedHandles, stripTags, isBlocked, blockedMiss } from "../person-lib.mjs";
import { SEC_UA } from "../core.mjs";
import { makeAccount, pushAccount } from "./40-actor-search.mjs";

const UA = () => ({ "user-agent": `diligence-rooms osint (${SEC_UA().split(" ").pop()})` });

/** crates.io: { user, crates[] } → summary. */
export function cratesSummary(user, crates) {
  const u = user?.user;
  if (!u) return null;
  const list = (crates?.crates || []).map((c) => ({ name: c.name, downloads: c.downloads, updated: String(c.updated_at || "").slice(0, 10), description: c.description || null }));
  return { login: u.login, name: u.name || null, avatar: u.avatar || null, github: u.url || null, created: String(u.created_at || "").slice(0, 10) || null, total: crates?.meta?.total ?? list.length, crates: list };
}

/** RubyGems owners/<h>/gems.json → [{ name, downloads, version, info }]. */
export function gemsSummary(json) {
  return (Array.isArray(json) ? json : []).map((g) => ({ name: g.name, downloads: g.downloads, version: g.version, info: g.info ? String(g.info).slice(0, 120) : null, url: g.project_uri }));
}

/** PyPI user page: { name, projects[] } or { challenge: true } or null (404). */
export function pypiUser(html) {
  const t = String(html || "");
  if (/<title>Client Challenge<\/title>|enable JavaScript to proceed/i.test(t)) return { challenge: true };
  const name = t.match(/<h1[^>]*author-profile__name[^>]*>([\s\S]*?)<\/h1>/)?.[1];
  const projects = [...t.matchAll(/<h3 class="package-snippet__title">([\s\S]*?)<\/h3>/g)].map((m) => stripTags(m[1]));
  return name || projects.length ? { name: name ? stripTags(name) : null, projects } : null;
}

export default {
  id: "package-registries",
  /** The ledger variables this module fills (config/form buckets read them to say "no tool yet"). */
  vars: ["career.code"],
  label: "Package registries (crates.io, RubyGems, PyPI)",
  lane: "slow",
  needs: ["name"],
  budgetMs: 12000,
  async run(ctx) {
    const { subject, http, shared } = ctx;
    const given = (subject.handles || []).map((h) => h.replace(/^@/, ""));
    const conf = (shared.accounts || []).filter((a) => a.confirmed && a.handle && /^[a-z0-9_-]{2,39}$/i.test(a.handle)).map((a) => a.handle);
    const strong = [...new Set([...given, ...conf].map((h) => h.toLowerCase()))];
    const handles = [...new Set([...strong, ...derivedHandles(subject).slice(0, 2)])].slice(0, 5);
    if (!handles.length) return ctx.miss("career.code", "package registries: no handle to look up");
    let n = 0;
    const isStrong = (h) => strong.includes(h.toLowerCase());
    const add = (site, h, name, value, url, extra) => {
      const named = nameMatch(name || "", subject);
      if (!named && !isStrong(h)) return; // a derived handle under someone else's name: a namesake, dropped
      pushAccount(shared, makeAccount({ site, handle: h, url, name, source: given.includes(h) ? "given" : "registry", extra }, subject, shared));
      n++;
      ctx.add({ var: "career.code", value, url, grade: named && isStrong(h) ? "p" : "w", tier: "A", anchors: [named ? "name" : null, isStrong(h) ? "handle" : null].filter(Boolean), detail: { site, handle: h, ...extra } });
    };
    // which registries answered (a 404 is an answer: no such user); none answering is "couldn't check"
    let answered = 0;
    const tally = (r) => (r.ok || r.status === 404 ? answered++ : 0);
    // crates.io allows about one request a second: handles in sequence
    for (const h of handles) {
      const u = await http.json(`https://crates.io/api/v1/users/${encodeURIComponent(h)}`, { headers: UA(), timeout: 5000 });
      tally(u);
      if (!u.ok) {
        if (isBlocked(u) && u.status !== 404) blockedMiss(ctx, "career.code", "crates.io", u, "retry later", { partial: true });
        continue;
      }
      const c = await http.json(`https://crates.io/api/v1/crates?user_id=${u.data.user.id}&per_page=10&sort=downloads`, { headers: UA(), timeout: 5000 });
      const s = cratesSummary(u.data, c.data);
      add("crates.io", s.login, s.name, `crates.io @${s.login}${s.name ? ` (${s.name})` : ""}: ${s.total} crate(s)${s.crates.length ? `, e.g. ${s.crates.slice(0, 5).map((x) => `${x.name} (${(x.downloads || 0).toLocaleString()} downloads)`).join(", ")}` : ""}`, `https://crates.io/users/${s.login}`, { crates: s.crates, github: s.github, created: s.created });
    }
    await Promise.all(strong.slice(0, 3).map(async (h) => {
      const [g, p] = await Promise.all([
        http.json(`https://rubygems.org/api/v1/owners/${encodeURIComponent(h)}/gems.json`, { timeout: 5000 }),
        http.get(`https://pypi.org/user/${encodeURIComponent(h)}/`, { timeout: 5000 }),
      ]);
      tally(g);
      const gems = g.ok ? gemsSummary(g.data) : [];
      if (gems.length) add("rubygems", h, null, `RubyGems owner ${h}: ${gems.length} gem(s), e.g. ${gems.slice(0, 5).map((x) => x.name).join(", ")}`, `https://rubygems.org/profiles/${h}`, { gems: gems.slice(0, 15) });
      const py = p.status === 404 ? null : pypiUser(p.text);
      if (!py?.challenge) tally(p);
      if (py?.challenge) ctx.miss("career.code", `PyPI user ${h}: not checked (PyPI serves a JavaScript challenge to scripts) · check https://pypi.org/user/${h}/ by hand`, { blocked: true });
      else if (py?.projects.length) add("pypi", h, py.name, `PyPI user ${h}${py.name ? ` (${py.name})` : ""}: ${py.projects.length} project(s)${py.projects.length ? `, e.g. ${py.projects.slice(0, 5).join(", ")}` : ""}`, `https://pypi.org/user/${h}/`, { projects: py.projects });
    }));
    if (!n) ctx.miss("career.code", `crates.io (${handles.join(", ")}), RubyGems and PyPI (${strong.slice(0, 3).join(", ") || "no given or confirmed handle"}): no packages under a name that matches ${subject.name}${answered ? "" : "; no registry answered, not checked"}`, { blocked: !answered });
  },
};
