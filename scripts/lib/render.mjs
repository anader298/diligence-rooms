// Shared HTML helpers for the room build: the app bar, grade strips and donuts, the
// legend, verdict chips, headshot frames, "what drives them" strips, the deal path,
// page status for the person checklists, and the page-body rewrites (short version,
// source chips, jump bar, FILL markers). Pure functions, no dependencies.

export const GRADES = [
  ["verified", "Verified"],
  ["partly", "Partly verified"],
  ["weak", "Weak"],
  ["inference", "Inference"],
  ["none", "None found"],
  ["not-public", "Not public"],
  ["unknown", "Unknown"],
];
export const GRADE_DEFS = {
  verified: "Read at the source during this build.",
  partly: "One source, or a search snippet that could not be opened.",
  weak: "Thin, indirect, or from an account not confirmed as theirs. Use with care.",
  inference: "Our reasoning from the sources. Never say it as fact.",
  none: "Checked; nothing public turned up.",
  "not-public": "Exists, but is not published.",
  unknown: "Could not be determined yet.",
};
const SHORT = { verified: "v", partly: "p", weak: "w", inference: "i", none: "n", "not-public": "np", unknown: "u" };
const COLOR = (k) => `var(--g-${SHORT[k]})`;

export const esc = (s = "") => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
export const slugify = (s) => String(s).toLowerCase().replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const text = (html) => String(html).replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/g, " ").replace(/\s+/g, " ").trim();

/** "Dan Ellison" -> "DE". */
export const initials = (name = "") => {
  const w = String(name).trim().split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] || "") + (w.length > 1 ? w[w.length - 1][0] : "")).toUpperCase();
};
export const minutes = (words) => Math.max(1, Math.round(words / 230));
const MONTHS = "January February March April May June July August September October November December".split(" ");
/** "2026-03-02" -> "2 March 2026"; anything else is returned as it is. */
export function longDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  return m ? `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}` : String(iso || "");
}

/** Grade counts as a stacked strip. */
export function ev(counts = {}, width) {
  const on = GRADES.filter(([k]) => counts[k]);
  if (!on.length) return "";
  const label = on.map(([k, l]) => `${counts[k]} ${l.toLowerCase()}`).join(", ");
  return `<span class="ev" role="img" aria-label="Grades: ${label}"${width ? ` style="--w:${width}"` : ""}>${on.map(([k]) => `<i class="${SHORT[k]}" style="--n:${counts[k]}"></i>`).join("")}</span>`;
}
/** Found, weak and empty pages as a strip. */
export function evStatus(found, weak, none, width) {
  const lab = `${found} found, ${weak} weak` + (none ? `, ${none} empty` : "");
  return `<span class="ev" role="img" aria-label="${lab}"${width ? ` style="--w:${width}"` : ""}><i class="found" style="--n:${found}"></i><i class="weakp" style="--n:${weak}"></i><i class="nonep" style="--n:${none}"></i></span>`;
}
/** Grade mix as a ring (pathLength 100 segments). The middle shows the verified share, or `label`. */
export function donut(counts = {}, size = 36, label) {
  const tot = Object.values(counts).reduce((a, b) => a + (b || 0), 0) || 1;
  let off = 25;
  const arcs = [];
  for (const [k] of GRADES) {
    const n = counts[k] || 0;
    if (!n) continue;
    const pct = (n / tot) * 100;
    const d = Math.max(pct - 1.2, 0.6);
    arcs.push(`<circle r="15.915" cx="18" cy="18" pathLength="100" stroke="${COLOR(k)}" stroke-dasharray="${d.toFixed(2)} ${(100 - d).toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"/>`);
    off -= pct;
  }
  const desc = GRADES.filter(([k]) => counts[k]).map(([k, l]) => `${counts[k]} ${l.toLowerCase()}`).join(", ");
  const mid = label ?? `${Math.round((((counts.verified || 0) + (counts.partly || 0)) / tot) * 100)}%`;
  return `<svg class="donut" viewBox="0 0 36 36" width="${size}" height="${size}" role="img" aria-label="Grade mix: ${desc}"><circle r="15.915" cx="18" cy="18" class="track"/><g fill="none" stroke-width="4.2">${arcs.join("")}</g><text x="18" y="18" dominant-baseline="central" text-anchor="middle">${esc(mid)}</text></svg>`;
}

export const grade = (k) => {
  const g = GRADES.find(([x]) => x === k);
  return g ? `<span class="grade ${g[0]}">${g[1]}</span>` : "";
};
export const legend = () =>
  `<details class="legend"><summary>What the grades mean</summary>\n<dl>\n${GRADES.map(([k, l]) => `<dt><span class="grade ${k}">${l}</span></dt><dd>${GRADE_DEFS[k]}</dd>`).join("\n")}\n</dl></details>`;

const VERDICTS = { proven: "Proven", mixed: "Mixed", unproven: "Unproven" };
/** person.verdict = { level: proven|mixed|unproven, line } */
export const verdictChip = (v) => (v && VERDICTS[v.level] ? `<span class="vchip ${v.level}">${VERDICTS[v.level]}</span>` : "");

/** An empty headshot frame: no photo is shipped in the engine; a room drops one in by hand. */
export function headshot(name, size = "md") {
  return `<figure class="headshot ${size}" role="img" aria-label="Headshot frame for ${esc(name)}"><svg viewBox="0 0 120 120" aria-hidden="true" focusable="false"><rect class="hs-bg" width="120" height="120"/><circle class="hs-ring" cx="60" cy="60" r="56"/><circle class="hs-fig" cx="60" cy="48" r="20"/><path class="hs-fig" d="M22 112c4-24 20-36 38-36s34 12 38 36z"/></svg></figure>`;
}

/** drives = [{ kind: financial|social|commercial|technical, line, grade }] */
export function drivesStrip(drives = []) {
  if (!drives?.length) return "";
  const lab = (k) => String(k || "").replace(/^./, (c) => c.toUpperCase());
  return `<ul class="drives-strip">${drives.map((d) => `<li class="drv ${esc(d.kind || "")}"><b>${esc(d.label || lab(d.kind))}</b><span>${esc(d.line)}</span>${grade(d.grade)}</li>`).join("")}</ul>`;
}

/** dealPath = [{ who, action, detail, status: done|next|todo, grade }] */
export function dealPath(steps = []) {
  if (!steps?.length) return "";
  return `<ol class="dealpath">${steps.map((s) => `<li class="is-${esc(s.status || "todo")}"><span class="who">${esc(s.who)}</span><b>${esc(s.action)}</b><span class="d">${esc(s.detail || "")}</span>${grade(s.grade)}</li>`).join("")}</ol>`;
}

const SEARCH_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m11 11 3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
export const searchBox = (mobile = false) =>
  mobile
    ? `<div class="search msearch">${SEARCH_SVG}<input id="mq" type="search" placeholder="Search every page" autocomplete="off" spellcheck="false" aria-label="Search every page in this room"><button type="button">Clear</button></div>`
    : `<div class="search" id="sbox">${SEARCH_SVG}<input id="q" type="search" placeholder="Search every page" autocomplete="off" spellcheck="false" aria-label="Search every page in this room"><kbd>/</kbd><button type="button">Clear</button></div>`;

const FEED = `<dialog class="feed" id="feed" aria-labelledby="feedh">
<form method="dialog" class="feed-in">
<div class="feed-top"><h2 id="feedh">Feed it</h2><button class="x" value="close" aria-label="Close">Close</button></div>
<p class="feed-lede">Add what you learned. It is saved in this browser, and the room builder folds it in at the next rebuild.</p>
<fieldset class="seg"><legend>What is it</legend>
<label><input type="radio" name="kind" value="Debrief" checked> Debrief</label>
<label><input type="radio" name="kind" value="New fact"> New fact</label>
<label><input type="radio" name="kind" value="Correction"> Correction</label>
<label><input type="radio" name="kind" value="Document"> Document</label>
</fieldset>
<label class="fld">Note<textarea name="text" rows="5"></textarea></label>
<label class="fld">Source link, if any<input name="src" type="url" inputmode="url" placeholder="https://"></label>
<div class="feed-acts"><button class="btn solid" value="save" id="feedsave">Save to this room</button><button class="btn" value="copy" id="feedcopy" type="button">Copy all for the builder</button></div>
<p class="feed-status" id="feedstatus" aria-live="polite"></p>
<ol class="feed-list" id="feedlist"></ol>
</form></dialog>`;

export function crumbs(parts) {
  return `<nav class="crumbs" aria-label="Breadcrumb">${parts
    .map(([label, href]) => `<span class="sep">/</span>` + (href ? `<a href="${href}">${esc(label)}</a>` : `<span aria-current="page">${esc(label)}</span>`))
    .join("")}</nav>`;
}

/** The app bar on every page: brand, crumbs or search, reading progress, Feed it, Companion, Sign out. */
export function bar(room, { crumbs: cr = "", search = false, total = 0 } = {}) {
  const [a, ...b] = String(room.title || "Room").split(" ");
  const word = b.length ? `${esc(a)} <span>${esc(b.join(" "))}</span>` : esc(a);
  return `<a class="skip" href="#main">Skip to content</a>
<p class="topstrip">${esc(room.strip || "Diligence room · private")}</p>
<header class="bar"><div class="in">
<a class="brand" href="index.html"><span class="sq" aria-hidden="true">${esc(String(room.title || "R")[0].toUpperCase())}</span><span class="nm">${word}</span></a>
${cr}${search ? searchBox() : ""}<span class="grow"></span>
<span class="prog"><span class="track"><span class="fill"></span></span><span class="t">0 of ${total}<span class="lg"> read</span></span></span>
<button class="feedbtn" type="button" data-open-feed>Feed it<span class="vh"> (add notes to the room)</span><span class="fb-n" hidden></span></button>
<a class="companion" href="assist.html"><span class="dot" aria-hidden="true"></span>Companion<span class="vh"> (live help during the meeting)</span></a>
<a class="signout" href="__logout">Sign out</a>
</div></header>
${FEED}`;
}

/** data-now and data-demo-read, only for a synthetic room that sets room.json "demo". */
export function demoAttrs(room) {
  const d = room.demo;
  if (!d) return "";
  return (d.now ? ` data-now="${esc(d.now)}"` : "") + (d.read?.length ? ` data-demo-read="${esc(d.read.join(" "))}"` : "");
}

/**
 * A person page's status for the checklist: page.status wins, else from its grade counts.
 * none: nothing verified or partly verified and at least one None found, or no graded line;
 * weak: more weak, inference and unknown than verified and partly; found otherwise.
 */
export function pageStatus(page = {}, counts = {}) {
  if (["found", "weak", "none"].includes(page.status)) return page.status;
  const c = (k) => counts[k] || 0;
  const total = GRADES.reduce((a, [k]) => a + c(k), 0);
  const good = c("verified") + c("partly");
  if (!total || (c("none") > 0 && good === 0)) return "none";
  if (c("weak") + c("inference") + c("unknown") > good) return "weak";
  return "found";
}

/** Lift a <div class="tldr"> out of the body (the short version, rendered above the jump bar). */
export function liftTldr(body) {
  const m = /<div class="tldr(?: [^"]*)?">[\s\S]*?<\/div>/.exec(body);
  if (!m) return { tldr: "", body };
  let block = m[0];
  if (!/class="lbl"/.test(block)) block = block.replace(/^(<div[^>]*>)/, `$1<p class="lbl">The short version</p>`);
  return { tldr: block, body: body.slice(0, m.index) + body.slice(m.index + m[0].length) };
}

/** Source links get a hidden "Source: " prefix for screen readers; idempotent. */
export const sourceChips = (body) =>
  body.replace(/<a class="src" href="([^"]*)">(?!<span class="vh">)/g, `<a class="src" href="$1"><span class="vh">Source: </span>`);

/** [FILL: ...] markers are shown as fill-in chips. */
export const fillMarks = (body) => body.replace(/(?<!class="fill">)\[FILL:[^\]]*\]/g, (m) => `<span class="fill">${m}</span>`);

/** Give every bare <h2> an id; return the jump bar (2+ headings). A leading "1. " is dropped from the link only. */
export function jumpBar(body) {
  const items = [];
  const seen = new Set();
  body = body.replace(/<h2>(.*?)<\/h2>/g, (_, inner) => {
    let id = slugify(inner) || "s";
    while (seen.has(id)) id += "-2";
    seen.add(id);
    items.push(`<li><a href="#${id}">${inner.replace(/^\s*\d+\.\s+/, "")}</a></li>`);
    return `<h2 id="${id}">${inner}</h2>`;
  });
  const nav = items.length > 1 ? `<nav class="jumps" aria-label="On this page"><p class="lbl">On this page</p><ol>${items.join("")}</ol></nav>` : "";
  return { body, nav };
}
