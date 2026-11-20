// actor-search: candidate accounts found by the person's name, not by a handle. Mastodon v2
// account search on large instances (the Bluesky name search already runs in the sweep, 12-accounts).
// No ledger rows: like the sweep, candidates go into shared.accounts and the identity module
// (late lane) scores them; a name search alone is never proof.

import { nameMatch, companyIn, placeIn, stripTags, pool, isBlocked, blockedMiss } from "../person-lib.mjs";

/** Instances searched; each answers /api/v2/search for accounts it knows (local and federated). */
export const INSTANCES = ["mastodon.social", "mastodon.online", "fosstodon.org"];

/**
 * One account in the shape 12-accounts puts in shared.accounts, with its anchors worked out the
 * same way: name, company named in the text, a known place. confirmed = the display name matches
 * (or the handle was given). Shared by the Part 2 person modules.
 */
export function makeAccount(a, subject, shared = {}) {
  const text = [a.name, a.bio, a.company, a.location].filter(Boolean).join(" · ");
  const nm = nameMatch(a.name || "", subject) || (!a.mustName && !a.name && nameMatch(a.bio || "", subject));
  const anchors = [];
  if (nm) anchors.push("name");
  if (companyIn(text, subject)) anchors.push("company");
  if (placeIn(a.location || a.bio || "", subject, shared)) anchors.push("place");
  return { followers: null, extra: null, ...a, nameMatch: nm, anchors, confirmed: nm || a.source === "given" };
}

/** Add an account to shared.accounts unless the same site+handle (or URL) is already there. Returns true when added. */
export function pushAccount(shared, acc) {
  const list = (shared.accounts ||= []);
  const k = (x) => (x.handle ? `${x.site}|${String(x.handle).toLowerCase()}` : `url|${String(x.url || "").toLowerCase().replace(/\/$/, "")}`);
  const u = (x) => String(x.url || "").toLowerCase().replace(/\/$/, "");
  const key = k(acc);
  if (list.some((x) => k(x) === key || (u(acc) && u(x) === u(acc)))) return false;
  list.push(acc);
  return true;
}

/** Accounts from a Mastodon v2 search response whose display name matches the subject. */
export function mastodonMatches(json, subject, instance) {
  const out = [];
  for (const a of json?.accounts || []) {
    if (!nameMatch(a.display_name || "", subject)) continue;
    // mirrors and bridges republish other people's accounts under their own host
    if (/proxy|bridge|bird\.makeup|mostr\.pub|fedi\.buzz/i.test(a.url || "") || a.bot) continue;
    // accounts on mastodon.social keep the bare username, as the sweep (12-accounts) names them
    const home = a.acct.includes("@") ? a.acct.split("@")[1] : instance;
    const acct = home === "mastodon.social" ? a.username : a.acct.includes("@") ? a.acct : `${a.acct}@${instance}`;
    const fields = (a.fields || []).map((f) => ({ name: f.name, value: stripTags(f.value || ""), verified: !!f.verified_at }));
    out.push({
      site: "mastodon",
      handle: acct,
      url: a.url,
      name: a.display_name,
      bio: stripTags(a.note || ""),
      avatar: a.avatar,
      followers: a.followers_count ?? null,
      extra: { id: a.id, instance, posts: a.statuses_count, last: a.last_status_at, created: a.created_at, fields, bot: !!a.bot },
    });
  }
  return out;
}

export default {
  id: "actor-search",
  label: "Name search for accounts (Mastodon)",
  lane: "fast",
  needs: ["name"],
  budgetMs: 10000,
  async run(ctx) {
    const { subject, http, shared } = ctx;
    const q = encodeURIComponent(subject.name);
    const res = await pool(INSTANCES, INSTANCES.length, async (inst) => ({ inst, r: await http.json(`https://${inst}/api/v2/search?type=accounts&q=${q}&limit=10&resolve=false`, { timeout: 6000 }) }));
    const seen = new Set();
    let found = 0;
    const refused = res.filter((x) => x?.r && isBlocked(x.r));
    for (const { inst, r } of res.filter((x) => x?.r?.ok)) {
      for (const a of mastodonMatches(r.data, subject, inst)) {
        const k = String(a.url).toLowerCase().replace(/\/$/, "");
        if (seen.has(k)) continue;
        seen.add(k);
        if (pushAccount(shared, makeAccount({ ...a, source: "name-search" }, subject, shared))) found++;
      }
    }
    if (refused.length === res.length) return blockedMiss(ctx, "social.accounts", "Mastodon search", refused[0].r, "retry later");
    if (refused.length) for (const x of refused) blockedMiss(ctx, "social.accounts", `Mastodon search on ${x.inst}`, x.r, "retry later", { partial: true });
    if (!found) ctx.miss("social.accounts", `Mastodon account search on ${INSTANCES.join(", ")}: no account whose display name matches ${subject.name}`);
    ctx.log(`${found} Mastodon candidate(s) by name`);
  },
};
