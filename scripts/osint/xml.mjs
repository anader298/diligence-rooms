// A small tag reader for flat XML: RSS 2.0, Atom, YouTube channel feeds, SEC Atom. These schemas
// are flat and stable, so a regex reader is enough and keeps the OSINT layer free of npm deps.

import { decodeEntities } from "./person-lib.mjs";

const unCdata = (s) => String(s ?? "").replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
const clean = (s) => decodeEntities(unCdata(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim();

/** Text of the first <tag>…</tag> in xml (namespaced tags allowed: "media:description"). */
export function tagText(xml, tag) {
  const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = String(xml || "").match(new RegExp(`<${esc}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc}>`, "i"));
  return m ? clean(m[1]) : null;
}

/** Value of attribute attr on the first <tag …> (self-closing or not). */
export function tagAttr(xml, tag, attr, where = null) {
  const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const m of String(xml || "").matchAll(new RegExp(`<${esc}\\s([^>]*?)/?>`, "gi"))) {
    if (where && !where.test(m[1])) continue;
    const a = m[1].match(new RegExp(`\\b${attr}=["']([^"']*)["']`, "i"));
    if (a) return decodeEntities(a[1]);
  }
  return null;
}

/** Every <tag>…</tag> block (raw inner xml). */
export function blocks(xml, tag) {
  const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...String(xml || "").matchAll(new RegExp(`<${esc}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc}>`, "gi"))].map((m) => m[1]);
}

function authorOf(b) {
  const dc = tagText(b, "dc:creator");
  if (dc) return dc;
  const a = tagText(b, "author");
  if (!a) return null;
  return tagText(a, "name") || a.replace(/<[^>]+>/g, " ").trim() || null;
}

/**
 * Items of an RSS or Atom feed: [{ title, url, date, author, summary }], plus the feed title.
 * Dates are ISO days (YYYY-MM-DD) when parseable.
 */
export function parseFeed(xml) {
  const s = String(xml || "");
  const isAtom = /<feed[\s>]/i.test(s) && !/<rss[\s>]/i.test(s);
  const day = (d) => {
    if (!d) return null;
    const t = Date.parse(d);
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
  };
  const head = s.split(/<(?:item|entry)[\s>]/i)[0];
  const title = tagText(head, "title");
  const items = blocks(s, isAtom ? "entry" : "item").map((b) => ({
    title: tagText(b, "title"),
    url: isAtom ? tagAttr(b, "link", "href", /rel=["']alternate["']|^(?![\s\S]*rel=)/i) || tagAttr(b, "link", "href") : tagText(b, "link") || tagText(b, "guid"),
    date: day(tagText(b, isAtom ? "published" : "pubDate") || tagText(b, "updated") || tagText(b, "dc:date")),
    author: authorOf(b),
    summary: (tagText(b, "description") || tagText(b, "summary") || tagText(b, "media:description") || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400) || null,
    extra: Object.fromEntries([...b.matchAll(/<([a-z]+:[a-zA-Z]+)>([^<]{1,200})<\/\1>/g)].map((m) => [m[1], clean(m[2])])),
  }));
  return { title, isAtom, items };
}
