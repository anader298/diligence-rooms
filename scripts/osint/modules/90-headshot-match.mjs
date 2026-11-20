// headshot-match (heavy, opt-in: --heavy headshot-match). Compares the official headshot (--photo,
// the company bio photo, or a published profile photo) with every candidate account's avatar,
// using a perceptual-hash search over crops in a Python sidecar (scripts/osint/py/imagehash_match.py,
// imagehash BSD-2 + Pillow, installed by pip, not vendored). Lazy: Python starts only when there is
// a headshot and at least one avatar to compare.
//
// Rule (integration plan 3.4, tested on Commons photos): pHash distance over the multi-crop search
// <= 6 is a match, 7-10 a possible match, above 10 no match. dHash is logged for the benchmark.
// A match is registered with the identity module the way a reverse-image hit is (shared.reverseHits),
// so it uses the existing "headshot reused" signal; no weight is added or changed here.
// Never face recognition: hashes compare the same photo, not the same face.

import { runSidecar, depMiss } from "../sidecar.mjs";
import { UA } from "../core.mjs";

export const MATCH = 6;
export const POSSIBLE = 10;

/** Verdict for one sidecar result. */
export function verdictOf(r) {
  if (r == null || r.phash == null) return null;
  return r.phash <= MATCH ? "match" : r.phash <= POSSIBLE ? "possible" : "no match";
}

/** The reference photo and where it came from, best first. */
export function referenceOf(subject, shared = {}, rows = []) {
  if (subject.photo) return { url: subject.photo, from: "--photo", official: true };
  const bio = rows.find((r) => r.var === "pic.headshot" && r.image && r.grade === "v");
  if (bio) return { url: bio.image, from: `company site (${bio.id})`, official: true };
  if (shared.headshot) return { url: shared.headshot, from: shared.headshotFrom || "a profile", official: false };
  return null;
}

/** Candidate avatars to compare: one per distinct image, never the reference itself. */
export function avatarsOf(shared = {}, ref = null) {
  const out = [];
  const seen = new Set(ref ? [ref.url] : []);
  for (const a of shared.accounts || []) {
    if (!a?.avatar || seen.has(a.avatar) || /gravatar\.com\/avatar\/0{32}|default[_-]?avatar|\/static\/|blank|placeholder/i.test(a.avatar)) continue;
    seen.add(a.avatar);
    out.push({ id: `${a.site}|${a.handle || a.url}`, url: a.avatar, account: a });
  }
  return out.slice(0, 30);
}

export default {
  id: "headshot-match",
  /** The ledger variables this module fills (config/form buckets read them to say "no tool yet"). */
  vars: ["pic.avatar_matches"],
  label: "Headshot vs avatars: multi-crop perceptual hash (opt-in)",
  lane: "heavy",
  flag: "--heavy headshot-match",
  needs: ["name"],
  deps: { python: ["imagehash", "PIL"] },
  budgetMs: 45000,
  async run(ctx) {
    const { subject, shared } = ctx;
    // the ledger rows so far are reachable through ctx.rows when the runner provides them
    const ref = referenceOf(subject, shared, ctx.rows || []);
    if (!ref) return ctx.miss("pic.avatar_matches", "headshot match not run: no headshot (pass --photo, or a company bio or verified profile must publish one)", { blocked: true });
    const cands = avatarsOf(shared, ref);
    if (!cands.length) return ctx.miss("pic.avatar_matches", `headshot match: no candidate avatars to compare with the headshot from ${ref.from}`);
    const r = await runSidecar("imagehash_match", { reference: ref.url, candidates: cands.map(({ id, url }) => ({ id, url })), user_agent: UA, timeout: 8 }, { timeoutMs: 40000, env: ctx.env });
    if (r.missing) return depMiss(ctx, "pic.avatar_matches", "headshot match", r.missing, null, ["imagehash", "PIL"]);
    if (!r.ok) {
      ctx.status("error", `sidecar: ${r.error}`);
      return ctx.miss("pic.avatar_matches", `headshot match not run: sidecar failed (${r.error})`, { blocked: true });
    }
    if (!r.data.reference?.ok) return ctx.miss("pic.avatar_matches", `headshot match not run: the headshot from ${ref.from} could not be read (${r.data.reference?.error || "unknown"})`, { blocked: true });
    const byId = new Map(cands.map((c) => [c.id, c]));
    let matched = 0;
    let failed = 0;
    for (const res of r.data.results || []) {
      const c = byId.get(res.id);
      if (!c) continue;
      if (res.error) {
        failed++;
        continue;
      }
      const v = verdictOf(res);
      const a = c.account;
      const detail = { phash: res.phash, dhash: res.dhash, crop: res.crop, verdict: v, reference: ref.url, referenceFrom: ref.from, avatar: c.url, site: a.site, handle: a.handle || null, method: "pHash multi-crop (9 scales x 25 offsets), min distance of 64 bits" };
      if (v === "no match") continue;
      if (v === "match") {
        matched++;
        (shared.reverseHits ||= []).push({ page: a.url, image: c.url, title: `avatar matches the headshot (pHash ${res.phash})`, via: "headshot-match" });
      }
      ctx.add({
        var: "pic.avatar_matches",
        value: `${a.site}${a.handle ? ` @${a.handle}` : ""}: avatar ${v === "match" ? "is" : "may be"} the same photo as the headshot from ${ref.from} (pHash ${res.phash}/64, dHash ${res.dhash})`,
        url: a.url,
        image: c.url,
        // the same photo, not proof of the same person: an official reference raises it to p
        grade: v === "match" && ref.official ? "p" : "w",
        tier: "B",
        anchors: ["image"],
        detail,
      });
    }
    if (!matched && !(r.data.results || []).some((x) => verdictOf(x) === "possible")) ctx.miss("pic.avatar_matches", `headshot match: ${cands.length - failed} avatar(s) compared with the headshot from ${ref.from}, none the same photo (pHash > ${POSSIBLE})${failed ? `; ${failed} avatar(s) could not be downloaded` : ""}`, { blocked: failed >= cands.length });
    else if (failed) ctx.miss("pic.avatar_matches", `headshot match: ${failed} avatar(s) could not be downloaded (unknown, not compared)`, { blocked: true });
    ctx.log(`${cands.length} avatars, ${matched} match(es), ${failed} unreadable, ${r.ms} ms`);
  },
};
