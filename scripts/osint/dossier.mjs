// The OSINT dossier: one self-contained HTML page (inline CSS and JS, no external assets) built
// from the result of runOsint(). The header, snapshot and tab bar are rendered here; each tab's
// body is rendered in the browser on first open, so a run with 2,000 ledger rows stays fast.
//
// Everything that came from the web is escaped. The data travels as JSON in a non-executing
// <script type="application/json"> block (every "<" written as <), the page's one script is
// pinned by a sha256 Content-Security-Policy, and no event handler is ever built from data.

import { createHash } from "node:crypto";

const GRADE_NAME = { v: "Verified", p: "Partly verified", w: "Weak", i: "Inference", u: "Unknown", np: "Not public", n: "None found" };
const GRADE_RANK = { v: 0, p: 1, i: 2, w: 3, u: 4, np: 5, n: 6 };
const TIER_RANK = { A: 0, B: 1, C: 2, D: 3, E: 4 };
const EXTRA_TABS = [
  ["accounts", "Accounts & identity", "accounts"],
  ["timeline", "Timeline", "timeline"],
  ["sources", "Sources", "sources"],
  ["gaps", "Gaps", "gaps"],
  ["run", "Run", "run"],
];
const TAB_COLORS = ["#c06a2b", "#1d5a8c", "#2e7d4f", "#7b61b8", "#b8436b", "#a07a12", "#4a5563", "#0f8a8a", "#8c5a2b", "#5c6bc0", "#6b7d2e", "#9b4d1f"];

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function safeUrl(u) {
  if (!u) return null;
  try {
    const x = new URL(String(u));
    return x.protocol === "https:" || x.protocol === "http:" ? x.href : null;
  } catch {
    return null;
  }
}
function hostOf(u) {
  try {
    return new URL(String(u)).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}
function text(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return v.toLocaleString("en-US");
  if (typeof v === "boolean") return v ? "yes" : "no";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const fmtMs = (ms) => (ms == null ? "" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const byBest = (a, b) => (GRADE_RANK[a.grade] ?? 9) - (GRADE_RANK[b.grade] ?? 9) || (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9) || String(a.id).localeCompare(String(b.id));
const gradeChip = (g) => `<span class="grade g-${esc(GRADE_RANK[g] != null ? g : "u")}">${esc(GRADE_NAME[g] || "Unknown")}</span>`;
function initials(name) {
  const p = String(name || "?").trim().split(/\s+/);
  return ((p[0]?.[0] || "?") + (p.length > 1 ? p.at(-1)[0] : "")).toUpperCase();
}
function when(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return `${d.getUTCDate()} ${m} ${d.getUTCFullYear()}, ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}
const money = (n) => "$" + Math.round(n).toLocaleString("en-US");
function amountOf(r) {
  const d = r.detail && typeof r.detail === "object" && !Array.isArray(r.detail) ? r.detail : {};
  const n = Number(d.amount ?? d.contribution_receipt_amount);
  if (Number.isFinite(n)) return n;
  const m = text(r.value).match(/\$\s?([\d,]+(?:\.\d+)?)/);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

/** Normalise the result so a partial or empty one still renders. */
function normalise(result = {}) {
  const rows = Array.isArray(result.rows) ? result.rows.filter((r) => r && typeof r === "object") : [];
  const variables = Array.isArray(result.variables) ? result.variables.filter((v) => v && v.id) : [];
  let tabs = Array.isArray(result.tabs) && result.tabs.length ? result.tabs.filter((t) => Array.isArray(t) && t[0]) : [];
  if (!tabs.length) {
    const seen = [...new Set([...variables.map((v) => v.tab), ...rows.map((r) => r.tab)].filter(Boolean))];
    tabs = seen.map((t) => [t, t[0].toUpperCase() + t.slice(1)]);
  }
  return {
    subject: result.subject && typeof result.subject === "object" ? result.subject : { name: "Unknown subject" },
    ranAt: result.ranAt || null,
    seconds: result.seconds ?? null,
    tabs,
    variables,
    rows: rows.map(({ key, ...r }) => ({ ...r, grade: GRADE_RANK[r.grade] != null ? r.grade : "u", tier: TIER_RANK[r.tier] != null ? r.tier : r.tier ? String(r.tier) : "A" })),
    misses: Array.isArray(result.misses) ? result.misses : [],
    modules: Array.isArray(result.modules) ? result.modules : [],
    http: result.http || { calls: 0, blocked: 0 },
  };
}

export function renderDossier(result) {
  const R = normalise(result);
  const S = R.subject;
  const varTabIds = new Set(R.tabs.map((t) => t[0]));
  const tabList = R.tabs.map(([id, label]) => ({ id: String(id), label: String(label || id), kind: id === "images" ? "pics" : "var" }));
  if (R.rows.some((r) => !varTabIds.has(r.tab))) tabList.push({ id: "other", label: "Other", kind: "other" });
  const used = new Set(tabList.map((t) => t.id));
  for (const [id, label, kind] of EXTRA_TABS) tabList.push({ id: used.has(id) ? "x-" + id : id, label, kind });
  tabList.forEach((t, i) => (t.color = TAB_COLORS[i % TAB_COLORS.length]));

  // ---- counts
  const byVar = new Map();
  for (const r of R.rows) (byVar.get(r.var) || byVar.set(r.var, []).get(r.var)).push(r);
  for (const list of byVar.values()) list.sort(byBest);
  const best = (id) => byVar.get(id)?.[0] || null;
  const filled = R.variables.filter((v) => byVar.has(v.id)).length;
  const hosts = new Set(R.rows.map((r) => hostOf(r.url)).filter(Boolean));
  const modsRan = R.modules.filter((m) => m.status !== "skipped").length;

  // ---- header
  const title = S.title || best("role.title")?.value;
  const sub = [title && clip(text(title), 90), S.company, S.domain, [S.city, S.state].filter(Boolean).join(", ")].filter(Boolean);
  const chips = [
    R.ranAt && `Run ${when(R.ranAt)}`,
    R.seconds != null && `${R.seconds} s`,
    `<b>${R.rows.length.toLocaleString("en-US")}</b> findings`,
    `<b>${filled}</b> of ${R.variables.length} variables filled`,
    `<b>${hosts.size}</b> source sites`,
    `<b>${modsRan}</b> of ${R.modules.length} modules ran`,
    `<b>${Number(R.http.calls || 0).toLocaleString("en-US")}</b> calls`,
    `<b>${Number(R.http.blocked || 0)}</b> blocked`,
  ].filter(Boolean);
  const fillBars = tabList
    .filter((t) => (t.kind === "var" || t.kind === "pics") && R.variables.some((v) => v.tab === t.id))
    .map((t) => {
      const vs = R.variables.filter((v) => v.tab === t.id);
      const f = vs.filter((v) => byVar.has(v.id)).length;
      const pct = vs.length ? Math.round((f / vs.length) * 100) : 0;
      return `<a class="fb" href="#${esc(t.id)}"><span class="fl">${esc(t.label)}</span><span class="fn">${f}/${vs.length}</span><span class="ft"><i style="width:${pct}%;background:${t.color}"></i></span></a>`;
    })
    .join("");

  // ---- snapshot
  const tiles = [];
  const tile = (cls, k, r, v, note) =>
    tiles.push(
      `<div class="tile ${cls}"><div class="k">${esc(k)}</div><div class="v">${esc(clip(v ?? text(r.value), 110))}</div><div class="n">${gradeChip(r.grade)} <span>${esc(note ?? [hostOf(r.url) || r.module, r.id].filter(Boolean).join(" · "))}</span></div></div>`
    );
  const add = (cls, k, id) => {
    const r = best(id);
    if (r) tile(cls, k, r);
  };
  add("pro", "Title", "role.title");
  add("pro", "In the seat since", "role.start");
  const scale = best("co.arr") || best("co.facts");
  if (scale) tile("biz", scale.var === "co.arr" ? "Company ARR" : "Company financials", scale);
  add("biz", "Named growth priority", "co.growth_line");
  const dons = byVar.get("politics.donations");
  if (dons) {
    const totals = dons.map((r) => Number(r.detail?.total)).filter(Number.isFinite);
    const amounts = dons.map(amountOf).filter((n) => n != null);
    const total = totals.length ? Math.max(...totals) : amounts.reduce((a, b) => a + b, 0);
    const count = totals.length ? Number(dons.find((r) => Number.isFinite(Number(r.detail?.total)))?.detail?.count) || dons.length : dons.length;
    tile("pol", "Political giving", dons[0], total > 0 ? `${money(total)} on record` : null, `${count} record${count === 1 ? "" : "s"} · ${hostOf(dons[0].url) || dons[0].module}`);
  }
  const accts = byVar.get("social.accounts");
  if (accts) {
    const where = [...new Set(accts.map((r) => hostOf(r.url)).filter(Boolean))].slice(0, 5).join(", ");
    tile("social", "Public accounts", accts[0], `${accts.length} account${accts.length === 1 ? "" : "s"}`, where || accts[0].module);
  }
  add("social", "Home metro", "place.home_metro");
  add("pro", "Education", "career.education");
  add("money", "Pay", "money.comp");

  const cands = [...(byVar.get("social.candidates") || []), ...(accts || [])];
  const verdictOf = (r) => String(r.detail?.verdict || { v: "verified", p: "partly", n: "namesake" }[r.grade] || "unconfirmed").toLowerCase();
  const vc = { verified: 0, partly: 0, namesake: 0 };
  for (const r of cands) {
    const v = verdictOf(r);
    if (v in vc) vc[v]++;
  }
  const photo = safeUrl(S.photo) || safeUrl(best("pic.headshot")?.image);
  const where = [S.city, S.state].filter(Boolean).join(", ") || (best("place.home_metro") ? text(best("place.home_metro").value) : "");
  const who = `<div class="who">
    ${photo ? `<img class="avatar" src="${esc(photo)}" alt="" referrerpolicy="no-referrer" loading="lazy">` : `<div class="avatar">${esc(initials(S.name))}</div>`}
    <h2>${esc(S.name)}</h2>
    ${title ? `<p>${esc(clip(text(title), 80))}</p>` : ""}${S.company ? `<p>${esc(S.company)}${S.ticker ? ` (${esc(S.ticker)})` : ""}</p>` : ""}${where ? `<p>${esc(clip(where, 60))}</p>` : ""}
    <div class="idscore"><b>${cands.length}</b> accounts checked<div class="idb">${vc.verified} verified · ${vc.partly} partly · ${vc.namesake} namesake${vc.namesake === 1 ? "" : "s"}</div></div>
  </div>`;
  const tilesHtml = tiles.length
    ? `<div class="tiles">${tiles.join("")}</div>`
    : `<div class="nofind"><b>No findings in this run.</b> The Gaps tab lists every variable, what each module searched for, and which free keys unlock more modules.</div>`;

  // ---- tabs, toolbar, panels
  const nav = tabList
    .map((t, i) => `<button type="button" role="tab" id="t-${esc(t.id)}" aria-controls="p-${esc(t.id)}" aria-selected="${i === 0}" data-tab="${esc(t.id)}"${i < 9 ? ` title="Key ${i + 1}"` : ""}><i class="sw" style="background:${t.color}"></i>${esc(t.label)}<span class="count"></span></button>`)
    .join("");
  const tierBoxes = [["A", "A Registry / API"], ["B", "B Scored match"], ["C", "C Agent read"], ["D", "D Estimate"], ["E", "E From you"]]
    .map(([k, l]) => `<label><input type="checkbox" data-tier="${k}" checked><span class="tier t-${k}">${l}</span></label>`)
    .join("");
  const gradeBoxes = Object.keys(GRADE_NAME)
    .map((g) => `<label><input type="checkbox" data-grade="${g}" checked>${gradeChip(g)}</label>`)
    .join("");
  const panels = tabList.map((t, i) => `<section class="panel${i === 0 ? " on" : ""}" id="p-${esc(t.id)}" role="tabpanel" aria-labelledby="t-${esc(t.id)}" data-kind="${t.kind}"><h2 class="ptitle">${esc(t.label)}</h2><div class="pb"></div></section>`).join("\n");

  const data = { ...R, tabList };
  const json = JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const js = `(${client.toString()})();`;
  const hash = createHash("sha256").update(js).digest("base64");
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src https: http:; script-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<title>OSINT dossier · ${esc(S.name)}${S.company ? " · " + esc(S.company) : ""}</title>
<style>${CSS}</style>
</head>
<body>
<header class="top"><div class="wrap">
  <div class="eyebrow">Diligence room · OSINT dossier · every line ties back to a ledger row</div>
  <h1>${esc(S.name)}</h1>
  ${sub.length ? `<div class="sub">${sub.map(esc).join(" · ")}</div>` : ""}
  <div class="chips">${chips.map((c) => `<span class="chip">${c}</span>`).join("")}</div>
  ${fillBars ? `<div class="fills"><div class="fh">Variables filled, by tab</div><div class="fbs">${fillBars}</div></div>` : ""}
</div></header>
<main class="wrap">
  <div class="card snap">${who}<div>${tilesHtml}</div></div>
  <nav class="tabs" role="tablist" id="tabs" aria-label="Dossier sections">${nav}</nav>
  <div class="toolbar" id="toolbar">
    <input id="q" type="search" placeholder="Filter values, variables, modules, sources…  ( / )" aria-label="Filter findings" autocomplete="off">
    <label class="strong"><input type="checkbox" id="strong"> Only verified or partly</label>
    <button type="button" id="reset" class="ghost">Reset</button>
    <span class="hint">Keys: <kbd>/</kbd> filter · <kbd>1</kbd>–<kbd>9</kbd> tabs · <kbd>[</kbd> <kbd>]</kbd> prev/next</span>
    <div class="row2"><span class="lbl">Tier</span>${tierBoxes}</div>
    <div class="row2"><span class="lbl">Grade</span>${gradeBoxes}</div>
  </div>
  <div id="status" class="status" aria-live="polite"></div>
${panels}
  <noscript><p class="note">This page renders its tabs with JavaScript. The full result is also in osint.json and ledger.jsonl next to this file.</p></noscript>
  <footer>Grades: Verified = a primary record or two independent sources agree · Partly = one good source · Weak = thin or indirect · Inference = reasoned from other findings · None found = searched and empty · Not public = known to exist but not published. Tiers: A = an official registry or API read directly · B = an automated hit that passed the identity score · C = an agent read public pages and cited them · D = an estimate with its inputs shown · E = something only you know. Generated by <code>npm run osint</code>.</footer>
</main>
<script type="application/json" id="osint-data">${json}</script>
<script>${js}</script>
</body>
</html>
`;
}

// ------------------------------------------------------------------------------------------
// Browser side. Serialised with toString(), so it must stay self-contained (no imports, no
// closure over module scope). All data goes through esc() before it touches innerHTML.
function client() {
  "use strict";
  const D = JSON.parse(document.getElementById("osint-data").textContent);
  const $ = (id) => document.getElementById(id);
  const GN = { v: "Verified", p: "Partly verified", w: "Weak", i: "Inference", u: "Unknown", np: "Not public", n: "None found" };
  const GR = { v: 0, p: 1, i: 2, w: 3, u: 4, np: 5, n: 6 };
  const TR = { A: 0, B: 1, C: 2, D: 3, E: 4 };
  const ACCT = new Set(["social.candidates", "social.accounts"]);
  const PAGE = 400;
  const MORE = 12;
  const ENT = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ENT[c]);
  const safeUrl = (u) => {
    if (!u) return null;
    try {
      const x = new URL(String(u));
      return x.protocol === "https:" || x.protocol === "http:" ? x.href : null;
    } catch (e) {
      return null;
    }
  };
  const host = (u) => {
    try {
      return new URL(String(u)).host.replace(/^www\./, "");
    } catch (e) {
      return "";
    }
  };
  const link = (u, label) => {
    const s = safeUrl(u);
    if (!s) return label ? esc(label) : "";
    return '<a href="' + esc(s) + '" target="_blank" rel="noopener noreferrer">' + esc(label || host(s)) + "</a>";
  };
  const txt = (v) => (v == null ? "" : typeof v === "string" ? v : typeof v === "number" ? v.toLocaleString("en-US") : typeof v === "boolean" ? (v ? "yes" : "no") : JSON.stringify(v));
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
  const fmtMs = (ms) => (ms == null || ms === "" ? "" : ms < 1000 ? Math.round(ms) + " ms" : (ms / 1000).toFixed(1) + " s");
  const grade = (g) => '<span class="grade g-' + esc(GR[g] != null ? g : "u") + '">' + esc(GN[g] || "Unknown") + "</span>";
  const tier = (t) => '<span class="tier t-' + esc(TR[t] != null ? t : "E") + '" title="Tier ' + esc(t) + '">' + esc(t) + "</span>";
  const byBest = (a, b) => (GR[a.grade] ?? 9) - (GR[b.grade] ?? 9) || (TR[a.tier] ?? 9) - (TR[b.tier] ?? 9) || String(a.id).localeCompare(String(b.id));
  const humanKey = (k) => String(k).replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");

  const tabs = D.tabList;
  const tabById = new Map(tabs.map((t) => [t.id, t]));
  const varTabIds = new Set(tabs.filter((t) => t.kind === "var" || t.kind === "pics").map((t) => t.id));
  const colorOf = (tabId) => (tabById.get(tabId) || tabById.get("other") || { color: "#8c96a1" }).color;
  const labelOf = (tabId) => (tabById.get(tabId) || { label: tabId }).label;
  const rows = D.rows;
  rows.forEach((r, i) => (r._i = i));
  const allByVar = new Map();
  for (const r of rows) (allByVar.get(r.var) || allByVar.set(r.var, []).get(r.var)).push(r);
  const varMeta = new Map(D.variables.map((v) => [v.id, v]));
  const missByVar = new Map();
  for (const m of D.misses) (missByVar.get(m.var) || missByVar.set(m.var, []).get(m.var)).push(m);

  for (const t of tabs) {
    if (t.kind === "var") t.rows = rows.filter((r) => r.tab === t.id);
    else if (t.kind === "pics") t.rows = rows.filter((r) => r.tab === t.id || safeUrl(r.image));
    else if (t.kind === "other") t.rows = rows.filter((r) => !varTabIds.has(r.tab));
    else if (t.kind === "accounts") t.rows = rows.filter((r) => ACCT.has(r.var));
    else if (t.kind === "timeline") t.rows = rows.filter((r) => r.date);
    else if (t.kind === "sources") t.rows = rows;
    else t.rows = null;
  }

  const st = { tab: tabs[0] && tabs[0].id, q: [], tiers: new Set(["A", "B", "C", "D", "E"]), grades: new Set(Object.keys(GN)), strong: false, done: {}, more: new Set(), sort: { k: "id", d: 1 }, tlAsc: false, print: false };
  const sText = (r) => r._s || (r._s = [r.id, r.module, r.var, r.label, r.group, txt(r.value), r.url, r.date, r.detail ? JSON.stringify(r.detail) : "", r.anchors ? JSON.stringify(r.anchors) : ""].join(" ").toLowerCase());
  const filtering = () => st.q.length || st.strong || st.tiers.size < 5 || st.grades.size < Object.keys(GN).length;
  const passes = (r) => {
    if (st.strong && r.grade !== "v" && r.grade !== "p") return false;
    if (!st.grades.has(r.grade)) return false;
    if (TR[r.tier] != null && !st.tiers.has(r.tier)) return false;
    if (st.q.length) {
      const s = sText(r);
      for (const w of st.q) if (!s.includes(w)) return false;
    }
    return true;
  };
  const qPass = (s) => !st.q.length || st.q.every((w) => s.toLowerCase().includes(w));

  // ---------------------------------------------------------------- building blocks
  function cell(x) {
    if (x == null || x === "") return '<span class="mute">–</span>';
    if (typeof x === "string") return safeUrl(x) && /^https?:\/\//i.test(x) ? link(x) : esc(clip(x, 400));
    if (typeof x === "number") return esc(x.toLocaleString("en-US"));
    if (typeof x === "boolean") return x ? "yes" : "no";
    if (Array.isArray(x) && x.every((y) => y == null || typeof y !== "object")) return x.map(cell).join(", ");
    return '<code class="js">' + esc(clip(JSON.stringify(x), 300)) + "</code>";
  }
  function detailHtml(d, depth) {
    if (d == null || d === "") return "";
    if (typeof d !== "object") return '<div class="dtx">' + cell(d) + "</div>";
    if (Array.isArray(d)) {
      if (!d.length) return "";
      if (d.every((x) => x && typeof x === "object" && !Array.isArray(x))) return miniTable(d);
      return '<ul class="dli">' + d.slice(0, 60).map((x) => "<li>" + cell(x) + "</li>").join("") + (d.length > 60 ? "<li class=mute>+" + (d.length - 60) + " more</li>" : "") + "</ul>";
    }
    const keys = Object.keys(d).filter((k) => d[k] != null && d[k] !== "" && !(Array.isArray(d[k]) && !d[k].length) && !(depth === 0 && (k === "title" || k === "image")));
    if (!keys.length) return "";
    const simple = keys.length <= 6 && keys.every((k) => d[k] == null || (typeof d[k] !== "object" && String(d[k]).length < 70));
    if (simple) return '<div class="kvi">' + keys.map((k) => "<span><i>" + esc(humanKey(k)) + "</i> " + cell(d[k]) + "</span>").join("") + "</div>";
    return (
      '<dl class="kv">' +
      keys
        .slice(0, 40)
        .map((k) => {
          const v = d[k];
          const deep = v && typeof v === "object" && depth < 2 && !(Array.isArray(v) && v.every((y) => y == null || typeof y !== "object"));
          return "<dt>" + esc(humanKey(k)) + "</dt><dd>" + (deep ? detailHtml(v, depth + 1) : cell(v)) + "</dd>";
        })
        .join("") +
      "</dl>"
    );
  }
  function miniTable(arr) {
    const keys = [];
    for (const o of arr.slice(0, 50)) for (const k of Object.keys(o)) if (!keys.includes(k) && keys.length < 8) keys.push(k);
    const lim = st.print ? arr.length : 40;
    return (
      '<div class="mt"><table><thead><tr>' +
      keys.map((k) => "<th>" + esc(humanKey(k)) + "</th>").join("") +
      "</tr></thead><tbody>" +
      arr
        .slice(0, lim)
        .map((o) => "<tr>" + keys.map((k) => "<td>" + cell(o[k]) + "</td>").join("") + "</tr>")
        .join("") +
      "</tbody></table>" +
      (arr.length > lim ? '<div class="mute small">+' + (arr.length - lim) + " more rows in osint.json</div>" : "") +
      "</div>"
    );
  }
  function anchorChips(a) {
    const arr = Array.isArray(a) ? a : a ? [a] : [];
    if (!arr.length) return "";
    return (
      '<div class="bits">' +
      arr
        .slice(0, 24)
        .map((x) => {
          let label;
          let neg = false;
          if (x && typeof x === "object") {
            const w = x.w ?? x.weight ?? x.points ?? x.score;
            const name = x.label || x.kind || x.type || x.name || x.anchor || "";
            const val = x.value ?? x.match ?? x.text ?? "";
            label = [name, typeof val === "object" ? JSON.stringify(val) : val].filter((s) => s !== "" && s != null).join(": ") + (w != null && w !== "" ? " " + (Number(w) > 0 ? "+" : "") + w : "");
            neg = Number(w) < 0 || x.ok === false || x.match === false;
          } else {
            label = String(x);
            neg = /^[-−]/.test(label) || /\b(mismatch|differs|conflict)\b/i.test(label);
          }
          return '<span class="bit' + (neg ? " neg" : "") + '">' + esc(clip(label || "anchor", 90)) + "</span>";
        })
        .join("") +
      "</div>"
    );
  }
  function meta(r, opts) {
    opts = opts || {};
    const s = safeUrl(r.url);
    return (
      '<div class="meta">' +
      grade(r.grade) +
      tier(r.tier) +
      (s ? '<a class="src" href="' + esc(s) + '" target="_blank" rel="noopener noreferrer">' + esc(host(s)) + "</a>" : '<span class="mute">no link</span>') +
      '<span class="led">' + esc(r.id) + "</span>" +
      '<span class="mod">' + esc(r.module) + "</span>" +
      (opts.tab ? '<span class="tb" style="--c:' + colorOf(r.tab) + '">' + esc(labelOf(r.tab)) + "</span>" : "") +
      (r.date ? '<span class="dte">' + esc(r.date) + "</span>" : "") +
      (r.ms != null ? '<span class="ms">' + esc(fmtMs(r.ms)) + "</span>" : "") +
      "</div>"
    );
  }
  function finding(r) {
    const v = txt(r.value);
    const img = safeUrl(r.image);
    const title = r.detail && typeof r.detail === "object" && !Array.isArray(r.detail) && typeof r.detail.title === "string" ? r.detail.title : "";
    return (
      '<div class="f">' +
      (img ? '<img class="fi" loading="lazy" referrerpolicy="no-referrer" alt="" src="' + esc(img) + '">' : "") +
      '<div class="fv">' + esc(st.print ? v : clip(v, 700)) + "</div>" +
      (title && title !== v ? '<div class="ftl">' + esc(clip(title, 200)) + "</div>" : "") +
      detailHtml(r.detail, 0) +
      anchorChips(r.anchors) +
      meta(r) +
      "</div>"
    );
  }
  function emptyList(vars, title, open) {
    if (!vars.length) return "";
    return (
      '<details class="empty"' + (st.print || open ? " open" : "") + "><summary>" + esc(title) + " · " + plural(vars.length, "variable") + "</summary><ul>" +
      vars
        .map((v) => {
          const ms = missByVar.get(v.id) || [];
          return (
            "<li><b>" + esc(v.label || v.id) + "</b> <code>" + esc(v.id) + "</code>" +
            (ms.length
              ? '<div class="searched">' + ms.map((m) => '<span class="mod">' + esc(m.module) + "</span> " + esc(txt(m.searched))).join("<br>") + "</div>"
              : '<div class="searched mute">No module searched for this in this run.</div>') +
            "</li>"
          );
        })
        .join("") +
      "</ul></details>"
    );
  }

  // ---------------------------------------------------------------- tab renderers
  function varsFor(t) {
    const list = D.variables.filter((v) => v.tab === t.id || (t.kind === "other" && !varTabIds.has(v.tab)));
    const known = new Set(list.map((v) => v.id));
    for (const r of t.rows) if (!known.has(r.var) && !(t.kind === "pics" && r.tab !== t.id)) {
      known.add(r.var);
      list.push({ id: r.var, label: r.label || r.var, group: r.group || "Other findings", tab: r.tab });
    }
    return list;
  }
  function renderVarTab(t) {
    let html = "";
    if (t.kind === "pics") html += renderPics(t);
    const vars = varsFor(t);
    const inTab = (r) => r.tab === t.id || t.kind === "other";
    const groups = new Map();
    const empty = [];
    let hidden = 0;
    for (const v of vars) {
      const all = (allByVar.get(v.id) || []).filter(inTab);
      if (!all.length) {
        if (qPass(v.label + " " + v.id + " " + (missByVar.get(v.id) || []).map((m) => txt(m.searched)).join(" "))) empty.push(v);
        continue;
      }
      const shown = all.filter(passes).sort(byBest);
      if (!shown.length) {
        hidden++;
        continue;
      }
      const g = v.group || "Other findings";
      (groups.get(g) || groups.set(g, []).get(g)).push({ v, rows: shown, total: all.length });
    }
    if (!groups.size && !empty.length && t.kind !== "pics") html += '<div class="card blank">' + (hidden ? "Nothing in this tab matches the filter." : "No variables in this tab.") + "</div>";
    for (const [g, items] of groups) {
      const nRows = items.reduce((a, x) => a + x.rows.length, 0);
      html += '<div class="grp"><h3>' + esc(g) + "<span>" + plural(items.length, "variable") + " · " + plural(nRows, "finding") + "</span></h3><div class=\"card vlist\">";
      for (const it of items) {
        const open = st.print || st.more.has(it.v.id);
        const list = open ? it.rows : it.rows.slice(0, MORE);
        html +=
          '<div class="var"><div class="vh"><b>' + esc(it.v.label || it.v.id) + "</b><code>" + esc(it.v.id) + '</code><div class="vc">' + grade(it.rows[0].grade) + " " + plural(it.rows.length, "finding") +
          (it.rows.length < it.total ? ' <span class="mute">(' + it.total + " before filter)</span>" : "") +
          '</div></div><div class="fs">' + list.map(finding).join("") +
          (list.length < it.rows.length ? '<button type="button" class="more" data-more="' + esc(it.v.id) + '">Show ' + (it.rows.length - list.length) + " more</button>" : "") +
          "</div></div>";
      }
      html += "</div></div>";
    }
    if (hidden) html += '<p class="note">' + plural(hidden, "variable") + " with findings hidden by the filter.</p>";
    html += emptyList(empty, "Searched, none found", !groups.size);
    return html;
  }
  function renderPics(t) {
    const imgs = t.rows.filter((r) => safeUrl(r.image) && passes(r)).sort(byBest);
    if (!imgs.length) return '<div class="card blank">No pictures' + (filtering() ? " match the filter." : " in this run.") + "</div>";
    return (
      '<div class="pics">' +
      imgs
        .map((r) => {
          const href = safeUrl(r.url) || safeUrl(r.image);
          const title = (r.detail && typeof r.detail.title === "string" && r.detail.title) || txt(r.value) || r.label;
          return (
            '<a class="thumb" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer" title="' + esc(clip(title, 300)) + '">' +
            '<span class="ph"><img loading="lazy" referrerpolicy="no-referrer" alt="' + esc(clip(title, 120)) + '" src="' + esc(safeUrl(r.image)) + '"></span>' +
            '<span class="cap"><b>' + esc(host(href)) + "</b>" + esc(clip(title, 110)) + '</span><span class="cm">' + grade(r.grade) + '<span class="led">' + esc(r.id) + "</span></span></a>"
          );
        })
        .join("") +
      "</div>"
    );
  }
  function renderAccounts(t) {
    const list = t.rows.filter(passes);
    const score = (r) => {
      const n = Number(r.detail && (r.detail.score ?? r.detail.identity_score));
      return Number.isFinite(n) ? n : null;
    };
    const verdict = (r) => String((r.detail && r.detail.verdict) || { v: "verified", p: "partly", n: "namesake" }[r.grade] || "unconfirmed").toLowerCase();
    list.sort((a, b) => (score(b) ?? -99) - (score(a) ?? -99) || byBest(a, b));
    const cnt = {};
    for (const r of list) cnt[verdict(r)] = (cnt[verdict(r)] || 0) + 1;
    const S = D.subject;
    const searched = [S.name].concat(S.aliases || [], (S.handles || []).map((h) => "@" + h)).filter(Boolean);
    let html =
      '<p class="note">Every account a module found for this name, scored on independent anchors (photo, employer, city, links from an official page). Verified and partly verified accounts are the ones to read; namesakes are kept so you can see what was ruled out. Searched as: ' +
      searched.map((s) => "<b>" + esc(s) + "</b>").join(", ") + ".</p>" +
      '<div class="legend">' + Object.keys(cnt).map((k) => '<span class="vd v-' + esc(k.replace(/[^a-z]/g, "")) + '">' + esc(k) + " " + cnt[k] + "</span>").join("") + "</div>";
    if (!list.length) return html + '<div class="card blank">No candidate accounts' + (filtering() ? " match the filter." : " in this run.") + "</div>";
    const max = Math.max(10, ...list.map((r) => Math.abs(score(r) || 0)));
    html +=
      '<div class="card scroll"><table class="tbl"><thead><tr><th>Account</th><th>Platform</th><th>Score</th><th>Verdict</th><th>Anchors</th><th>Source</th></tr></thead><tbody>' +
      list
        .map((r) => {
          const d = r.detail && typeof r.detail === "object" && !Array.isArray(r.detail) ? r.detail : {};
          const sc = score(r);
          const v = verdict(r);
          const col = v === "verified" ? "#2e7d4f" : v === "partly" ? "#7fb069" : v === "namesake" ? "#b0473c" : "#d99a2b";
          const extra = Object.assign({}, d);
          for (const k of ["score", "identity_score", "verdict", "platform", "site", "handle", "username", "title", "image"]) delete extra[k];
          return (
            '<tr><td class="val"><b>' + esc(clip(txt(r.value), 160)) + "</b>" + (d.handle || d.username ? "<small>@" + esc(d.handle || d.username) + "</small>" : "") + detailHtml(extra, 1) + "</td>" +
            "<td>" + esc(d.platform || d.site || host(r.url)) + "</td>" +
            '<td class="nowrap">' + (sc == null ? '<span class="mute">–</span>' : '<span class="meter"><i style="width:' + Math.max(4, Math.min(100, ((sc + max) / (2 * max)) * 100)) + "%;background:" + col + '"></i></span><b>' + esc((sc > 0 ? "+" : "") + sc) + "</b>") + "</td>" +
            '<td><span class="vd v-' + esc(v.replace(/[^a-z]/g, "")) + '">' + esc(v) + "</span></td>" +
            "<td>" + (anchorChips(r.anchors) || '<span class="mute">–</span>') + "</td>" +
            "<td>" + meta(r) + "</td></tr>"
          );
        })
        .join("") +
      "</tbody></table></div>";
    return html;
  }
  function renderTimeline(t) {
    const key = (r) => String(r.date).slice(0, 10);
    const list = t.rows.filter(passes).sort((a, b) => (st.tlAsc ? 1 : -1) * key(a).localeCompare(key(b)) || byBest(a, b));
    const used = [...new Set(list.map((r) => r.tab))];
    let html =
      '<div class="tlbar"><button type="button" class="ghost" data-tl="1">' + (st.tlAsc ? "Oldest first ↑" : "Newest first ↓") + "</button>" +
      '<div class="legend">' + used.map((id) => '<span><i class="p" style="background:' + colorOf(id) + '"></i>' + esc(labelOf(id)) + "</span>").join("") + "</div></div>";
    if (!list.length) return html + '<div class="card blank">No dated findings' + (filtering() ? " match the filter." : " in this run.") + "</div>";
    const lim = st.print || st.more.has("#timeline") ? list.length : PAGE;
    let year = null;
    html += '<div class="card timeline">';
    for (const r of list.slice(0, lim)) {
      const y = key(r).slice(0, 4);
      if (y !== year) {
        year = y;
        html += '<div class="yr">' + esc(y) + "</div>";
      }
      html +=
        '<div class="tl"><div class="d">' + esc(key(r)) + '</div><i class="p" style="background:' + colorOf(r.tab) + '"></i><div><div class="tt"><b>' + esc(r.label || r.var) + "</b> " + esc(clip(txt(r.value), 260)) + "</div>" + meta(r, { tab: true }) + "</div></div>";
    }
    html += "</div>";
    if (lim < list.length) html += '<button type="button" class="more" data-more="#timeline">Show all ' + list.length + "</button>";
    return html;
  }
  function renderSources(t) {
    const list = t.rows.filter(passes);
    const k = st.sort.k;
    const val = (r) => (k === "grade" ? GR[r.grade] ?? 9 : k === "tier" ? TR[r.tier] ?? 9 : k === "ms" ? Number(r.ms) || 0 : k === "host" ? host(r.url) : k === "value" ? txt(r.value).toLowerCase() : String(r[k] ?? ""));
    list.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return st.sort.d * (typeof x === "number" ? x - y : String(x).localeCompare(String(y))) || a._i - b._i;
    });
    const lim = st.print || st.more.has("#sources") ? list.length : PAGE;
    const th = (key, label) => '<th><button type="button" class="sort' + (k === key ? " on" : "") + '" data-sort="' + key + '">' + label + (k === key ? (st.sort.d > 0 ? " ↑" : " ↓") : "") + "</button></th>";
    const hostsN = new Set(list.map((r) => host(r.url)).filter(Boolean)).size;
    let html = '<p class="note">The tie-back: every finding in this dossier is one row in <code>ledger.jsonl</code>. ' + plural(list.length, "row") + " from " + plural(hostsN, "site") + ". Click a column to sort.</p>";
    if (!list.length) return html + '<div class="card blank">No ledger rows' + (filtering() ? " match the filter." : " in this run.") + "</div>";
    html +=
      '<div class="card scroll"><table class="tbl src"><thead><tr>' + th("id", "Ledger") + th("module", "Module") + th("var", "Variable") + th("value", "Value") + th("host", "Source") + th("grade", "Grade") + th("tier", "Tier") + th("ms", "Time") + th("date", "Date") + "</tr></thead><tbody>" +
      list
        .slice(0, lim)
        .map((r) => {
          const s = safeUrl(r.url);
          return (
            '<tr><td class="led">' + esc(r.id) + '</td><td><span class="mod">' + esc(r.module) + "</span></td><td><code>" + esc(r.var) + '</code><small class="tb" style="--c:' + colorOf(r.tab) + '">' + esc(labelOf(r.tab)) + "</small></td>" +
            '<td class="sv">' + esc(clip(txt(r.value), 160)) + "</td><td>" + (s ? '<a href="' + esc(s) + '" target="_blank" rel="noopener noreferrer" title="' + esc(s) + '">' + esc(host(s)) + "</a>" : '<span class="mute">–</span>') + "</td>" +
            "<td>" + grade(r.grade) + "</td><td>" + tier(r.tier) + '</td><td class="ms">' + esc(fmtMs(r.ms)) + '</td><td class="led">' + esc(r.date || "") + "</td></tr>"
          );
        })
        .join("") +
      "</tbody></table></div>";
    if (lim < list.length) html += '<button type="button" class="more" data-more="#sources">Show all ' + list.length + " rows</button>";
    return html;
  }
  function renderGaps() {
    const empty = D.variables.filter((v) => !allByVar.has(v.id));
    let html = '<p class="note"><b>' + empty.length + "</b> of " + D.variables.length + " variables have no finding. First, the modules that would do more with a free key or did not finish; then each empty variable with what was searched for it.</p>";
    const keyed = D.modules.filter((m) => Array.isArray(m.env) && m.env.length && qPass(m.id + " " + m.env.join(" ")));
    const skipped = D.modules.filter((m) => m.status === "skipped" && qPass(m.id + " " + (m.why || "")));
    const failed = D.modules.filter((m) => (m.status === "error" || m.status === "timeout") && qPass(m.id + " " + (m.error || "")));
    html += '<div class="grp"><h3>Unlock more<span>free keys go in .env</span></h3><div class="card scroll">';
    html += keyed.length
      ? '<table class="tbl"><thead><tr><th>Module</th><th>Status</th><th>Set this</th><th>Rows this run</th></tr></thead><tbody>' +
        keyed.map((m) => "<tr><td><b>" + esc(m.label || m.id) + "</b><code class=\"cid\">" + esc(m.id) + "</code></td><td>" + statusChip(m.status) + "</td><td>" + m.env.map((e) => '<code class="env">' + esc(e) + "=…</code>").join(" ") + "</td><td>" + esc(m.found ?? 0) + "</td></tr>").join("") +
        "</tbody></table>"
      : '<div class="blank">No module is waiting on a key.</div>';
    html += "</div></div>";
    if (skipped.length || failed.length) {
      html += '<div class="grp"><h3>Skipped or failed<span>' + plural(skipped.length + failed.length, "module") + '</span></h3><div class="card scroll"><table class="tbl"><thead><tr><th>Module</th><th>Status</th><th>Why</th></tr></thead><tbody>' +
        skipped.concat(failed).map((m) => "<tr><td><b>" + esc(m.label || m.id) + "</b><code class=\"cid\">" + esc(m.id) + "</code></td><td>" + statusChip(m.status) + "</td><td>" + esc(m.why || m.error || "") + "</td></tr>").join("") +
        "</tbody></table></div></div>";
    }
    const tabsWith = tabs.filter((t) => t.kind === "var" || t.kind === "pics" || t.kind === "other");
    let any = false;
    for (const t of tabsWith) {
      const vs = empty.filter((v) => (t.kind === "other" ? !varTabIds.has(v.tab) : v.tab === t.id)).filter((v) => qPass(v.label + " " + v.id + " " + (missByVar.get(v.id) || []).map((m) => txt(m.searched)).join(" ")));
      if (!vs.length) continue;
      vs.sort((x, y) => (missByVar.has(y.id) ? 1 : 0) - (missByVar.has(x.id) ? 1 : 0));
      any = true;
      html += '<div class="grp"><h3><i class="sw" style="background:' + t.color + '"></i>' + esc(t.label) + "<span>" + plural(vs.length, "gap") + '</span></h3><div class="card gl">' +
        vs
          .map((v) => {
            const ms = missByVar.get(v.id) || [];
            return '<div class="gv"><div><b>' + esc(v.label) + "</b><code>" + esc(v.id) + "</code></div><div>" +
              (ms.length ? ms.map((m) => '<div class="searched"><span class="mod">' + esc(m.module) + "</span> " + esc(txt(m.searched)) + "</div>").join("") : '<div class="searched mute">Not searched by any module in this run.</div>') +
              "</div></div>";
          })
          .join("") + "</div></div>";
    }
    if (!any) html += '<div class="card blank">' + (empty.length ? "No gaps match the filter." : "Every variable has at least one finding.") + "</div>";
    return html;
  }
  function statusChip(s) {
    return '<span class="stc s-' + esc(String(s || "ok").replace(/[^a-z]/g, "")) + '">' + esc(s || "ok") + "</span>";
  }
  function renderRun() {
    const mods = D.modules.filter((m) => qPass([m.id, m.label, m.lane, m.status, m.error, m.why].join(" ")));
    const order = { fast: 0, sweep: 1, slow: 2, late: 3 };
    mods.sort((a, b) => (order[a.lane] ?? 9) - (order[b.lane] ?? 9) || (b.ms || 0) - (a.ms || 0));
    const maxMs = Math.max(1, ...D.modules.map((m) => m.ms || 0));
    const c = {};
    for (const m of D.modules) c[m.status || "ok"] = (c[m.status || "ok"] || 0) + 1;
    const stat = (n, l) => '<div class="stat"><b>' + esc(n) + "</b><span>" + esc(l) + "</span></div>";
    let html =
      '<div class="stats card">' + stat(D.seconds != null ? D.seconds + " s" : "–", "wall time") + stat(D.modules.length, "modules") + stat(c.ok || 0, "ok") + stat((c.error || 0) + (c.timeout || 0), "errors / timeouts") + stat(c.skipped || 0, "skipped") +
      stat((D.http.calls || 0).toLocaleString("en-US"), "HTTP calls") + stat(D.http.blocked || 0, "blocked (403/429/999)") + stat(rows.length.toLocaleString("en-US"), "ledger rows") + "</div>";
    if (!mods.length) return html + '<div class="card blank">No modules' + (st.q.length ? " match the filter." : " ran.") + "</div>";
    html +=
      '<div class="card scroll"><table class="tbl"><thead><tr><th>Module</th><th>Lane</th><th>Status</th><th>Time</th><th>Rows</th><th>Notes</th></tr></thead><tbody>' +
      mods
        .map(
          (m) =>
            "<tr><td><b>" + esc(m.label || m.id) + '</b><code class="cid">' + esc(m.id) + "</code></td><td>" + esc(m.lane || "") + "</td><td>" + statusChip(m.status) + "</td>" +
            '<td class="nowrap"><span class="meter sm"><i style="width:' + Math.max(1, Math.sqrt((m.ms || 0) / maxMs) * 100) + '%;background:#1d5a8c"></i></span><span class="ms">' + esc(fmtMs(m.ms || 0)) + "</span></td>" +
            '<td class="num">' + esc(m.found ?? 0) + "</td><td>" + esc(m.error || m.why || "") + (m.env && m.env.length ? ' <span class="mute">key not set:</span> ' + m.env.map((e) => '<code class="env">' + esc(e) + "</code>").join(" ") : "") + "</td></tr>"
        )
        .join("") +
      "</tbody></table></div>";
    return html;
  }

  // ---------------------------------------------------------------- wiring
  function render(t) {
    const body = $("p-" + t.id).querySelector(".pb");
    const k = t.kind;
    body.innerHTML = k === "var" || k === "pics" || k === "other" ? renderVarTab(t) : k === "accounts" ? renderAccounts(t) : k === "timeline" ? renderTimeline(t) : k === "sources" ? renderSources(t) : k === "gaps" ? renderGaps() : renderRun();
    st.done[t.id] = true;
  }
  function counts() {
    for (const t of tabs) {
      const b = $("t-" + t.id);
      if (!b) continue;
      let n;
      if (t.rows) n = filtering() ? t.rows.filter(passes).length : t.rows.length;
      else if (t.kind === "gaps") n = D.variables.filter((v) => !allByVar.has(v.id)).length;
      else n = D.modules.length;
      b.querySelector(".count").textContent = n.toLocaleString("en-US");
      b.classList.toggle("zero", !n);
    }
    const shown = filtering() ? rows.filter(passes).length : rows.length;
    $("status").textContent = filtering() ? "Filter on: " + shown.toLocaleString("en-US") + " of " + rows.length.toLocaleString("en-US") + " findings shown." : "";
  }
  function show(id, push) {
    const t = tabById.get(id) || tabs[0];
    if (!t) return;
    st.tab = t.id;
    for (const x of tabs) {
      const on = x.id === t.id;
      $("t-" + x.id).setAttribute("aria-selected", String(on));
      $("p-" + x.id).classList.toggle("on", on);
    }
    if (!st.done[t.id]) render(t);
    if (push !== false && location.hash.slice(1) !== t.id) history.replaceState(null, "", "#" + encodeURIComponent(t.id));
  }
  function refilter() {
    st.done = {};
    counts();
    const t = tabById.get(st.tab);
    if (t) render(t);
  }
  let timer = null;
  $("q").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      st.q = e.target.value.toLowerCase().split(/\s+/).filter(Boolean);
      refilter();
    }, 140);
  });
  $("strong").addEventListener("change", (e) => {
    st.strong = e.target.checked;
    refilter();
  });
  $("toolbar").addEventListener("change", (e) => {
    const el = e.target;
    if (el.dataset.tier) el.checked ? st.tiers.add(el.dataset.tier) : st.tiers.delete(el.dataset.tier);
    else if (el.dataset.grade) el.checked ? st.grades.add(el.dataset.grade) : st.grades.delete(el.dataset.grade);
    else return;
    refilter();
  });
  $("reset").addEventListener("click", () => {
    $("q").value = "";
    $("strong").checked = false;
    for (const el of document.querySelectorAll("#toolbar input[type=checkbox][data-tier],#toolbar input[type=checkbox][data-grade]")) el.checked = true;
    st.q = [];
    st.strong = false;
    st.tiers = new Set(["A", "B", "C", "D", "E"]);
    st.grades = new Set(Object.keys(GN));
    refilter();
  });
  $("tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (b) show(b.dataset.tab);
  });
  document.querySelector("main").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-more],button[data-sort],button[data-tl]");
    if (!b) return;
    if (b.dataset.more) st.more.add(b.dataset.more);
    else if (b.dataset.sort) st.sort = { k: b.dataset.sort, d: st.sort.k === b.dataset.sort ? -st.sort.d : 1 };
    else st.tlAsc = !st.tlAsc;
    render(tabById.get(st.tab));
  });
  document.addEventListener(
    "error",
    (e) => {
      const el = e.target;
      if (el && el.tagName === "IMG") {
        el.classList.add("broken");
        const a = el.closest(".thumb");
        if (a) a.classList.add("broken");
      }
    },
    true
  );
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (e.key === "Escape" && e.target.id === "q") {
      e.target.value = "";
      st.q = [];
      refilter();
      e.target.blur();
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "/") {
      e.preventDefault();
      $("q").focus();
      $("q").select();
    } else if (/^[1-9]$/.test(e.key) && tabs[Number(e.key) - 1]) {
      show(tabs[Number(e.key) - 1].id);
    } else if (e.key === "[" || e.key === "]") {
      const i = tabs.findIndex((t) => t.id === st.tab);
      const n = tabs[(i + (e.key === "]" ? 1 : tabs.length - 1)) % tabs.length];
      show(n.id);
      $("t-" + n.id).focus();
    }
  });
  window.addEventListener("hashchange", () => show(decodeURIComponent(location.hash.slice(1)), false));
  window.addEventListener("beforeprint", () => {
    st.print = true;
    for (const t of tabs) render(t);
    for (const d of document.querySelectorAll("details")) d.open = true;
  });
  window.addEventListener("afterprint", () => {
    st.print = false;
    st.done = {};
    show(st.tab, false);
  });

  counts();
  const start = decodeURIComponent(location.hash.slice(1));
  const gaps = tabs.find((t) => t.kind === "gaps");
  show(tabById.has(start) ? start : !rows.length && gaps ? gaps.id : tabs[0] && tabs[0].id, false);
}

const CSS = `
:root{--acc:#0f3d5a;--acc2:#1d5a8c;--paper:#f3f4f1;--surface:#fff;--sunk:#eceee9;--ink:#17202b;--ink2:#4a5563;--ink3:#5c6672;--rule:#d9dcd6;--rule2:#c4c8c1;
--g-v-ink:#1e5e3a;--g-v-bg:#e5f2e9;--g-p-ink:#3b6122;--g-p-bg:#edf5e5;--g-w-ink:#774c03;--g-w-bg:#fbefd8;--g-i-ink:#533f8e;--g-i-bg:#efebf8;--g-n-ink:#4a535e;--g-n-bg:#f0f2f3;--g-np-ink:#4a535e;--g-np-bg:#e3e6e9;
--serif:Charter,"Bitstream Charter","Iowan Old Style",Georgia,serif;--sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--mono:ui-monospace,Menlo,Consolas,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 var(--sans)}
a{color:var(--acc2)}a:hover{color:var(--acc)}
code{font:12px var(--mono);color:var(--ink3)}
kbd{font:11px var(--mono);border:1px solid var(--rule2);border-bottom-width:2px;border-radius:4px;padding:0 4px;background:#fff;color:var(--ink2)}
header.top{background:var(--acc);color:#fff;padding:28px 0 76px}
.wrap{max-width:1280px;margin:0 auto;padding:0 28px}
.eyebrow{font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.75}
h1{font:600 34px/1.15 var(--serif);margin:6px 0 6px;overflow-wrap:anywhere}
.sub{opacity:.88;font-size:15px;overflow-wrap:anywhere}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
.chip{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.22);border-radius:999px;padding:3px 11px;font-size:12.5px}
.fills{margin-top:18px}
.fh{font-size:11px;letter-spacing:.1em;text-transform:uppercase;opacity:.7;margin-bottom:6px}
.fbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:6px 18px}
.fb{display:grid;grid-template-columns:1fr auto;gap:2px 8px;color:#fff;text-decoration:none;font-size:12.5px;opacity:.95}
.fb:hover{opacity:1;color:#fff}.fb .fn{font:11.5px var(--mono);opacity:.8}
.fb .ft{grid-column:1/-1;height:6px;border-radius:99px;background:rgba(255,255,255,.18);overflow:hidden}
.fb .ft i{display:block;height:100%;border-radius:99px;filter:brightness(1.35) saturate(.9)}
main{margin-top:-60px;padding-bottom:60px}
.card{background:var(--surface);border:1px solid var(--rule);border-radius:14px;box-shadow:0 1px 2px rgba(15,61,90,.05),0 8px 24px rgba(15,61,90,.06)}
.snap{display:grid;grid-template-columns:250px 1fr;overflow:hidden}
.who{background:linear-gradient(160deg,#123f5d,#1d5a8c);color:#fff;padding:22px}
.avatar{width:84px;height:84px;border-radius:50%;background:#dfe7ee;color:var(--acc);display:grid;place-items:center;font:600 30px var(--serif);border:3px solid rgba(255,255,255,.5);object-fit:cover}
.who h2{font:600 21px/1.2 var(--serif);margin:12px 0 4px;overflow-wrap:anywhere}
.who p{margin:2px 0;font-size:13px;opacity:.9;overflow-wrap:anywhere}
.idscore{margin-top:14px;background:rgba(255,255,255,.1);border-radius:10px;padding:10px;font-size:12px}
.idscore b{font-size:22px;margin-right:4px}.idscore .idb{opacity:.85;margin-top:2px}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--rule);height:100%;align-content:start}
.tile{background:var(--surface);padding:16px 18px;min-height:112px}
.tile .k{font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink3)}
.tile .v{font:600 18px/1.3 var(--serif);margin:4px 0 6px;overflow-wrap:anywhere}
.tile .n{font-size:12px;color:var(--ink2);display:flex;gap:6px;align-items:baseline;flex-wrap:wrap}
.tile.social .k{color:#9b4d1f}.tile.pro .k{color:var(--acc2)}.tile.biz .k{color:var(--g-v-ink)}.tile.pol .k{color:#8b3a62}.tile.money .k{color:#7a5a00}
.nofind{padding:28px;font-size:15px;color:var(--ink2);max-width:640px}
nav.tabs{display:flex;gap:6px;margin:26px 0 12px;flex-wrap:wrap}
nav.tabs button{font:inherit;font-size:14px;border:1px solid var(--rule2);background:var(--surface);color:var(--ink2);padding:6px 13px;border-radius:999px;cursor:pointer;display:flex;align-items:center;gap:6px}
nav.tabs button:hover{border-color:var(--acc2)}
nav.tabs button:focus-visible{outline:2px solid var(--acc2);outline-offset:2px}
nav.tabs button[aria-selected=true]{background:var(--acc);border-color:var(--acc);color:#fff}
nav.tabs button.zero{opacity:.6}
nav.tabs .count{opacity:.75;font-size:12px;font-variant-numeric:tabular-nums}
.sw{display:inline-block;width:8px;height:8px;border-radius:50%;flex:none}
.toolbar{display:flex;gap:8px 12px;align-items:center;flex-wrap:wrap;margin:0 0 8px;font-size:13px;color:var(--ink2)}
.toolbar input[type=search]{font:inherit;border:1px solid var(--rule2);border-radius:8px;padding:6px 10px;min-width:320px;background:#fff}
.toolbar input[type=search]:focus{outline:2px solid var(--acc2);outline-offset:0;border-color:var(--acc2)}
.toolbar label{display:flex;gap:4px;align-items:center;cursor:pointer}
.toolbar .strong{font-weight:600;color:var(--g-v-ink)}
.toolbar .hint{margin-left:auto;color:var(--ink3);font-size:12px}
.toolbar .row2{display:flex;gap:10px;align-items:center;flex-wrap:wrap;width:100%}
.toolbar .lbl{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink3);width:44px}
button.ghost,button.more{font:inherit;font-size:13px;border:1px solid var(--rule2);background:#fff;border-radius:8px;padding:5px 11px;cursor:pointer;color:var(--ink2)}
button.ghost:hover,button.more:hover{border-color:var(--acc2);color:var(--acc)}
button.more{margin:8px 0 2px}
.status{font-size:12.5px;color:var(--acc2);min-height:18px;margin:0 2px 6px}
section.panel{display:none}section.panel.on{display:block}
.ptitle{display:none}
.grp{margin:0 0 18px}
.grp h3{display:flex;align-items:baseline;gap:10px;margin:14px 2px 8px;font:600 13px var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--acc)}
.grp h3 span{font-weight:400;letter-spacing:0;text-transform:none;color:var(--ink3);font-size:12.5px}
.vlist{overflow:hidden}
.var{display:grid;grid-template-columns:250px 1fr;border-top:1px solid var(--sunk)}
.var:first-child{border-top:0}
.vh{padding:14px 16px;background:#fafbf8;border-right:1px solid var(--sunk)}
.vh b{display:block;font-weight:600;font-size:14px}
.vh code{display:block;margin-top:2px;overflow-wrap:anywhere}
.vc{margin-top:8px;font-size:12px;color:var(--ink3);display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.fs{padding:4px 16px 10px;min-width:0}
.f{padding:10px 0;border-top:1px dashed #e4e6e1;overflow:hidden}
.f:first-child{border-top:0}
.fv{font:15.5px/1.45 var(--serif);overflow-wrap:anywhere;white-space:pre-line}
.ftl{font-size:12.5px;color:var(--ink2);margin-top:2px}
.fi{float:right;width:96px;height:72px;object-fit:cover;border-radius:8px;margin:0 0 6px 12px;background:var(--sunk);border:1px solid var(--rule)}
.fi.broken{display:none}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:1px 12px;margin:6px 0 0;font-size:12.5px;color:var(--ink2)}
.kv dt{color:var(--ink3);text-transform:capitalize}
.kv dd{margin:0;overflow-wrap:anywhere;min-width:0}
.kv .kv{margin:0}
.kvi{display:flex;flex-wrap:wrap;gap:2px 14px;margin-top:5px;font-size:12.5px;color:var(--ink2)}
.kvi i{font-style:normal;color:var(--ink3);margin-right:2px}
.kvi span{overflow-wrap:anywhere}
.dtx{font-size:12.5px;color:var(--ink2);margin-top:4px}
.dli{margin:6px 0 0;padding-left:18px;font-size:12.5px;color:var(--ink2)}
.mt{margin-top:6px;max-height:320px;overflow:auto;width:fit-content;max-width:100%;border:1px solid var(--sunk);border-radius:8px}
.mt table{border-collapse:collapse;font-size:12px}
.mt th{position:sticky;top:0;background:#f7f8f5;text-align:left;font-weight:600;color:var(--ink3);padding:4px 8px;text-transform:capitalize;white-space:nowrap}
.mt td{padding:4px 12px 4px 8px;border-top:1px solid #f0f1ee;vertical-align:top;overflow-wrap:anywhere}
.meta{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px;font-size:12px}
.meta .src{font-weight:500}
.mute{color:var(--ink3)}.small{font-size:12px;padding:4px 8px}
.nowrap{white-space:nowrap}.num{text-align:right;font-variant-numeric:tabular-nums}
.mod{font-size:11.5px;background:#eef2f6;color:#22476a;border-radius:5px;padding:1px 6px;white-space:nowrap}
.tb{font-size:11px;border-radius:5px;padding:1px 6px;white-space:nowrap;color:var(--c);background:color-mix(in srgb,var(--c) 12%,#fff);display:inline-block}
small.tb{display:block;width:max-content;margin-top:3px}
.dte{font:11.5px var(--mono);color:var(--ink2)}
.tier{font-size:11.5px;font-weight:600;border-radius:999px;padding:1px 8px;white-space:nowrap;display:inline-block}
.t-A{background:#e5f2e9;color:#1e5e3a}.t-B{background:#e6eff8;color:#1d4f7a}.t-C{background:#efebf8;color:#533f8e}.t-D{background:#fbefd8;color:#774c03}.t-E{background:#f0f2f3;color:#4a535e}
.grade{font-size:11.5px;font-weight:600;border-radius:4px;padding:1px 7px;white-space:nowrap}
.g-v{background:var(--g-v-bg);color:var(--g-v-ink)}.g-p{background:var(--g-p-bg);color:var(--g-p-ink)}.g-w{background:var(--g-w-bg);color:var(--g-w-ink)}
.g-i{background:var(--g-i-bg);color:var(--g-i-ink)}.g-n{background:var(--g-n-bg);color:var(--g-n-ink)}.g-np{background:var(--g-np-bg);color:var(--g-np-ink)}.g-u{background:#f6eded;color:#7a3b3b}
.led{font:11.5px var(--mono);color:var(--ink3);white-space:nowrap}
.ms{font:11.5px var(--mono);color:var(--ink3);white-space:nowrap}
.bits{display:flex;gap:4px;flex-wrap:wrap;margin-top:6px}
.bit{font-size:11px;border-radius:4px;padding:1px 6px;background:#eef2f6;color:#22476a}
.bit.neg{background:#f8e8e6;color:#8b3830}
.vd{font-size:11.5px;font-weight:600;border-radius:999px;padding:2px 9px;text-transform:capitalize;background:#fbefd8;color:#774c03;white-space:nowrap}
.vd.v-verified{background:#e5f2e9;color:#1e5e3a}.vd.v-partly{background:#edf5e5;color:#3b6122}.vd.v-namesake{background:#f8e8e6;color:#8b3830}
.meter{width:90px;height:8px;background:var(--sunk);border-radius:999px;overflow:hidden;display:inline-block;vertical-align:middle;margin-right:6px}
.meter.sm{width:110px;height:6px}
.meter i{display:block;height:100%;border-radius:999px}
.scroll{overflow:auto}
.tbl{width:100%;border-collapse:separate;border-spacing:0;font-size:13.5px}
.tbl th{position:sticky;top:0;background:#f7f8f5;text-align:left;white-space:nowrap;font-size:11.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--ink3);padding:10px 12px;border-bottom:1px solid var(--rule);z-index:1}
.tbl td{padding:9px 12px;border-bottom:1px solid #eceee9;vertical-align:top}
.tbl tr:hover td{background:#fafbf8}
.tbl td.val{font-family:var(--serif);font-size:14.5px;max-width:380px;overflow-wrap:anywhere}
.tbl td.val small{display:block;font:12px var(--sans);color:var(--ink3);margin-top:2px}
.tbl td.sv{max-width:360px;overflow-wrap:anywhere}
.tbl code.cid{display:block;margin-top:1px;font-size:11.5px}
.tbl .meta{margin-top:0}
.tbl.src td{padding:7px 12px;font-size:13px}
button.sort{font:inherit;letter-spacing:inherit;text-transform:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
button.sort.on{color:var(--acc)}
code.env{background:#fff4e0;color:#774c03;border-radius:4px;padding:1px 5px}
.stc{font-size:11.5px;font-weight:600;border-radius:999px;padding:2px 9px;background:#e5f2e9;color:#1e5e3a}
.stc.s-error,.stc.s-timeout{background:#f8e8e6;color:#8b3830}.stc.s-skipped{background:#f0f2f3;color:#4a535e}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));margin-bottom:14px;overflow:hidden;gap:1px;background:var(--rule)}
.stat{background:#fff;padding:14px 16px}.stat b{display:block;font:600 22px var(--serif);color:var(--acc)}.stat span{font-size:12px;color:var(--ink3)}
.pics{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin:4px 0 22px}
.thumb{display:flex;flex-direction:column;background:#fff;border:1px solid var(--rule);border-radius:12px;overflow:hidden;text-decoration:none;color:var(--ink);box-shadow:0 1px 2px rgba(15,61,90,.05)}
.thumb:hover{border-color:var(--acc2);box-shadow:0 6px 18px rgba(15,61,90,.12)}
.thumb .ph{display:block;aspect-ratio:4/3;background:linear-gradient(135deg,#eceee9,#dfe3dc);position:relative}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.thumb.broken .ph::after{content:"Image did not load";position:absolute;inset:0;display:grid;place-items:center;font-size:12px;color:var(--ink3)}
.thumb img.broken{visibility:hidden}
.thumb .cap{padding:8px 10px 2px;font-size:12.5px;line-height:1.35;overflow-wrap:anywhere}
.thumb .cap b{display:block;font-size:11px;color:var(--acc2);font-weight:600;margin-bottom:1px}
.thumb .cm{display:flex;gap:6px;align-items:center;padding:4px 10px 9px}
.tlbar{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin:2px 0 10px}
.legend{display:flex;gap:12px;flex-wrap:wrap;font-size:12.5px;color:var(--ink2);margin:6px 2px 10px}
.legend span{display:flex;gap:5px;align-items:center}
.timeline{padding:6px 18px 12px}
.yr{font:600 18px var(--serif);color:var(--acc);margin:14px 0 4px;padding-left:118px}
.tl{display:grid;grid-template-columns:100px 14px 1fr;gap:4px 8px;align-items:start;font-size:13.5px;padding:7px 0;border-top:1px solid #f0f1ee}
.tl .d{font:600 12px var(--mono);color:var(--ink3);text-align:right;padding-top:2px}
.p{display:inline-block;width:11px;height:11px;border-radius:50%;margin-top:5px;flex:none}
.legend .p{margin-top:0}
.tl .tt{overflow-wrap:anywhere}
.tl .meta{margin-top:3px}
.gl .gv{display:grid;grid-template-columns:300px 1fr;gap:12px;padding:10px 16px;border-top:1px solid var(--sunk);font-size:13.5px}
.gl .gv:first-child{border-top:0}
.gl code{display:block}
.searched{font-size:12.5px;color:var(--ink2);margin:2px 0;overflow-wrap:anywhere}
details.empty{margin:14px 0;background:#fafbf8;border:1px dashed var(--rule2);border-radius:12px;padding:10px 16px}
details.empty summary{cursor:pointer;font-size:13px;color:var(--ink2);font-weight:600}
details.empty ul{list-style:none;margin:8px 0 0;padding:0;columns:2;column-gap:28px}
details.empty li{break-inside:avoid;padding:6px 0;font-size:13px;border-top:1px solid #eceee9}
details.empty li code{margin-left:4px}
.blank{padding:22px;color:var(--ink2);font-size:14px}
.note{font-size:13px;color:var(--ink2);margin:4px 2px 12px;max-width:980px}
footer{font-size:12.5px;color:var(--ink3);margin-top:30px;max-width:980px}
@media (max-width:1000px){.tiles{grid-template-columns:repeat(2,1fr)}}
@media (max-width:820px){.snap{grid-template-columns:1fr}.var{grid-template-columns:1fr}.vh{border-right:0;border-bottom:1px solid var(--sunk)}.gl .gv{grid-template-columns:1fr}details.empty ul{columns:1}.toolbar .hint{display:none}.toolbar input[type=search]{min-width:0;width:100%}}
@media print{
  *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{background:#fff;font-size:12px}
  header.top{padding:16px 0 18px}
  main{margin-top:12px}
  nav.tabs,.toolbar,.status,button.more,button.ghost,.tlbar button{display:none!important}
  section.panel{display:block!important;break-before:page}
  .ptitle{display:block;font:600 22px var(--serif);color:var(--acc);margin:0 0 10px;border-bottom:2px solid var(--acc);padding-bottom:4px}
  .card{box-shadow:none}
  .var,.f,.tl,.thumb,tr{break-inside:avoid}
  .mt{max-height:none;overflow:visible}
  .scroll{overflow:visible}
  .pics{grid-template-columns:repeat(4,1fr)}
  a{color:inherit;text-decoration:none}
  .tbl th{position:static}
}
`;
