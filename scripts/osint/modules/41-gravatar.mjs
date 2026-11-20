// gravatar: the public Gravatar profile behind the person's work email (api.gravatar.com/v3,
// looked up by the SHA-256 of the address). --email is tried first, then the common patterns on
// --domain. A profile found by a given email is tied to the person; one found by a guessed
// pattern counts only when its display name matches. The profile's verified_accounts are links
// Gravatar checked by sign-in: they go into the candidate list, and, when the profile is tied,
// into shared.officialLinks (which the identity module already reads).
// 100 calls an hour without a key; GRAVATAR_API_KEY (free) raises it to 1,000.

import { createHash } from "node:crypto";
import { emailCandidates, nameMatch, companyIn, handleFromUrl, platformOf, isBlocked, blockedMiss } from "../person-lib.mjs";
import { makeAccount, pushAccount } from "./40-actor-search.mjs";

export const sha256 = (s) => createHash("sha256").update(String(s).trim().toLowerCase()).digest("hex");

const SERVICE = { twitter: "x", linkedin: "linkedin", github: "github", instagram: "instagram", facebook: "facebook", mastodon: "mastodon", tumblr: "tumblr", wordpress: "wordpress", youtube: "youtube", bluesky: "bluesky", tiktok: "tiktok", flickr: "flickr", stackoverflow: "stackoverflow", goodreads: "goodreads", foursquare: "foursquare", calendly: "calendly", twitch: "twitch" };

/** Read a v3 profile: the fields we keep and its verified accounts. */
export function gravatarProfile(d) {
  if (!d?.hash) return null;
  const verified = (d.verified_accounts || []).filter((v) => !v.is_hidden && v.url).map((v) => ({ service: SERVICE[v.service_type] || v.service_type, label: v.service_label, url: v.url }));
  return { name: d.display_name || null, url: d.profile_url, handle: handleFromUrl(d.profile_url) || String(d.profile_url || "").split("/").pop() || null, avatar: d.avatar_url, location: d.location || null, bio: d.description || null, jobTitle: d.job_title || null, company: d.company || null, verified, links: (d.links || []).map((l) => l.url).filter(Boolean) };
}

/** Is the profile the subject's? given email: yes; guessed pattern: only if the display name matches. */
export function gravatarTie(p, cand, subject) {
  const named = nameMatch(p.name || "", subject);
  if (cand.source === "given") return { tied: true, named, grade: named || companyIn(`${p.company || ""} ${p.bio || ""}`, subject) ? "p" : "w" };
  if (!named) return { tied: false, named, grade: "w" };
  return { tied: true, named, grade: companyIn(`${p.company || ""} ${p.jobTitle || ""} ${p.bio || ""}`, subject) ? "p" : "w" };
}

export default {
  id: "gravatar",
  /** The ledger variables this module fills (config/form buckets read them to say "no tool yet"). */
  vars: ["social.proofs"],
  label: "Gravatar profile by work email (verified linked accounts)",
  lane: "fast",
  needs: ["name"],
  env: ["GRAVATAR_API_KEY"],
  budgetMs: 10000,
  async run(ctx) {
    const { subject, http, shared, env } = ctx;
    const cands = emailCandidates(subject, shared).slice(0, 5);
    if (!cands.length) return ctx.miss("social.proofs", "Gravatar: no email to look up (pass --email, or --domain for the common patterns)");
    const headers = env.GRAVATAR_API_KEY ? { authorization: `Bearer ${env.GRAVATAR_API_KEY}` } : {};
    const res = await Promise.all(cands.map(async (c) => ({ c, r: await http.json(`https://api.gravatar.com/v3/profiles/${sha256(c.email)}`, { headers, timeout: 6000 }) })));
    let hits = 0;
    for (const { c, r } of res) {
      if (isBlocked(r) && r.status !== 404) {
        blockedMiss(ctx, "social.proofs", `Gravatar (${c.email})`, r, env.GRAVATAR_API_KEY ? "retry in an hour" : "set GRAVATAR_API_KEY (free) or retry in an hour", { partial: true });
        continue;
      }
      const p = r.ok ? gravatarProfile(r.data) : null;
      if (!p) continue;
      const tie = gravatarTie(p, c, subject);
      if (!tie.tied) {
        ctx.miss("social.proofs", `Gravatar profile for guessed ${c.email} is "${p.name || "unnamed"}", not ${subject.name}: not used`);
        continue;
      }
      hits++;
      const acc = makeAccount({ site: "gravatar", handle: p.handle, url: p.url, name: p.name, bio: [p.jobTitle, p.bio].filter(Boolean).join(" · ") || null, company: p.company, location: p.location, avatar: p.avatar, source: c.source === "given" ? "email:given" : "email:pattern", extra: { email: c.email, jobTitle: p.jobTitle, verified: p.verified } }, subject, shared);
      pushAccount(shared, acc);
      for (const v of p.verified) {
        const site = platformOf(v.url) || v.service;
        pushAccount(shared, makeAccount({ site, handle: handleFromUrl(v.url), url: v.url, source: "gravatar-verified", extra: { via: p.url } }, subject, shared));
        (shared.officialLinks ||= []).push(v.url);
      }
      ctx.add({
        var: "social.proofs",
        value: `Gravatar for ${c.source === "given" ? "the given email" : `guessed ${c.email}`}: "${p.name || "?"}"${p.jobTitle ? `, ${p.jobTitle}` : ""}${p.company ? ` at ${p.company}` : ""}${p.location ? `, ${p.location}` : ""}${p.verified.length ? `; verified accounts: ${p.verified.map((v) => v.url).join(", ")}` : "; no verified accounts"}`,
        url: p.url,
        grade: tie.grade,
        tier: "A",
        anchors: ["email", ...acc.anchors],
        image: p.avatar,
        detail: { email: c.email, source: c.source, ...p },
      });
    }
    if (!hits) ctx.miss("social.proofs", `Gravatar: no public profile for ${cands.map((c) => c.email).join(", ")}`);
  },
};
