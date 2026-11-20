// verified-links (slow lane, after the sweep): links between accounts that the platforms
// themselves checked. Keybase cryptographic proofs (GitHub, X, Reddit, Hacker News, domains),
// Mastodon profile fields carrying verified_at (a rel=me link back), and the accounts a GitHub
// user lists in social_accounts. Each becomes a social.proofs row. When the account holding the
// proof is already tied to the subject (a handle you gave, or a company anchor), the linked
// profiles are pushed into shared.officialLinks and shared.accounts, so the identity module's
// existing "linked from an official page" rule picks them up. No scoring change here.

import { handleFromUrl, platformOf, stripTags, isBlocked, blockedMiss } from "../person-lib.mjs";
import { makeAccount, pushAccount } from "./40-actor-search.mjs";

const KB = "https://keybase.io/_/api/1.0/user/lookup.json";
const norm = (u) => String(u || "").toLowerCase().replace(/\/$/, "");

/** Proofs from a Keybase lookup "them" entry: [{ service, handle, url, proof }]. Live proofs only (state 1). */
export function keybaseProofs(them) {
  const out = [];
  for (const p of them?.proofs_summary?.all || []) {
    if (p.state !== undefined && p.state !== 1) continue;
    const service = p.proof_type === "generic_web_site" ? "web" : p.proof_type === "dns" ? "dns" : p.proof_type;
    out.push({ service, handle: p.nametag, url: p.service_url || (service === "dns" ? `https://${p.nametag}` : null), proof: p.human_url || p.proof_url || null });
  }
  return out;
}

/** Mastodon profile fields that the server verified (rel=me back-link): [{ name, url }]. */
export function mastodonVerified(acct) {
  return (acct?.fields || []).filter((f) => f.verified_at).map((f) => {
    const href = String(f.value || "").match(/href="([^"]+)"/)?.[1] || stripTags(f.value || "");
    return { name: f.name, url: /^https?:/.test(href) ? href : `https://${href}` };
  });
}

/** Is this account already tied to the subject (so its proofs can vouch for the linked ones)? */
export function anchoredRoot(a, shared = {}) {
  const official = new Set((shared.officialLinks || []).map(norm));
  return a.source === "given" || (a.anchors || []).includes("company") || official.has(norm(a.url));
}

export default {
  id: "verified-links",
  /** The ledger variables this module fills (config/form buckets read them to say "no tool yet"). */
  vars: ["social.proofs"],
  label: "Verified links between accounts (Keybase proofs, Mastodon verified fields, GitHub social accounts)",
  lane: "slow",
  needs: ["name"],
  env: ["GITHUB_TOKEN"],
  budgetMs: 15000,
  async run(ctx) {
    const { subject, http, shared, env } = ctx;
    const accts = shared.accounts || [];
    const usable = (a) => a.confirmed || a.source === "given";
    const uniq = (list) => [...new Map(list.map((a) => [String(a.handle).toLowerCase(), a])).values()];
    const given = (subject.handles || []).map((h) => h.replace(/^@/, ""));
    const kbNames = [...new Set([...accts.filter((a) => a.site === "keybase" && usable(a)).map((a) => a.handle), ...given])].filter((h) => /^[a-z0-9_]+$/i.test(h)).slice(0, 6);
    const gh = uniq(accts.filter((a) => a.site === "github" && a.handle && usable(a))).slice(0, 3);
    const md = uniq(accts.filter((a) => a.site === "mastodon" && a.handle && usable(a))).slice(0, 3);
    if (!kbNames.length && !gh.length && !md.length) return ctx.miss("social.proofs", "verified links: no confirmed Keybase, GitHub or Mastodon account to read proofs from");
    const ghHeaders = env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {};
    const roots = []; // { root: account-like, via, links: [{service, handle, url, proof}] }

    const tasks = [];
    if (kbNames.length) tasks.push(http.json(`${KB}?usernames=${kbNames.join(",")}&fields=basics,profile,proofs_summary`, { timeout: 5000 }).then((r) => ({ kind: "kb-user", r })));
    if (gh.length) tasks.push(http.json(`${KB}?github=${gh.map((a) => a.handle).join(",")}&fields=basics,profile,proofs_summary`, { timeout: 5000 }).then((r) => ({ kind: "kb-github", r })));
    for (const a of gh) tasks.push(http.json(`https://api.github.com/users/${a.handle}/social_accounts`, { timeout: 5000, headers: ghHeaders }).then((r) => ({ kind: "gh", a, r })));
    for (const a of md) {
      const [user, inst] = String(a.handle).split("@");
      const host = inst || (() => { try { return new URL(a.url).host; } catch { return "mastodon.social"; } })();
      tasks.push(http.json(`https://${host}/api/v1/accounts/lookup?acct=${encodeURIComponent(user)}`, { timeout: 5000 }).then((r) => ({ kind: "md", a, r })));
    }
    const refused = new Set();
    for (const t of await Promise.all(tasks)) {
      const { kind, r } = t;
      if (!r.ok) {
        if (isBlocked(r) && r.status !== 404 && !refused.has(kind) && refused.add(kind)) blockedMiss(ctx, "social.proofs", kind.startsWith("kb") ? "Keybase" : kind === "gh" ? "GitHub social_accounts" : "Mastodon lookup", r, "retry later", { partial: true });
        continue;
      }
      if (kind.startsWith("kb")) {
        (r.data?.them || []).forEach((them, i) => {
          if (!them) return;
          const u = them.basics?.username;
          const links = keybaseProofs(them);
          if (!links.length) return;
          // the root is the account we asked about: a Keybase account itself, or the GitHub account it proves
          const viaGh = kind === "kb-github" ? gh.find((a) => links.some((l) => l.service === "github" && l.handle?.toLowerCase() === a.handle.toLowerCase())) || gh[i] : null;
          const known = accts.find((a) => a.site === "keybase" && a.handle?.toLowerCase() === u?.toLowerCase());
          const root = viaGh || known || { site: "keybase", handle: u, url: `https://keybase.io/${u}`, source: given.some((h) => h.toLowerCase() === u?.toLowerCase()) ? "given" : "keybase", name: them.profile?.full_name };
          roots.push({ root, via: `Keybase @${u}`, url: `https://keybase.io/${u}`, links: [{ service: "keybase", handle: u, url: `https://keybase.io/${u}` }, ...links], crypto: true });
        });
      } else if (kind === "gh") {
        const links = (r.data || []).map((s) => ({ service: s.provider === "generic" ? platformOf(s.url) || "web" : s.provider === "twitter" ? "x" : s.provider, handle: handleFromUrl(s.url), url: s.url }));
        if (links.length) roots.push({ root: t.a, via: `GitHub @${t.a.handle} social accounts`, url: `https://github.com/${t.a.handle}`, links, crypto: false });
      } else if (kind === "md") {
        const links = mastodonVerified(r.data).map((f) => ({ service: platformOf(f.url) || "web", handle: handleFromUrl(f.url), url: f.url, label: f.name }));
        if (links.length) roots.push({ root: t.a, via: `Mastodon @${t.a.handle} verified fields`, url: t.a.url, links, crypto: true });
      }
    }
    if (!roots.length) return ctx.miss("social.proofs", `verified links: no proofs on Keybase (${[...kbNames, ...gh.map((a) => "github:" + a.handle)].join(", ") || "none asked"}), GitHub social accounts (${gh.map((a) => a.handle).join(", ") || "none"}) or Mastodon verified fields (${md.map((a) => a.handle).join(", ") || "none"})`);
    for (const x of roots) {
      const tied = anchoredRoot(x.root, shared);
      const others = x.links.filter((l) => norm(l.url) !== norm(x.root.url));
      if (tied) {
        for (const l of others) {
          if (!l.url || l.service === "dns" || l.service === "web") continue;
          (shared.officialLinks ||= []).push(l.url);
          pushAccount(shared, makeAccount({ site: platformOf(l.url) || l.service, handle: l.handle || handleFromUrl(l.url), url: l.url, source: "proof", extra: { via: x.via } }, ctx.subject, shared));
        }
      }
      ctx.add({
        var: "social.proofs",
        value: `${x.via}${x.crypto ? " (verified)" : " (self-listed)"} links ${others.map((l) => `${l.service}${l.handle ? ` ${l.handle}` : ""}`).join(", ")}${tied ? "" : " — the account itself is not yet tied to the subject"}`,
        url: x.url,
        grade: tied ? "p" : "w",
        tier: "B",
        anchors: tied ? ["link", ...(x.root.anchors || [])] : x.root.anchors || [],
        detail: { root: { site: x.root.site, handle: x.root.handle, url: x.root.url, source: x.root.source }, links: x.links, cryptographic: x.crypto, tied },
      });
    }
  },
};
