// Reading a room's page bodies: pages/<id>.html wins; pages/<id>.md is converted.
// Grade shorthands ({v} {p} {w} {i} {n} {np} {u}) are expanded in both.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mdToHtml, expandGrades } from "./markdown.mjs";
import { PERSON_PAGES, RENAMED_PAGES } from "./compose.mjs";

/** Drop HTML comments (skeleton instructions, notes to the writer). */
export const stripComments = (html) => String(html).replace(/<!--[\s\S]*?-->/g, "");

export function pageFile(roomDir, id) {
  const html = join(roomDir, "pages", id + ".html");
  if (existsSync(html)) return { file: html, kind: "html" };
  const md = join(roomDir, "pages", id + ".md");
  if (existsSync(md)) return { file: md, kind: "md" };
  return null;
}

/** The page body as HTML (and `clean`: the same without comments), or null when neither file exists. */
export function readPageBody(roomDir, id) {
  const f = pageFile(roomDir, id);
  if (!f) return null;
  const raw = readFileSync(f.file, "utf8");
  const body = f.kind === "md" ? mdToHtml(raw) : expandGrades(raw);
  return { ...f, raw, body, clean: stripComments(body) };
}

/** True for a per-person page id (<page>-<person slug>). */
export function isPersonPage(id) {
  return [...PERSON_PAGES, ...Object.keys(RENAMED_PAGES)].some((p) => String(id).startsWith(p + "-"));
}

/**
 * Person pages show the reader findings only: a checklist row (<tr class="ck">) whose grades
 * are all "None found" is dropped. The row stays in the page file, where lint checks it, and
 * the same check is logged on the OSINT log.
 */
export function hideNoneRows(html) {
  return String(html).replace(/<tr\b[^>]*class="[^"]*\bck\b[^"]*"[^>]*>[\s\S]*?<\/tr>\s*/gi, (row) => {
    const grades = [...row.matchAll(/class="grade ([a-z-]+)"/g)].map((m) => m[1]);
    return grades.length && grades.every((g) => g === "none") ? "" : row;
  });
}
