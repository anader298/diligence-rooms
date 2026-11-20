// github-email: which GitHub login authors commits under the person's work email. GitHub commit
// search by author-email (10 a minute without a token, 30 with GITHUB_TOKEN). --email first, then
// at most two guessed patterns on --domain. Commit emails can be set to anything, so a login found
// by a guessed address counts only when the commit author name matches the person.

import { emailCandidates, nameMatch, isBlocked, blockedMiss } from "../person-lib.mjs";
import { makeAccount, pushAccount } from "./40-actor-search.mjs";

/** Logins (with commit counts, names used and repos) from a commit search response. */
export function commitAuthors(json, today = new Date().toISOString().slice(0, 10)) {
  const by = new Map();
  for (const it of json?.items || []) {
    const login = it.author?.login;
    if (!login) continue;
    const x = by.get(login) || { login, avatar: it.author.avatar_url, url: it.author.html_url, commits: 0, names: new Set(), repos: new Set(), last: "" };
    x.commits++;
    if (it.commit?.author?.name) x.names.add(it.commit.author.name);
    if (it.repository?.full_name) x.repos.add(it.repository.full_name);
    const d = String(it.commit?.author?.date || "").slice(0, 10);
    if (d > x.last && d <= today) x.last = d; // author dates are set by the committer; future ones are fake
    by.set(login, x);
  }
  return [...by.values()].map((x) => ({ ...x, names: [...x.names], repos: [...x.repos] })).sort((a, b) => b.commits - a.commits);
}

export default {
  id: "github-email",
  /** The ledger variables this module fills (config/form buckets read them to say "no tool yet"). */
  vars: ["social.proofs"],
  label: "GitHub login behind the work email (commit search)",
  lane: "fast",
  needs: ["name"],
  env: ["GITHUB_TOKEN"],
  budgetMs: 10000,
  async run(ctx) {
    const { subject, http, shared, env } = ctx;
    const all = emailCandidates(subject, shared);
    const cands = [...all.filter((c) => c.source === "given").slice(0, 2), ...all.filter((c) => c.source !== "given").slice(0, 2)].slice(0, 3);
    if (!cands.length) return ctx.miss("social.proofs", "GitHub commit search by email: no email (pass --email, or --domain for the common patterns)");
    const headers = { accept: "application/vnd.github+json", ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}) };
    let hits = 0;
    for (const c of cands) {
      const r = await http.json(`https://api.github.com/search/commits?q=${encodeURIComponent(`author-email:${c.email}`)}&per_page=30&sort=author-date&order=desc`, { headers, timeout: 8000 });
      if (!r.ok) {
        if (isBlocked(r)) blockedMiss(ctx, "social.proofs", `GitHub commit search (${c.email})`, r, env.GITHUB_TOKEN ? "retry in a minute" : "set GITHUB_TOKEN (free) or retry in a minute", { partial: true });
        continue;
      }
      for (const a of commitAuthors(r.data).slice(0, 2)) {
        const named = a.names.some((n) => nameMatch(n, subject));
        if (c.source !== "given" && !named) {
          ctx.miss("social.proofs", `GitHub commits by guessed ${c.email} come from @${a.login} ("${a.names[0] || "?"}"), not ${subject.name}: not used`);
          continue;
        }
        const u = await http.json(`https://api.github.com/users/${a.login}`, { headers, timeout: 6000 });
        const d = u.data || {};
        // a guessed address on a big domain is often typed into someone else's git config: the
        // GitHub profile's own name must match too
        // (a profile with no name at all does not count as a match)
        if (c.source !== "given" && !(d.name && nameMatch(d.name, subject))) {
          ctx.miss("social.proofs", `GitHub commits by guessed ${c.email} carry the name "${a.names[0]}", but come from @${a.login} whose profile name is ${d.name ? `"${d.name}"` : "empty"}: not used (commit emails can be set to anything)`);
          continue;
        }
        hits++;
        pushAccount(shared, makeAccount({ site: "github", handle: a.login, url: a.url || `https://github.com/${a.login}`, name: d.name || a.names[0] || null, bio: d.bio || null, company: d.company || null, location: d.location || null, avatar: d.avatar_url || a.avatar, blog: d.blog || null, source: c.source === "given" ? "commit-email:given" : "commit-email:pattern", extra: { email: c.email, commits: a.commits, repos: a.repos.slice(0, 5) } }, subject, shared));
        ctx.add({
          var: "social.proofs",
          value: `GitHub @${a.login} authored ${a.commits}${r.data.total_count > 30 ? "+" : ""} commit(s) as ${c.source === "given" ? "the given email" : `guessed ${c.email}`}${a.names.length ? ` under the name "${a.names.join('", "')}"` : ""}; latest ${a.last || "?"} in ${a.repos.slice(0, 3).join(", ")}`,
          url: `https://github.com/${a.login}`,
          grade: c.source === "given" && named ? "p" : "w",
          tier: "A",
          anchors: ["email", ...(named ? ["name"] : [])],
          date: a.last || null,
          detail: { email: c.email, source: c.source, ...a, total: r.data.total_count },
        });
      }
    }
    if (!hits) ctx.miss("social.proofs", `GitHub commit search: no commits authored by ${cands.map((c) => c.email).join(", ")}`);
  },
};
