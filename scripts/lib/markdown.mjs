// A small markdown-to-HTML converter for room pages, and the grade shorthands.
//
//   headings (# to ######), paragraphs, unordered and ordered lists (nested by
//   indent), pipe tables, blockquotes, fenced and indented code, horizontal
//   rules, **bold**, *italic*, `code`, [links](url) and <https://autolinks>.
//   Lines that start with an HTML tag pass through untouched, so a page can mix
//   markdown with the room's own markup.
//
// External links become <a class="src" href="..."> (the room's source chip).
// Relative links (another page in the room) stay plain <a href="...">.
// No dependencies.

export const GRADE_SHORTHANDS = {
  v: ["verified", "Verified"],
  p: ["partly", "Partly verified"],
  w: ["weak", "Weak"],
  i: ["inference", "Inference"],
  n: ["none", "None found"],
  np: ["not-public", "Not public"],
  u: ["unknown", "Unknown"],
};

// Tags, code and links are held aside before this runs, so any < or > left is text.
const escText = (s) =>
  String(s)
    .replace(/&(?![a-zA-Z][a-zA-Z0-9]*;|#[0-9]+;|#x[0-9a-fA-F]+;)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
const escAll = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const escAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Expand {v} {p} {w} {i} {n} {np} {u} into grade spans, skipping <pre> and <code>. */
export function expandGrades(html) {
  return String(html)
    .split(/(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>)/i)
    .map((part, i) =>
      i % 2 ? part : part.replace(/\{(v|p|w|i|np|n|u)\}/g, (_, k) => `<span class="grade ${GRADE_SHORTHANDS[k][0]}">${GRADE_SHORTHANDS[k][1]}</span>`),
    )
    .join("");
}

function safeUrl(url) {
  const u = url.trim();
  if (/^(javascript|vbscript|data):/i.test(u.replace(/[\s\u0000-\u001f]/g, ""))) return "#";
  return u;
}

function link(textHtml, url) {
  const u = safeUrl(url);
  const external = /^(https?:)?\/\//i.test(u) || /^mailto:/i.test(u);
  return `<a${external ? ' class="src"' : ""} href="${escAttr(u)}">${textHtml}</a>`;
}

/** Inline markdown: code spans, links, bold, italic. */
export function inline(src) {
  const keep = [];
  const hold = (html) => `\u0000${keep.push(html) - 1}\u0000`;
  let s = String(src);
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, code) => hold(`<code>${escAll(code.trim())}</code>`));
  s = s.replace(/<((?:https?:\/\/|mailto:)[^\s<>]+)>/gi, (_, u) => hold(link(escAll(u), u)));
  s = s.replace(/\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_, t, u) => hold(link(inline(t), u)));
  s = s.replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(\s[^<>]*)?\/?>/g, (tag) => hold(tag));
  s = escText(s);
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>").replace(/__(?=\S)([\s\S]*?\S)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?!\*)/g, "$1<em>$2</em>").replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?![_\w])/g, "$1<em>$2</em>");
  while (/\u0000\d+\u0000/.test(s)) s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => keep[n]);
  return s;
}

const isTableSep = (l) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l) && l.includes("|");
const splitRow = (l) => {
  let t = l.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
};
const listRe = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const indentOf = (l) => l.match(/^\s*/)[0].replace(/\t/g, "    ").length;

function parseList(lines, i) {
  const first = lines[i].match(listRe);
  const base = indentOf(lines[i]);
  const ordered = /\d/.test(first[2]);
  const start = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  while (i < lines.length) {
    const m = lines[i].match(listRe);
    if (!m || indentOf(lines[i]) !== base || /\d/.test(m[2]) !== ordered) break;
    const body = [m[3]];
    i++;
    // continuation lines and nested blocks: anything indented deeper, blank lines inside
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === "") {
        const next = lines.slice(i + 1).find((x) => x.trim() !== "");
        if (next !== undefined && indentOf(next) > base) {
          body.push("");
          i++;
          continue;
        }
        break;
      }
      if (indentOf(l) > base) {
        body.push(l);
        i++;
        continue;
      }
      if (!listRe.test(l) && !/^\s*(#|>|\||```|~~~)/.test(l) && body[body.length - 1] !== "") {
        body.push(l); // lazy continuation
        i++;
        continue;
      }
      break;
    }
    const [head, ...rest] = body;
    const restIndent = Math.min(...rest.filter((r) => r.trim()).map(indentOf), 99);
    const nested = rest.map((r) => r.slice(Math.min(restIndent, indentOf(r)))).join("\n");
    const headLines = [head];
    let nestedSrc = nested;
    // plain continuation text (not a nested block) belongs to the item's first paragraph
    const nl = nested.split("\n");
    let k = 0;
    while (k < nl.length && nl[k].trim() !== "" && !listRe.test(nl[k]) && !/^\s*(#|>|\||```|~~~)/.test(nl[k])) headLines.push(nl[k++].trim());
    nestedSrc = nl.slice(k).join("\n");
    const inner = nestedSrc.trim() ? "\n" + mdToHtml(nestedSrc) : "";
    items.push(`<li>${inline(headLines.join(" "))}${inner}</li>`);
  }
  const tag = ordered ? "ol" : "ul";
  const attr = ordered && start !== 1 ? ` start="${start}"` : "";
  return { html: `<${tag}${attr}>\n${items.join("\n")}\n</${tag}>`, i };
}

/** Convert markdown to HTML. Grade shorthands are expanded too. */
export function mdToHtml(md) {
  const lines = String(md).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    // fenced code
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)/);
    if (fence) {
      const close = fence[1];
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(close)) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code${fence[2] ? ` class="language-${escAttr(fence[2])}"` : ""}>${escAll(buf.join("\n"))}</code></pre>`);
      continue;
    }
    // indented code (four spaces, not inside a list)
    if (/^( {4}|\t)/.test(line) && !listRe.test(line)) {
      const buf = [];
      while (i < lines.length && (/^( {4}|\t)/.test(lines[i]) || lines[i].trim() === "")) buf.push(lines[i++].replace(/^( {4}|\t)/, ""));
      out.push(`<pre><code>${escAll(buf.join("\n").replace(/\n+$/, ""))}</code></pre>`);
      continue;
    }
    // heading
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }
    // horizontal rule
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    // blockquote
    if (/^\s{0,3}>/.test(line)) {
      const buf = [];
      while (i < lines.length && lines[i].trim() !== "" && (/^\s{0,3}>/.test(lines[i]) || buf.length)) {
        if (!/^\s{0,3}>/.test(lines[i]) && /^\s*(#|[-*+]\s|\d+[.)]\s|```)/.test(lines[i])) break;
        buf.push(lines[i++].replace(/^\s{0,3}> ?/, ""));
      }
      out.push(`<blockquote>\n${mdToHtml(buf.join("\n"))}\n</blockquote>`);
      continue;
    }
    // table
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : ""));
      const al = (k) => (aligns[k] ? ` style="text-align:${aligns[k]}"` : "");
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) rows.push(splitRow(lines[i++]));
      out.push(
        `<div class="tw"><table>\n<thead><tr>${head.map((c, k) => `<th${al(k)}>${inline(c)}</th>`).join("")}</tr></thead>\n<tbody>\n` +
          rows.map((r) => `<tr>${head.map((_, k) => `<td${al(k)}>${inline(r[k] ?? "")}</td>`).join("")}</tr>`).join("\n") +
          `\n</tbody>\n</table></div>`,
      );
      continue;
    }
    // list
    if (listRe.test(line)) {
      const r = parseList(lines, i);
      out.push(r.html);
      i = r.i;
      continue;
    }
    // raw HTML block: passes through until a blank line
    if (/^\s*<\/?[a-zA-Z][a-zA-Z0-9-]*[\s>\/]|^\s*<!--/.test(line)) {
      const buf = [];
      while (i < lines.length && lines[i].trim() !== "") buf.push(lines[i++]);
      out.push(buf.join("\n"));
      continue;
    }
    // paragraph
    const buf = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^\s{0,3}(#{1,6}\s|>|```|~~~)/.test(lines[i]) &&
      !(buf.length && listRe.test(lines[i])) &&
      !(lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]))
    ) {
      buf.push(lines[i++].trim());
    }
    if (!buf.length) buf.push(lines[i++].trim());
    out.push(`<p>${inline(buf.join("\n"))}</p>`);
  }
  return expandGrades(out.join("\n"));
}
