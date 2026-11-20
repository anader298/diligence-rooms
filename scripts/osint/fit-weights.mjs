#!/usr/bin/env node
// Fit the identity weights on hand-labelled candidate accounts and write config/osint-weights.json.
//
//   node scripts/osint/fit-weights.mjs --labels work/osint/labels --runs work/osint/panel/before \
//        [--holdout slugA,slugB] [--write]
//
// Labels: one TSV per subject (<labels>/<slug>.tsv, columns id ... label), produced by hand
// review; the matching ledger is <runs>/<slug>/ledger.jsonl. Only identity rows are used here:
// label "correct" = the account is the subject's, "wrong" = someone else's, "unsure" is dropped.
// Keep labels outside the repo or under the git-ignored work/ folder: they name real people.
//
// Model: logistic regression in bits (log2 odds), L2-shrunk toward the hand weights of the
// current file, so a feature seen in only a few labelled candidates keeps roughly its hand value
// (design doc 7.4). Prints leave-one-subject-out log loss and the confusion at the thresholds.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadWeights, WEIGHTS_FILE } from "./weights.mjs";
import { derivedHandles } from "./person-lib.mjs";

/** Features of a candidate from its ledger row: detail.features when present, else the reasons. */
export function featuresOfRow(row, subject = {}) {
  const d = row.detail || {};
  if (d.features) return { ...d.features };
  const F = {};
  for (const r of d.reasons || []) {
    if (/^name \+/.test(r)) F.name = true;
    else if (/^employer on profile/.test(r)) F.employer_on_profile = true;
    else if (/^company \+/.test(r)) F.company_text = true;
    else if (/^employer ".*" named with/.test(r)) F.career = true;
    else if (/^other company/.test(r)) F.employer_contra = true;
    else if (/^(handle given by you|linked from an official page)/.test(r)) F.link = true;
    else if (/^place \+/.test(r)) F.place = true;
    else if (/^other place/.test(r)) F.place_contra = true;
    else if (/^title words/.test(r)) F.title = true;
    else if (/^headshot reused/.test(r)) F.image = true;
    else if (/^same handle on anchored/.test(r)) F.handle_peer = true;
  }
  if (d.handle && derivedHandles(subject).map((h) => h.toLowerCase()).includes(String(d.handle).toLowerCase())) F.derived_handle = true;
  if (!d.bio && !d.location && !(d.followers > 0)) F.empty_profile = true;
  return F;
}

export function readTsv(file) {
  const [head, ...lines] = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  const cols = head.split("\t");
  return lines.map((l) => Object.fromEntries(l.split("\t").map((v, i) => [cols[i], v])));
}

/** Labelled identity examples: [{ slug, id, x: features, y: 0|1 }]. */
export function loadExamples(labelsDir, runsDir) {
  const out = [];
  for (const f of readdirSync(labelsDir).filter((f) => f.endsWith(".tsv"))) {
    const slug = f.replace(/\.tsv$/, "");
    const ledger = join(runsDir, slug, "ledger.jsonl");
    if (!existsSync(ledger)) continue;
    const rows = readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const subject = existsSync(join(runsDir, slug, "osint.json")) ? JSON.parse(readFileSync(join(runsDir, slug, "osint.json"), "utf8")).subject : {};
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const l of readTsv(join(labelsDir, f))) {
      const r = byId.get(l.id);
      if (!r || r.module !== "identity" || !r.detail?.verdict || r.detail.verdict === "summary") continue;
      if (l.label !== "correct" && l.label !== "wrong") continue;
      out.push({ slug, id: l.id, site: r.detail.site, x: featuresOfRow(r, subject), y: l.label === "correct" ? 1 : 0 });
    }
  }
  return out;
}

const LN2 = Math.log(2);
const sig = (z) => 1 / (1 + Math.exp(-z));

/** MAP logistic regression in bits with a Gaussian prior (sd `sd` bits) around `center`. */
export function fit(examples, names, center, { sd = 2, priorCenter = -4, iters = 4000, lr = 0.05 } = {}) {
  const w = Object.fromEntries(names.map((k) => [k, center[k] ?? 0]));
  let b = priorCenter;
  const lam = 1 / (sd * sd);
  for (let it = 0; it < iters; it++) {
    const g = Object.fromEntries(names.map((k) => [k, 0]));
    let gb = 0;
    for (const e of examples) {
      let z = b;
      for (const k of names) if (e.x[k]) z += w[k];
      const err = sig(z * LN2) - e.y; // d(logloss)/dz, z in bits
      gb += err * LN2;
      for (const k of names) if (e.x[k]) g[k] += err * LN2;
    }
    const n = examples.length || 1;
    for (const k of names) w[k] -= lr * (g[k] / n + (lam * (w[k] - (center[k] ?? 0))) / n);
    b -= lr * (gb / n + (lam * 0.25 * (b - priorCenter)) / n);
  }
  const r = (x) => Math.round(x * 100) / 100;
  return { prior: r(b), features: Object.fromEntries(names.map((k) => [k, r(w[k])])) };
}

export function probOf(x, model) {
  let z = model.prior;
  for (const [k, v] of Object.entries(model.features)) if (x[k]) z += v;
  return 1 / (1 + 2 ** -z);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { values } = parseArgs({ options: { labels: { type: "string" }, runs: { type: "string" }, holdout: { type: "string" }, write: { type: "boolean", default: false }, sd: { type: "string" } } });
  if (!values.labels || !values.runs) {
    console.log("usage: node scripts/osint/fit-weights.mjs --labels <dir> --runs <dir> [--holdout a,b] [--write]");
    process.exit(1);
  }
  const hold = new Set((values.holdout || "").split(",").filter(Boolean));
  const all = loadExamples(values.labels, values.runs);
  const train = all.filter((e) => !hold.has(e.slug));
  const test = all.filter((e) => hold.has(e.slug));
  const cur = loadWeights();
  const names = Object.keys(cur.identity.features);
  const center = cur.version === 1 ? cur.identity.features : cur.fitted?.handValues || cur.identity.features;
  const sd = Number(values.sd || 2);
  const model = fit(train, names, center, { sd, priorCenter: -4 });
  const support = Object.fromEntries(names.map((k) => [k, { pos: train.filter((e) => e.x[k] && e.y).length, neg: train.filter((e) => e.x[k] && !e.y).length }]));
  console.log(`labelled candidates: ${all.length} (${all.filter((e) => e.y).length} theirs); train ${train.length}, holdout ${test.length}`);
  console.log("weights (bits):", model);
  console.log("support:", support);
  // leave one subject out on the training slice
  const slugs = [...new Set(train.map((e) => e.slug))];
  let ll = 0;
  let n = 0;
  for (const s of slugs) {
    const m = fit(train.filter((e) => e.slug !== s), names, center, { sd, priorCenter: -4, iters: 2000 });
    for (const e of train.filter((e) => e.slug === s)) {
      const p = Math.min(1 - 1e-6, Math.max(1e-6, probOf(e.x, m)));
      ll -= e.y ? Math.log(p) : Math.log(1 - p);
      n++;
    }
  }
  console.log(`leave-one-subject-out log loss: ${(ll / (n || 1)).toFixed(3)} over ${n}`);
  const th = cur.identity.thresholds;
  for (const [name, set] of [["train", train], ["holdout", test]]) {
    const at = (t) => {
      const sel = set.filter((e) => probOf(e.x, model) >= t);
      return `${sel.filter((e) => e.y).length}/${sel.length}`;
    };
    console.log(`${name}: theirs/selected at p>=${th.verified}: ${at(th.verified)}; at p>=${th.likely}: ${at(th.likely)}`);
  }
  if (values.write) {
    const out = {
      ...cur,
      version: cur.version + 1,
      id: `osint-weights@${cur.version + 1}`,
      fitted: {
        at: new Date().toISOString().slice(0, 10),
        method: `logistic regression in bits, L2 prior sd ${sd} bits around the hand values`,
        candidates: train.length,
        theirs: train.filter((e) => e.y).length,
        subjects: slugs.length,
        handValues: center,
        support,
      },
      identity: { ...cur.identity, prior: model.prior, features: model.features },
    };
    writeFileSync(WEIGHTS_FILE, JSON.stringify(out, null, 2) + "\n");
    console.log(`wrote ${WEIGHTS_FILE} as ${out.id}`);
  }
}
