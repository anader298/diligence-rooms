// doc-metadata (heavy, opt-in: --heavy doc-metadata [--docs <dir>]). Runs `exiftool -json` as a
// separate program (ExifTool is Perl Artistic / GPL; it is never vendored or linked) over the
// room's corpus documents (rooms/<slug>/work/corpus with --room, or --docs <dir>): author, last
// editor, company, creating software, dates and GPS in PDFs, Office files and photos. An Author
// field is a lead, not proof (graded w): templates and shared machines carry other people's names.
// Binary: OSINT_EXIFTOOL, else exiftool on PATH.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { runProgram, which, depMiss } from "../sidecar.mjs";
import { nameMatch, companyIn } from "../person-lib.mjs";

const EXT = new Set([".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".odt", ".odp", ".ods", ".rtf", ".pages", ".key", ".jpg", ".jpeg", ".png", ".heic", ".tif", ".tiff", ".webp", ".mp4", ".mov", ".m4a"]);
const FIELDS = ["Author", "Creator", "LastModifiedBy", "Company", "Manager", "Producer", "CreatorTool", "Software", "Application", "AppVersion", "CreateDate", "ModifyDate", "DateTimeOriginal", "Title", "Subject", "Keywords", "Template", "GPSLatitude", "GPSLongitude", "Make", "Model", "PageCount"];

/** The folder to read: --docs, else the room's corpus next to the OSINT output folder. */
export function docsDir(opts = {}, outDir = "") {
  if (opts.docs) return opts.docs;
  const corpus = outDir ? join(outDir, "..", "..", "corpus") : null;
  return corpus && existsSync(corpus) ? corpus : null;
}

/** Document files under dir, newest first, at most max. */
export function listDocs(dir, max = 200) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 4) return;
    let ents = [];
    try {
      ents = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (EXT.has(extname(e.name).toLowerCase())) out.push({ p, m: statSync(p).mtimeMs });
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.m - a.m).slice(0, max).map((x) => x.p);
}

const clean = (v) => (v == null ? null : Array.isArray(v) ? v.join("; ") : String(v).trim() || null);
const day = (v) => {
  const m = String(v || "").match(/^(\d{4})[:-](\d\d)[:-](\d\d)/);
  return m && m[1] !== "0000" ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

/** One record per file from exiftool -json output, only the fields that matter. */
export function readExif(list, base = "") {
  return (list || []).map((x) => {
    const r = { file: base ? relative(base, x.SourceFile) : x.SourceFile, type: x.FileType || null };
    for (const f of FIELDS) if (clean(x[f]) != null) r[f] = clean(x[f]);
    r.created = day(x.CreateDate || x.DateTimeOriginal);
    r.modified = day(x.ModifyDate);
    r.people = [...new Set([r.Author, r.Creator && !/(word|acrobat|pdf|office|excel|powerpoint|writer|latex|chrome|skia|quartz|indesign|illustrator|photoshop|canva|google|microsoft)/i.test(r.Creator) ? r.Creator : null, r.LastModifiedBy, r.Manager].filter(Boolean))];
    r.tool = [...new Set([r.CreatorTool || r.Application || r.Software, r.Producer].filter(Boolean))].join(" / ") || null;
    r.gps = r.GPSLatitude != null && r.GPSLongitude != null ? `${Number(r.GPSLatitude).toFixed(5)}, ${Number(r.GPSLongitude).toFixed(5)}` : null;
    return r;
  });
}

export default {
  id: "doc-metadata",
  /** The ledger variables this module fills (config/form buckets read them to say "no tool yet"). */
  vars: ["doc.metadata"],
  label: "Document metadata in the corpus: authors, software, dates (opt-in, exiftool)",
  lane: "heavy",
  flag: "--heavy doc-metadata --docs <dir>",
  needs: [],
  deps: { bin: ["exiftool"] },
  budgetMs: 60000,
  async run(ctx) {
    const { subject, opts = {} } = ctx;
    const dir = docsDir(opts, ctx.outDir);
    if (!dir || !existsSync(dir)) return ctx.miss("doc.metadata", `document metadata not run: no corpus folder (pass --docs <dir>, or run with --room so rooms/<slug>/work/corpus is read)${opts.docs ? `; ${opts.docs} does not exist` : ""}`, { blocked: true });
    const files = listDocs(dir);
    if (!files.length) return ctx.miss("doc.metadata", `document metadata: no PDFs, Office files or photos under ${dir}`);
    const bin = ctx.env.OSINT_EXIFTOOL || "exiftool";
    if (!which(bin, ctx.env)) return depMiss(ctx, "doc.metadata", "document metadata", [bin], "brew install exiftool (or apt install libimage-exiftool-perl), or set OSINT_EXIFTOOL to its path");
    const r = await runProgram(bin, ["-json", "-n", "-fast", "-charset", "filename=utf8", ...FIELDS.map((f) => `-${f}`), "-FileType", ...files], { timeoutMs: 50000, env: ctx.env });
    if (r.missing) return depMiss(ctx, "doc.metadata", "document metadata", [bin], "brew install exiftool (or apt install libimage-exiftool-perl)");
    let list = null;
    try {
      list = JSON.parse(r.stdout || "[]");
    } catch {
      list = null;
    }
    if (!list) {
      ctx.status("error", `exiftool: ${(r.stderr || `exit ${r.code}`).slice(0, 160)}`);
      return ctx.miss("doc.metadata", `document metadata not run: exiftool failed (${(r.stderr || `exit ${r.code}`).trim().slice(0, 160)})`, { blocked: true });
    }
    const recs = readExif(list, dir);
    const people = new Map();
    const tools = new Map();
    const companies = new Map();
    for (const x of recs) {
      for (const p of x.people) people.set(p, (people.get(p) || 0) + 1);
      if (x.tool) tools.set(x.tool, (tools.get(x.tool) || 0) + 1);
      if (x.Company) companies.set(x.Company, (companies.get(x.Company) || 0) + 1);
      const own = x.people.some((p) => nameMatch(p, subject));
      if (!x.people.length && !x.Company && !x.gps) continue;
      ctx.add({
        var: "doc.metadata",
        value: `${x.file}: ${[x.people.length && `by ${x.people.join(", ")}`, x.Company && `company ${x.Company}`, x.tool && `made with ${x.tool}`, x.created && `created ${x.created}`, x.modified && x.modified !== x.created && `modified ${x.modified}`, x.gps && `GPS ${x.gps}`].filter(Boolean).join("; ")}`,
        url: null,
        date: x.created || x.modified || null,
        grade: "w",
        tier: "C",
        anchors: [own && "name", x.Company && companyIn(x.Company, subject) && "company"].filter(Boolean),
        detail: { ...x, note: "metadata fields are set by software and templates; a lead, not proof" },
      });
    }
    const top = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} (${n})`).join(", ");
    ctx.add({
      var: "doc.metadata",
      value: `${recs.length} corpus file(s) read: authors ${top(people) || "none recorded"}; companies ${top(companies) || "none recorded"}; software ${top(tools) || "none recorded"}`,
      grade: "w",
      tier: "C",
      detail: { dir, files: recs.length, people: Object.fromEntries(people), companies: Object.fromEntries(companies), tools: Object.fromEntries(tools) },
    });
  },
};
