// Lint one room against the depth standard. Used by scripts/lint.mjs and the studio.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readPageBody, pageFile } from "./pages.mjs";
import { sha256, PERSON_PAGES, RENAMED_PAGES } from "./compose.mjs";

export const TARGETS = {
  full: { pages: 40, sources: 150, gradedShare: 0.7, glossary: 250, answers: 150 },
  light: { pages: 10, sources: 40, gradedShare: 0.6, glossary: 60, answers: 40 },
};
/**
 * Personal life rows checked per person (STANDARD.md sec. 11). Counted from the OSINT log's
 * "Checks per person" table (rows with data-page="interests-<slug>", each graded, found or None
 * found) together with the findings shown on the page, not from the visible rows alone.
 */
export const INTEREST_ROWS = 8;
/** The four drivers every persona (and the company page) covers. */
export const DRIVERS = ["Financial", "Social", "Commercial", "Technical"];
export const VERDICTS = ["proven", "mixed", "unproven"];
export const GRADES = ["verified", "partly", "weak", "inference", "none", "not-public", "unknown"];
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();

const dataRows = (html) => (html.match(/<tr[\s>][\s\S]*?<\/tr>/gi) || []).filter((r) => /<td[\s>]/i.test(r)).length;
const items = (html) => (html.match(/<li[\s>]/gi) || []).length;

/** The page bodies a flat-skeleton room would have started from (for rooms with no .skeleton.json). */
function legacySkeleton(skeletonDir, id, room) {
  const prefix = [...PERSON_PAGES, ...Object.keys(RENAMED_PAGES)].sort((a, b) => b.length - a.length).find((p) => id.startsWith(p + "-"));
  const base = prefix ? RENAMED_PAGES[prefix] || prefix : id;
  for (const d of [join(skeletonDir, "pages"), join(skeletonDir, "core", "pages"), join(skeletonDir, "core", "person")]) {
    const f = join(d, base + ".html");
    if (existsSync(f)) return readFileSync(f, "utf8").replaceAll("__SLUG__", room.slug).replaceAll("__TITLE__", room.title).replaceAll("__COMPANY__", room.counterparty || room.title);
  }
  return null;
}

/** Checklist rows (<tr class="ck">) that carry no grade span: a row left blank instead of "None found". */
export function ungradedChecklistRows(html) {
  return (String(html).match(/<tr\b[^>]*class="[^"]*\bck\b[^"]*"[^>]*>[\s\S]*?<\/tr>/gi) || [])
    .filter((row) => !/class="grade [a-z-]+"/.test(row))
    .map((row) => text((row.match(/<td[^>]*>([\s\S]*?)<\/td>/i) || [, ""])[1]) || "(unnamed row)");
}

/** Checklist rows on a page that carry a grade (found, weak, or None found with what was searched). */
export function gradedChecklistRows(html) {
  return (String(html).match(/<tr\b[^>]*class="[^"]*\bck\b[^"]*"[^>]*>[\s\S]*?<\/tr>/gi) || []).filter((row) => /class="grade [a-z-]+"/.test(row)).length;
}

const ROW_RE = /<tr\b[^>]*class="[^"]*\bck\b[^"]*"[^>]*>[\s\S]*?<\/tr>/gi;
const graded = (row) => /class="grade [a-z-]+"/.test(row);
const cells = (row) => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => text(m[1]));
const key = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The checklist rows checked for one person page, by name: the graded rows on the page
 * (first cell) plus the graded rows the OSINT log holds for it (<tr class="ck" data-page="<id>">,
 * row name in the third cell: Person, Page, Row, Result, What was searched).
 */
export function checkedRows(pageHtml, logHtml, pageId) {
  const names = new Set();
  for (const row of String(pageHtml || "").match(ROW_RE) || []) if (graded(row)) names.add(key(cells(row)[0] || ""));
  for (const row of String(logHtml || "").match(ROW_RE) || []) {
    const page = (row.match(/data-page="([^"]*)"/) || [])[1];
    if (page !== pageId || !graded(row)) continue;
    const c = cells(row);
    names.add(key(c[2] || c[0] || ""));
  }
  names.delete("");
  return [...names];
}

/**
 * What a filled persona page is missing from its top blocks: the verdict (data-verdict
 * proven | mixed | unproven), at least one graded claim against the record (<tr class="claim">),
 * and the four drivers in the "What drives them" table, each graded.
 */
export function personaGaps(html) {
  const s = String(html);
  const gaps = [];
  const v = (s.match(/<[^>]*class="verdict"[^>]*>/i) || [""])[0].match(/data-verdict="([a-z]*)"/i);
  if (!v || !VERDICTS.includes(v[1].toLowerCase())) gaps.push("verdict (Proven / Mixed / Unproven)");
  const claims = (s.match(/<tr\b[^>]*class="[^"]*\bclaim\b[^"]*"[^>]*>[\s\S]*?<\/tr>/gi) || []).filter(graded);
  if (!claims.length) gaps.push("claims against the record");
  const table = (s.match(/<table\b[^>]*class="[^"]*\bmotives\b[^"]*"[^>]*>[\s\S]*?<\/table>/i) || [""])[0];
  const rows = table.match(ROW_RE) || [];
  for (const d of DRIVERS) if (!rows.some((r) => key(cells(r)[0] || "").startsWith(d.toLowerCase()) && graded(r))) gaps.push(`what drives them: ${d.toLowerCase()}`);
  return gaps;
}

/**
 * Lint a room folder. Returns a report:
 * { slug, tier, pages, skeleton[], noSource[], grades{}, gradedShare, anthony[], h2[], noMeta[],
 *   sources, glossaryRows, answerItems, checks[{name, actual, target, ok, ratio}], score, ok }
 */
export function lintRoom(roomDir, opts = {}) {
  const skeletonDir = opts.skeletonDir;
  const room = JSON.parse(readFileSync(join(roomDir, "room.json"), "utf8"));
  const tier = room.tier === "light" ? "light" : "full";
  const T = TARGETS[tier];
  const manifestFile = join(roomDir, ".skeleton.json");
  const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")).pages || {} : null;
  const pageShell = opts.pageTemplate ?? "";

  const r = { slug: room.slug, tier, pages: 0, missing: [], skeleton: [], noSource: [], grades: Object.fromEntries(GRADES.map((g) => [g, 0])), anthony: [], h2: [], noMeta: [], checklist: [], interests: [], personas: [], sources: 0, glossaryRows: 0, answerItems: 0 };
  const hrefs = new Set();
  const answerIds = [];
  const glossaryIds = [];
  const interestPages = [];
  const allIds = (room.sections || []).flatMap((s) => (s.pages || []).map((p) => p.id));
  const logPage = allIds.includes("osint-log") ? readPageBody(roomDir, "osint-log") : null;
  const logHtml = logPage ? logPage.clean : "";
  for (const s of room.sections || [])
    for (const p of s.pages || []) {
      r.pages++;
      const pg = readPageBody(roomDir, p.id);
      if (!pg) {
        r.missing.push(p.id);
        continue;
      }
      const isSkeleton = manifest ? manifest[p.id] && manifest[p.id] === sha256(pg.raw) : skeletonDir && legacySkeleton(skeletonDir, p.id, room) === pg.raw;
      if (isSkeleton) r.skeleton.push(p.id);
      const body = pg.clean;
      // A filled page must keep every checklist row, each graded (weak, or none with what was searched).
      if (!isSkeleton) for (const row of ungradedChecklistRows(body)) r.checklist.push({ page: p.id, row });
      const srcLinks = [...body.matchAll(/<a\b[^>]*class="[^"]*\bsrc\b[^"]*"[^>]*>/gi)];
      if (!srcLinks.length) r.noSource.push(p.id);
      for (const a of srcLinks) hrefs.add((a[0].match(/href="([^"]*)"/i) || [, a[0]])[1]);
      for (const g of GRADES) r.grades[g] += (body.match(new RegExp(`class="grade ${g}"`, "g")) || []).length;
      for (const m of text(body).matchAll(/\[(ANTHONY|FILL):\s*([^\]]*)\]/g)) r.anthony.push({ page: p.id, kind: m[1], text: m[2].trim() });
      for (const m of body.matchAll(/<h2(\s[^>]*)?>([\s\S]*?)<\/h2>/gi)) {
        const t = text(m[2]);
        if (m[1]) r.h2.push({ page: p.id, heading: t, problem: "has attributes" });
        else if (t.length > 40) r.h2.push({ page: p.id, heading: t, problem: `${t.length} chars (max 40)` });
      }
      // The page shell supplies p.meta; a page is flagged if neither the shell nor the body has it.
      if (!/class="(?:page-)?meta"/.test(pageShell) && !/<p class="meta"/.test(body)) r.noMeta.push(p.id);
      // Personal life: rows checked are counted against the OSINT log, not the rows shown.
      if (/^interests-/.test(p.id)) r.interests.push({ page: p.id, rows: checkedRows(isSkeleton ? "" : body, logHtml, p.id).length });
      if (/^persona-/.test(p.id) && !isSkeleton) r.personas.push({ page: p.id, missing: personaGaps(body) });
      if (/glossary/i.test(p.id)) glossaryIds.push(p.id), (r.glossaryRows += dataRows(body));
      if (/answer/i.test(p.id)) answerIds.push([p.id, body]);
    }
  // answer bank: pages with "answer" in the id; if none, the practice / question banks
  let answerPages = answerIds;
  if (!answerPages.length)
    for (const s of room.sections || [])
      for (const p of s.pages || [])
        if (/practice-bank|question-bank/i.test(p.id)) {
          const pg = readPageBody(roomDir, p.id);
          if (pg) answerPages.push([p.id, pg.clean]);
        }
  r.answerItems = answerPages.reduce((n, [, b]) => n + dataRows(b) + items(b), 0);
  r.sources = hrefs.size;
  const totalGrades = Object.values(r.grades).reduce((a, b) => a + b, 0);
  // "None found" is a negative finding, not a fact line, so it is left out of the share.
  const factGrades = totalGrades - r.grades.none;
  r.gradedShare = factGrades ? (r.grades.verified + r.grades.partly) / factGrades : 0;

  const check = (name, actual, target, invert = false) => {
    const ok = invert ? actual <= target : actual >= target;
    const ratio = invert ? (r.pages ? 1 - Math.min(actual / r.pages, 1) : 1) : target ? Math.min(actual / target, 1) : 1;
    return { name, actual, target, ok, ratio };
  };
  r.checks = [
    check("pages", r.pages, T.pages),
    check("unique sources", r.sources, T.sources),
    check("verified + partly share", Math.round(r.gradedShare * 100) / 100, T.gradedShare),
    check("glossary rows", r.glossaryRows, T.glossary),
    check("answer bank items", r.answerItems, T.answers),
    check("pages still skeleton", r.skeleton.length, 0, true),
    check("pages with no source link", r.noSource.length, 0, true),
    check("checklist rows with no grade", r.checklist.length, 0, true),
    check("bad h2", r.h2.length, 0, true),
    check("pages missing p.meta", r.noMeta.length, 0, true),
    check("missing page files", r.missing.length, 0, true),
  ];
  // Rooms composed before the interests page existed have none; the check applies only when they do.
  if (r.interests.length) r.checks.push(check("people with under 8 interest rows checked", r.interests.filter((x) => x.rows < INTEREST_ROWS).length, 0, true));
  // Every filled persona opens with the verdict, the claims against the record and what drives them.
  if (r.personas.length) r.checks.push(check("personas missing the verdict or what drives them", r.personas.filter((x) => x.missing.length).length, 0, true));
  r.score = Math.round((100 * r.checks.reduce((a, c) => a + c.ratio, 0)) / r.checks.length);
  r.ok = r.checks.every((c) => c.ok);
  r.skeletonShare = r.pages ? r.skeleton.length / r.pages : 0;
  return r;
}

export function formatReport(r) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  const L = [];
  L.push(`${r.slug}  (tier ${r.tier})  score ${r.score}/100  ${r.ok ? "PASS" : "FAIL"}`);
  for (const c of r.checks) L.push(`  ${c.ok ? "ok  " : "FAIL"}  ${c.name}: ${c.name.includes("share") ? pct(c.actual) : c.actual}  (target ${c.name.includes("share") ? pct(c.target) + "+" : c.target === 0 ? "0" : c.target + "+"})`);
  L.push(`  grades: ${Object.entries(r.grades).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  const list = (title, arr, f = (x) => x) => {
    if (!arr.length) return;
    L.push(`  ${title} (${arr.length}):`);
    for (const x of arr.slice(0, 40)) L.push(`    - ${f(x)}`);
    if (arr.length > 40) L.push(`    ... and ${arr.length - 40} more`);
  };
  list("missing page files", r.missing);
  list("still identical to skeleton", r.skeleton);
  list("no a.src", r.noSource);
  list("checklist rows with no grade (write the finding, weak, or None found)", r.checklist, (c) => `${c.page}: ${c.row}`);
  list("h2 problems", r.h2, (h) => `${h.page}: "${h.heading}" ${h.problem}`);
  list("missing p.meta", r.noMeta);
  list("personas missing the verdict or what drives them", (r.personas || []).filter((x) => x.missing.length), (x) => `${x.page}: ${x.missing.join("; ")}`);
  list(`personal life pages with under ${INTEREST_ROWS} rows checked (page findings + OSINT log checks)`, (r.interests || []).filter((x) => x.rows < INTEREST_ROWS), (x) => `${x.page}: ${x.rows}`);
  list("[ANTHONY: ...] / [FILL: ...] items", r.anthony, (a) => `${a.page}: [${a.kind}] ${a.text}`);
  return L.join("\n");
}
