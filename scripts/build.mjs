#!/usr/bin/env node
// Render every room in rooms/ into site/.
//
//   rooms/<slug>/room.json        title, date, process steps, sections, page list
//   rooms/<slug>/pages/<id>.html  body of each page (plain HTML, no shell)
//   rooms/<slug>/pages/<id>.md    or markdown, converted when there is no .html
//
// Grade shorthands {v} {p} {w} {i} {n} {np} {u} expand to grade spans in both.
//
// room.json "summary", "meetings" and "deadlines" go at the top of the room index
// (the paragraph, a countdown to the next meeting, the open deadlines), and the
// meetings and deadlines are rendered at the top of the "process" page.
//
// The build wraps each page in templates/page.html, builds the room index from
// templates/index.html, adds a jump bar from the page's <h2>s, and counts the
// verification grades and source links on each page for the index cards.
// It also writes site/_headers and site/robots.txt, and for every room:
//   site/<slug>/assist.html                   the live helper page (+ assist/, assist-sw.js, assist-manifest.json)
//   site/<slug>/knowledge.md                  the whole room as one file, for the silent helper
//   netlify/functions/corpus/<slug>.json      the same, for the live helper functions
// examples/<name>/ holds rooms kept as finished HTML (copied as they are).
//
// The form check: a room with form data (ledgers in work/osint/) is built only when its form
// check passes (scripts/lib/form.mjs formGate, the same check as npm run form -- <slug> --check).
// A room that fails is refused, and nothing is built or removed, unless --draft is passed:
//   node scripts/build.mjs [<slug>] [--draft]
// Rooms without form data build as before.
// No dependencies.

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync, copyFileSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readPageBody, isPersonPage, hideNoneRows, stripComments, dropEmptyChecklists } from "./lib/pages.mjs";
import { summaryHtml, asideHtml, oneCardWhen, processBlock } from "./lib/schedule.mjs";
import { GROUPS, groupOf, partOf } from "./lib/compose.mjs";
import {
  GRADES, esc, text, initials, minutes, longDate, ev, evStatus, donut, legend, verdictChip, headshot, drivesStrip, dealPath,
  bar, crumbs, demoAttrs, pageStatus, liftTldr, sourceChips, fillMarks, jumpBar, searchBox,
} from "./lib/render.mjs";
import { roomForm, formGate } from "./lib/form.mjs";
import { formBlock, formPage, insertAfterLead, insertBeforeTail } from "./lib/form-render.mjs";
import { moduleVars } from "./osint/run.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// DR_OUT (tests) builds somewhere else, with the corpus beside it instead of in netlify/functions.
const out = process.env.DR_OUT || join(root, "site");
// DR_ROOMS (tests) reads rooms from another folder.
const roomsRoot = process.env.DR_ROOMS || join(root, "rooms");
const corpusRoot = process.env.DR_OUT ? join(process.env.DR_OUT, "_corpus") : join(root, "netlify", "functions", "corpus");
const tpl = (f) => readFileSync(join(root, "templates", f), "utf8");
const fill = (t, vars) => t.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? vars[k] : ""));
const DEFAULT_ACCENT = "#8b2fd6";
const STATUS_LABEL = { found: "Found", weak: "Weak", none: "Empty" };
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
// Footprint pages report found, weak and empty rows rather than a verified share.
const isFootprint = (id) => /^(socials|partner-socials|names)-/.test(id);

// Which OSINT module fills which ledger variable (from each module's own declaration): the form
// uses it to tell "searched, nothing found" from "no tool yet".
const MODULE_VARS = await moduleVars();

const args = process.argv.slice(2);
const draft = args.includes("--draft");

// The form and its check, once per room (the pre-build check and the build share them).
const forms = new Map();
function formOf(slug) {
  if (!forms.has(slug)) {
    const dir = join(roomsRoot, slug);
    const room = JSON.parse(readFileSync(join(dir, "room.json"), "utf8"));
    const pageIds = new Set((room.sections || []).flatMap((s) => (s.pages || []).map((p) => p.id)));
    const form = roomForm(dir, { moduleVars: MODULE_VARS, pageIds });
    forms.set(slug, { form, gate: form ? formGate(form) : null });
  }
  return forms.get(slug);
}

function fail(msg) {
  console.error("build: " + msg);
  process.exit(1);
}

// Pass 1: count grades, sources and words on a page body (before the shell is known).
function measure(body) {
  const counted = stripComments(body);
  const counts = Object.fromEntries(GRADES.map(([k]) => [k, (counted.match(new RegExp(`class="grade ${k}"`, "g")) || []).length]));
  const sources = (counted.match(/class="src"/g) || []).length;
  const words = text(counted).split(" ").length;
  return { counts, sources, words, minutes: minutes(words), search: text(counted).toLowerCase().slice(0, 4000) };
}

// Pass 2: the page in its shell, with kicker, short version, jump bar, legend and pager.
function renderPage(room, page, body, ctx) {
  const m = ctx.meta[page.id];
  const lifted = liftTldr(body);
  const j = jumpBar(fillMarks(sourceChips(lifted.body)));
  const graded = GRADES.some(([k]) => m.counts[k]);
  const total = GRADES.reduce((a, [k]) => a + m.counts[k], 0);
  let evText = "";
  if (graded) {
    evText = isFootprint(page.id)
      ? `${m.counts.verified + m.counts.partly} found, ${m.counts.weak + m.counts.inference + m.counts.unknown} weak, ${m.counts.none} none`
      : `${m.counts.verified} verified of ${total} graded`;
  }
  const { prev, next, kicker, sectionName } = ctx.nav(page.id);
  const link = (p, lab) => `<a href="${p.id}.html"><small>${lab}</small><b>${esc(p.title)}</b></a>`;
  const pager = prev || next ? `<nav class="pager" aria-label="Previous and next page">${prev ? link(prev, "Previous") : ""}${next ? link(next, `Next in ${esc(sectionName)}`) : ""}</nav>` : "";
  const common = {
    slug: esc(room.slug), pageCount: String(ctx.pageCount), demoAttrs: demoAttrs(room), accent: esc(room.accent || DEFAULT_ACCENT),
    roomTitle: esc(room.title), pageTitle: esc(page.title), pageId: esc(page.id),
    notice: room.notice ? `<p class="notice">${esc(room.notice)}</p>` : "",
  };
  if (page.id === "one-card") {
    const oc = oneCardWhen(room, ctx.now);
    return fill(tpl("one-card.html"), {
      ...common,
      bar: bar(room, { crumbs: crumbs([["The one card", null]]), total: ctx.pageCount }),
      heading: esc(oc.heading || page.title),
      when: oc.when,
      body: j.body,
    });
  }
  return fill(tpl("page.html"), {
    ...common,
    bar: bar(room, { crumbs: crumbs(ctx.crumbs(page.id)), total: ctx.pageCount }),
    kicker,
    blurb: esc(page.blurb),
    asOfLong: esc(longDate(room.asOf)),
    minutes: String(m.minutes),
    sourcesSpan: m.sources ? `<span>${plural(m.sources, "source")}</span>` : "",
    evSpan: graded ? `<span class="evwrap">${ev(m.counts, "88px")}${esc(evText)}</span>` : "",
    legend: graded ? legend() : "",
    tldr: lifted.tldr,
    jumps: j.nav,
    body: j.body,
    pager,
  });
}

const rowItem = (page, m) => {
  const s = esc(`${page.title} ${page.blurb} ${m.search}`.toLowerCase());
  const bits = [`${m.minutes} min`, ...(m.sources ? [plural(m.sources, "source")] : [])].join(" · ");
  return `<li class="item" data-s="${s}"><a class="row" href="${esc(page.href || page.id + ".html")}" data-page-id="${page.id}"><b>${esc(page.title)}</b><span class="p">${esc(page.blurb)}</span><span class="m"><span>${bits}</span>${ev(m.counts, "72px")}<span class="rd"></span></span></a></li>`;
};

// The section's "in one look" box: room.json sections[].brief = { level, bullets[], hold }.
function brief(b, head = "In one look", extra = "") {
  if (!b || (!b.bullets?.length && !b.hold && !b.level && !extra)) return "";
  return `<div class="brief"><p class="bh">${esc(head)}${b.level ? ` <em>${esc(b.level)}</em>` : ""}</p>${
    b.bullets?.length ? `<ul>${b.bullets.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""
  }${extra}${b.hold ? `<p class="hold"><b>Hold:</b> ${esc(b.hold)}</p>` : ""}</div>`;
}
const famLine = (p) => (p?.family ? `<p class="fam"><b>Personal:</b> ${esc(p.family)} ${p.familyGrade ? `<span class="grade ${esc(p.familyGrade)}">${esc(GRADES.find(([k]) => k === p.familyGrade)?.[1] || "")}</span>` : ""}</p>` : "");

// Counterparty, people, modes and org type, when room.json has them (a line under the summary).
function facts(room) {
  const bits = [];
  if (room.ourSide) bits.push(`<span><b>Our side</b> ${esc(room.ourSide)}</span>`);
  if (room.counterparty) bits.push(`<span><b>Counterparty</b> ${esc(room.counterparty)}</span>`);
  if (room.people?.length) bits.push(`<span><b>Across the table</b> ${room.people.map((p) => esc(p.name)).join(", ")}</span>`);
  if (room.modes?.length) bits.push(`<span><b>Mode</b> ${room.modes.map(esc).join(", ")}</span>`);
  if (room.orgType) bits.push(`<span><b>Org type</b> ${esc(room.orgType)}</span>`);
  return bits.length ? `<p class="room-meta">${bits.join("")}</p>` : "";
}

const pron = (p) => ({ she: ["she", "her", "Her"], he: ["he", "him", "His"] })[p?.pronoun] || ["they", "them", "Their"];

function buildRoom(slug) {
  const dir = join(roomsRoot, slug);
  const room = JSON.parse(readFileSync(join(dir, "room.json"), "utf8"));
  if (room.slug !== slug) fail(`rooms/${slug}/room.json has slug "${room.slug}"`);
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(slug)) fail(`room slug "${slug}" must be lower-case letters, digits and dashes`);
  const now = room.demo?.now ? new Date(room.demo.now) : new Date();

  const dest = join(out, slug);
  mkdirSync(join(dest, "assets"), { recursive: true });
  copyFileSync(join(root, "templates", "room.css"), join(dest, "assets", "room.css"));
  copyFileSync(join(root, "templates", "room.js"), join(dest, "assets", "room.js"));

  // The form (config/form packs + the ledgers in work/osint/), when the room has ledgers. Code
  // renders every bucket on its page with its state, and a "The form" page with all of them.
  // Rooms without ledgers build as before.
  const pageIds0 = new Set(room.sections.flatMap((s) => s.pages.map((p) => p.id)));
  const { form, gate } = formOf(slug);
  if (form) {
    if (!pageIds0.has("form")) {
      const home = room.sections.find((s) => s.id === "record") || room.sections.at(-1);
      home.pages = [...home.pages, { id: "form", title: "The form", blurb: "Every bucket, its state and its source, filled by code from the ledger.", _generated: true }];
    }
    // An empty summary is filled from the Start here bucket (AI judgement that cites the ledger).
    const sum = form.buckets.find((b) => b.id === "start.summary" && b.state === "filled");
    if (!String(room.summary || "").trim() && sum?.rows[0]) room.summary = String(sum.rows[0].value);
  }

  // Pass 1: read and measure every page.
  const meta = {};
  const bodies = {};
  const entries = [];
  const order = [];
  for (const section of room.sections) {
    for (const page of section.pages) {
      const pg = page._generated && form ? { body: formPage(form, gate, { draft }) } : readPageBody(dir, page.id);
      if (!pg) fail(`missing page rooms/${slug}/pages/${page.id}.html (or .md)`);
      if (form && !page._generated) {
        pg.body = dropEmptyChecklists(pg.body);
        const mine = form.buckets.filter((b) => b.pageId === page.id);
        if (mine.length) pg.body = page.id === "one-card" ? insertAfterLead(pg.body, formBlock(mine)) : insertBeforeTail(pg.body, formBlock(mine));
      }
      pg.clean = stripComments(pg.body);
      if (isPersonPage(page.id)) {
        pg.body = hideNoneRows(pg.body);
        pg.clean = stripComments(pg.body);
      }
      if (page.id === "process") {
        // The meetings and deadlines from room.json, after the page's opening paragraph.
        const block = processBlock(room);
        const at = pg.body.search(/<\/p>/i);
        const firstH2 = pg.body.search(/<h2[\s>]/i);
        pg.body = at > -1 && (firstH2 < 0 || at < firstH2) ? pg.body.slice(0, at + 4) + "\n" + block + pg.body.slice(at + 4) : block + pg.body;
        pg.clean = pg.body.replace(/<!--[\s\S]*?-->/g, "");
      }
      bodies[page.id] = pg.body;
      meta[page.id] = measure(pg.body);
      order.push({ page, section });
      entries.push({ title: `${section.title} / ${page.title}`, source: page.id + ".html", text: knowText(pg.clean), kind: kindOf(page.id), id: page.id });
    }
  }
  const pageCount = order.length;
  const ids = new Set(order.map((o) => o.page.id));
  const personOf = (section) => (section.person ? (room.people || []).find((p) => p.slug === section.person) || { name: section.title, slug: section.person } : null);

  // Kicker, crumbs and previous/next: within a person's section, else in room order.
  const ctx = {
    meta, now, pageCount,
    nav(id) {
      const i = order.findIndex((o) => o.page.id === id);
      const { section } = order[i];
      const person = personOf(section);
      const sib = order.filter((o) => (person ? o.section === section : true));
      const k = sib.findIndex((o) => o.page.id === id);
      const kicker = person
        ? `<a href="person-${esc(person.slug)}.html">${esc(person.name)}</a> · page ${k + 1} of ${sib.length}`
        : `<a href="index.html#${esc(section.id)}">${esc(section.title)}</a>`;
      return { prev: sib[k - 1]?.page, next: sib[k + 1]?.page, kicker, sectionName: person ? person.name : order[i + 1]?.section.title || section.title };
    },
    crumbs(id) {
      const { page, section } = order.find((o) => o.page.id === id);
      const person = personOf(section);
      return person ? [[person.name, `person-${person.slug}.html`], [page.title, null]] : [[section.title, `index.html#${section.id}`], [page.title, null]];
    },
  };
  for (const { page } of order) writeFileSync(join(dest, page.id + ".html"), renderPage(room, page, bodies[page.id], ctx));

  // ---------------- the index ----------------
  const status = (p) => pageStatus(p, meta[p.id].counts);
  const totals = (pages) => Object.fromEntries(GRADES.map(([k]) => [k, pages.reduce((a, p) => a + meta[p.id].counts[k], 0)]));
  const readOf = (pages) => pages.map((p) => p.id).join(" ");
  const tally = (pages) => {
    const st = pages.map(status);
    return { found: st.filter((x) => x === "found").length, weak: st.filter((x) => x === "weak").length, none: st.filter((x) => x === "none").length };
  };
  const STLAB = { found: "found", weak: "weak", none: "empty, searches are in the OSINT log" };
  const cover = (pages) => `<ul class="cover">${pages.map((p) => `<li class="item ${status(p)}" data-s="${esc(`${p.title} ${p.blurb} ${meta[p.id].search}`.toLowerCase())}"><a href="${p.id}.html" data-page-id="${p.id}">${esc(p.title)}<span class="vh">, ${STLAB[status(p)]}</span></a></li>`).join("")}</ul>`;
  // A person's pages are split into a Personal and a Professional half.
  const halves = (pages, inner) =>
    `<div class="halves${inner === checklist ? " pages2" : ""}">${["personal", "professional"]
      .map((part) => [part, pages.filter((p) => partOf(p) === part)])
      .filter(([, ps]) => ps.length)
      .map(([part, ps]) => `<div class="half"><h3>${part === "personal" ? "Personal" : "Professional"}</h3>${inner(ps)}</div>`)
      .join("")}</div>`;
  function checklist(pages) {
    return `<ol class="checklist">${pages.map((p) => {
      const st = status(p);
      return `<li class="${st}"><a href="${p.id}.html" data-page-id="${p.id}"><span class="ic" aria-hidden="true"></span><b>${esc(p.title)}<span class="vh">: ${STATUS_LABEL[st]}.</span></b><span class="f">${esc(p.finding || p.blurb || "")}</span><span class="s"><span>${meta[p.id].minutes} min</span></span></a></li>`;
    }).join("")}</ol>`;
  }
  const pvTop = (person) => {
    const [, obj] = pron(person);
    const v = person.verdict ? `<p class="vline"><b>Verdict</b> ${verdictChip(person.verdict)} ${esc(person.verdict.line || "")}</p>` : "";
    const d = person.drives ? `<p class="vdrive"><b>What drives ${obj}</b> ${esc(person.drives)}</p>` : "";
    return v || d ? `<div class="pv-top">${headshot(person.name, "md")}<div>${v}${d}</div></div>` : "";
  };

  const chapter = (s, open) => {
    const person = personOf(s);
    let title, cnt, body;
    if (person) {
      const t = tally(s.pages);
      title = `<h2>${esc(person.name)} ${verdictChip(person.verdict)}</h2>`;
      cnt = `${donut({ verified: t.found, weak: t.weak, none: t.none }, 36, String(t.found))}<span>${t.found} found · ${t.weak} weak</span>`;
      const first = person.name.split(" ")[0];
      body = pvTop(person) + brief(s.brief || {}, `${first} in one look`, famLine(person)) + halves(s.pages, cover) +
        `<a class="open-person" href="person-${esc(person.slug)}.html">Open ${esc(first)}'s section, ${plural(s.pages.length, "page")}</a>`;
    } else {
      const tot = totals(s.pages);
      const st = s.status && { done: "Done", next: "Next", todo: "To come" }[s.status];
      title = `<h2>${esc(s.title)}${st ? ` <span class="st ${s.status}">${st}</span>` : ""}</h2>`;
      cnt = (Object.values(tot).some(Boolean) ? donut(tot, 36) : "") + `<span>${plural(s.pages.length, "page")}</span>`;
      body = (s.note ? `<p class="secnote">${esc(s.note)}</p>` : "") + brief(s.brief) + `<ul class="rows">${s.pages.map((p) => rowItem(p, meta[p.id])).join("")}</ul>`;
    }
    return `<details class="sec" id="${esc(s.id)}"${open ? " open" : ""}><summary>${title}<span class="cnt">${cnt}<span class="vh">, read </span><span data-read-of="${readOf(s.pages)}"></span></span></summary><div class="body">${body}</div></details>`;
  };

  // Sections are shown in their groups: Start here on top, then the people, the role and
  // the deal, and the company as three big expandable blocks, then "Behind the room"
  // (the mirror and the record), collapsed, at the bottom.
  const grouped = GROUPS.map((g) => ({ ...g, sections: room.sections.filter((s) => groupOf(s) === g.id) }));
  const NOTES = {
    person: "One block per person across the table, each in two halves: personal and professional.",
    role: "The ask, the pitch and the deal, the meetings and the companion, practice, and the one card.",
    company: "Who they are and what drives them, the money, the rules, the outside view and the organisation.",
    behind: "The mirror (what they will find on us) and the record: corrections, sources and the OSINT log.",
  };
  const people = room.people || [];
  const personLink = (p) => (room.sections.some((s) => s.person === p.slug) ? `person-${p.slug}.html` : p.page ? `${p.page}.html` : "");
  const personCard = (p) => {
    const [subj] = pron(p);
    const href = personLink(p);
    const s = esc(`${p.name} ${p.title || ""} ${p.judges || ""} ${p.verdict?.line || ""}`.toLowerCase());
    const sec = room.sections.find((x) => x.person === p.slug);
    const t = sec ? tally(sec.pages) : null;
    const inner = `<span class="who">${headshot(p.name, "sm")}<span><span class="nm">${esc(p.name)}</span><br><span class="tt">${esc(p.title || "")}${p.since ? `, since ${esc(p.since)}` : ""}</span></span></span>` +
      (p.role ? `<span class="role${p.decides ? " decides" : ""}">${esc(p.role)}</span>` : "") +
      (p.verdict ? `<p class="pverdict">${verdictChip(p.verdict)} ${esc(p.verdict.line || "")}</p>` : "") +
      (p.judges ? `<p class="judges"><span>What ${subj} judge${subj === "they" ? "" : "s"} on</span>${esc(p.judges)}</p>` : "") +
      (p.overlaps?.length ? `<ul class="ovl">${p.overlaps.slice(0, 2).map((o) => `<li class="${esc(o.strength || "")}">${esc(o.label)}</li>`).join("")}</ul>` : "") +
      (t ? `<span class="foot">${evStatus(t.found, t.weak, 0, "100%")}<span>${t.found} found · ${t.weak} weak</span></span>` : "");
    return href ? `<a class="person item" href="${esc(href)}" data-s="${s}">${inner}</a>` : `<div class="person item" data-s="${s}">${inner}</div>`;
  };
  const tops = {
    person: people.length ? `<section class="gblock" data-hide-on-search aria-labelledby="pp"><h3 class="subh" id="pp">The people across the table <small>${plural(people.length, "person").replace("persons", "people")}</small></h3><div class="people">${people.map(personCard).join("")}</div></section>` : "",
    role: room.dealPath?.length ? `<section class="gblock" data-hide-on-search aria-labelledby="dp"><h3 class="subh" id="dp">How it gets signed <small>in order</small></h3>${dealPath(room.dealPath)}</section>` : "",
    company: "",
  };
  const open1 = (g, s, i) => g.id === "start" || s.status === "next" || (g.id !== "behind" && i === 0);
  const groupBlock = (g, num) => {
    const pages = g.sections.flatMap((s) => s.pages);
    if (!g.sections.length && !tops[g.id]) return "";
    const n = num ? `<span class="gnum" aria-hidden="true">${num}</span>` : '<span class="gnum back" aria-hidden="true"></span>';
    return `<details class="grp g-${g.id}" id="g-${g.id}"${g.id === "behind" ? "" : " open"}><summary>${n}<span class="gt"><h2>${esc(g.title)}</h2><span class="gn">${esc(NOTES[g.id] || "")}</span></span>` +
      `<span class="cnt"><span>${plural(pages.length, "page")}</span>${pages.length ? `<span class="vh">, read </span><span data-read-of="${readOf(pages)}"></span>` : ""}</span></summary>` +
      `<div class="gbody">${tops[g.id] || ""}${g.sections.map((s, i) => chapter(s, open1(g, s, i))).join("")}</div></details>`;
  };
  const start = grouped.find((g) => g.id === "start");
  const parts = grouped.filter((g) => g.id !== "start");
  const startHtml = start.sections.length
    ? `<section class="block" aria-labelledby="sh"><p class="eyebrow" data-hide-on-search>Start here</p><h2 id="sh">Read first</h2>${start.sections.map((s) => chapter(s, true)).join("")}</section>`
    : "";
  let num = 0;
  const sections = startHtml +
    `<section class="block parts" aria-labelledby="ch"><p class="eyebrow" data-hide-on-search>The room</p><h2 id="ch">${pageCount} pages in three parts <small>open or close each part</small></h2>` +
    parts.map((g) => groupBlock(g, g.id === "behind" ? "" : String(++num))).join("") + `</section>`;

  const railName = (s) => personOf(s)?.name || s.title.split(":")[0];
  const rail = `<nav class="rail" aria-label="Chapters"><h2>The room</h2><ol><li class="top"><a href="#start-here"><span>Start here</span></a></li>` +
    start.sections.map((s) => `<li><a href="#${esc(s.id)}"><span>${esc(railName(s))}</span><span class="c" data-read-of="${readOf(s.pages)}"></span></a></li>`).join("") +
    parts.filter((g) => g.sections.length || tops[g.id]).map((g) => {
      const pages = g.sections.flatMap((s) => s.pages);
      return `<li class="sub"><a class="grp" href="#g-${g.id}"><span>${esc(g.title.split(",")[0])}</span>${pages.length ? `<span class="c" data-read-of="${readOf(pages)}"></span>` : ""}</a><ol>` +
        g.sections.map((s) => `<li><a href="#${esc(s.id)}"><span>${esc(railName(s))}</span><span class="c" data-read-of="${readOf(s.pages)}"></span></a></li>`).join("") + `</ol></li>`;
    }).join("") +
    `</ol><div class="tools"><button type="button" id="xall">Expand all</button><button type="button" id="call">Collapse all</button></div></nav>`;

  const matters = room.matters?.length
    ? `<section class="block" data-hide-on-search aria-labelledby="mt"><p class="eyebrow">Start here</p><h2 id="mt">The three things that matter most</h2><ol class="matters">${room.matters
        .slice(0, 3)
        .map((m) => `<li><b>${esc(m.title)}</b><p>${esc(m.text)}${m.page ? ` <a href="${esc(m.page)}.html">${esc(m.link || "Read")}</a>` : ""}</p></li>`)
        .join("")}</ol></section>`
    : "";
  const drives = room.drives?.length
    ? `<section class="block" data-hide-on-search aria-labelledby="dn"><h2 id="dn">What drives ${esc(room.counterparty || room.title)} <small>financial, social, commercial, technical</small></h2>${drivesStrip(room.drives)}${
        ids.has("who-they-are") ? `<p class="blocknote">Evidence and sources for each line are on the company page. <a href="who-they-are.html">Who they are</a></p>` : ""
      }</section>`
    : "";
  const tools = room.tools?.length
    ? `<section class="block" data-hide-on-search aria-labelledby="tl"><h2 id="tl">Tools</h2><div class="tools-grid">${room.tools
        .filter((t) => ids.has(t.page))
        .map((t) => `<a class="tool" href="${esc(t.page)}.html"><b>${esc(t.title)}</b><span>${esc(t.text || "")}</span>${t.count ? `<em>${esc(t.count)}</em>` : ""}</a>`)
        .join("")}</div></section>`
    : "";

  writeFileSync(
    join(dest, "index.html"),
    fill(tpl("index.html"), {
      slug: esc(slug),
      demoAttrs: demoAttrs(room),
      bar: bar(room, { search: true, total: pageCount }),
      roomTitle: esc(room.title),
      subtitle: esc(room.subtitle || ""),
      asOfLong: esc(longDate(room.asOf)),
      modeText: room.modes?.length ? ` · ${esc(room.modes.join(", "))}` : "",
      pageCount: String(pageCount),
      summary: summaryHtml(room),
      schedule: asideHtml(room, now, ids),
      facts: facts(room),
      notice: room.notice ? `<p class="notice">${esc(room.notice)}</p>` : "",
      msearch: searchBox(true),
      rail,
      matters,
      drives,
      tools,
      sections,
      footer: esc(room.footer || "Nothing in this room is for sending. It is read before the conversation, not consulted during it."),
      accent: esc(room.accent || DEFAULT_ACCENT),
    }),
  );

  // ---------------- person landings ----------------
  for (const s of room.sections.filter((x) => x.person)) {
    const person = personOf(s);
    const t = tally(s.pages);
    const [subj, , poss] = pron(person);
    const first = person.name.split(" ")[0];
    writeFileSync(
      join(dest, `person-${person.slug}.html`),
      fill(tpl("person.html"), {
        slug: esc(slug), pageCount: String(pageCount), demoAttrs: demoAttrs(room), accent: esc(room.accent || DEFAULT_ACCENT), roomTitle: esc(room.title),
        bar: bar(room, { crumbs: crumbs([[person.name, null]]), total: pageCount }),
        name: esc(person.name),
        headshot: headshot(person.name, "lg"),
        tt: esc([person.title, room.counterparty || room.title].filter(Boolean).join(", ") + (person.since ? `, since ${person.since}` : "")),
        tags: [person.role ? `<span class="role${person.decides ? " decides" : ""}">${esc(person.role)}</span>` : "", ...(person.tags || []).map((x) => `<span class="role">${esc(x)}</span>`)].join(""),
        verdict: person.verdict ? `<p class="vline"><b>Verdict</b> ${verdictChip(person.verdict)} ${esc(person.verdict.line || "")}${s.pages.some((p) => p.id.startsWith("persona-")) ? ` <a href="${s.pages.find((p) => p.id.startsWith("persona-")).id}.html">Claims against the record</a>` : ""}</p>` : "",
        judges: person.judges ? `<p class="judges"><span>What ${subj} judge${subj === "they" ? "" : "s"} on</span>${esc(person.judges)}</p>` : "",
        brief: brief(s.brief || {}, `${first} in one look`, famLine(person)),
        drives: person.drivers?.length ? `<h2 class="h2s">What drives ${pron(person)[1]}</h2>${drivesStrip(person.drivers)}` : "",
        found: String(t.found), weak: String(t.weak), n: String(s.pages.length),
        mix: evStatus(t.found, t.weak, t.none),
        ids: readOf(s.pages),
        possessive: poss,
        halves: halves(s.pages, checklist),
      }),
    );
  }

  const personas = room.sections.flatMap((s) => s.pages).filter((p) => p.id.startsWith("persona-")).map((p) => {
    const [name, ...rest] = p.title.replace(/^Persona:\s*/i, "").split(",");
    return { name: name.trim(), title: rest.join(",").trim(), page: p.id + ".html" };
  });
  writeHelper(slug, room.title, room.asOf, [...entries, ...workEntries(dir)], { ...room, personas });
  return { slug, pageCount };
}

// ---------------------------------------------------------------- companion knowledge
// Page text keeps each fact's grade inline as [grade: <kind>], so the companion can
// show the grade on a FACT card. The kind tells it which pages are personas, banks,
// the one card, the glossary and the corrections.
const knowText = (html) => text(html.replace(/<span class="grade ([a-z-]+)"[^>]*>[\s\S]*?<\/span>/g, " [grade: $1] "));
function kindOf(id) {
  if (id.startsWith("persona-")) return "persona";
  if (/-bank$|^push-back-gym$/.test(id)) return "bank";
  if (/^meeting-\d+$/.test(id)) return "meeting";
  return { "one-card": "one-card", glossary: "glossary", "plain-words": "glossary", "corrections-log": "corrections", "our-side": "our-side" }[id] || "page";
}
// What the user fed the companion and saved (rooms/<slug>/work/fed/*.md), and the
// connector findings (rooms/<slug>/work/connectors/*.md, never the raw/ folder).
// Contact details are scrubbed: no addresses or phone numbers reach the companion.
const scrub = (s) => s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email removed]").replace(/\+?\d[\d ().-]{8,}\d/g, (m) => (m.replace(/\D/g, "").length >= 9 ? "[phone removed]" : m));
function workEntries(dir) {
  const out = [];
  for (const [sub, kind, label] of [["fed", "fed", "Fed"], ["connectors", "connector", "Connector findings"]]) {
    const d = join(dir, "work", sub);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((f) => f.endsWith(".md")).sort()) {
      const md = readFileSync(join(d, f), "utf8");
      const t = (md.match(/^#\s+(.+)$/m) || [, f.replace(/\.md$/, "")])[1].trim();
      out.push({ title: `${label} / ${t}`, source: `work/${sub}/${f}`, text: scrub(md.replace(/\s+/g, " ").trim()).slice(0, 20000), kind });
    }
  }
  return out;
}

// The live helper page and its shell files, plus the room flattened to text for both
// helpers. The companion also gets the people, personas, meetings and summary, so it
// can guess who is speaking, read their persona, and know which meeting it is in.
function writeHelper(slug, title, asOf, entries, room = {}) {
  copyFileSync(join(root, "templates", "assist.html"), join(out, slug, "assist.html"));
  const shell = join(root, "templates", "assist");
  mkdirSync(join(out, slug, "assist"), { recursive: true });
  for (const f of readdirSync(shell)) {
    if (f === "sw.js") copyFileSync(join(shell, f), join(out, slug, "assist-sw.js")); // scope: the room folder
    else if (f === "manifest.json") writeFileSync(join(out, slug, "assist-manifest.json"), readFileSync(join(shell, f), "utf8").replace(/__TITLE__/g, String(title).replace(/["\\]/g, "")));
    else copyFileSync(join(shell, f), join(out, slug, "assist", f));
  }
  const people = (room.people || []).map((p) => ({ name: p.name, title: p.title || "", slug: p.slug }));
  const personas = room.personas || [];
  const head = [
    room.summary ? `Summary: ${room.summary}` : "",
    people.length ? `People across the table: ${people.map((p) => p.name + (p.title ? ` (${p.title})` : "")).join("; ")}` : "",
    personas.length ? `Persona pages: ${personas.map((p) => `${p.name}${p.title ? `, ${p.title}` : ""} (${p.page})`).join("; ")}` : "",
    room.meetings?.length ? `Meetings: ${room.meetings.map((m) => [m.date, m.time, m.title, m.who, m.format, m.length].filter(Boolean).join(" · ")).join("; ")}` : "",
  ].filter(Boolean).join("\n");
  const md = `# ${title}: room knowledge (as of ${asOf})\n\n${head ? head + "\n\n" : ""}` + entries.map((e) => `## ${e.title}\nSource: ${e.source}\n\n${e.text}\n`).join("\n");
  writeFileSync(join(out, slug, "knowledge.md"), md);
  const corpusDir = corpusRoot;
  mkdirSync(corpusDir, { recursive: true });
  writeFileSync(join(corpusDir, slug + ".json"), JSON.stringify({ room: slug, title, asOf, summary: room.summary || "", people, personas, meetings: room.meetings || [], entries }));
}

// Rooms kept as finished HTML: copy as-is, then flatten their pages for the helpers.
function copyExample(name) {
  const src = join(root, "examples", name);
  const dest = join(out, name);
  cpSync(src, dest, { recursive: true });
  const files = readdirSync(src).filter((f) => f.endsWith(".html")).sort((a, b) => (a === "index.html" ? -1 : b === "index.html" ? 1 : a.localeCompare(b)));
  // Each page is capped so the whole room fits in one cached prompt.
  const entries = files.map((f) => {
    const html = readFileSync(join(src, f), "utf8");
    const t = (html.match(/<title>(.*?)<\/title>/s) || [, f])[1];
    const body = html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, "");
    return { title: text(t), source: f, text: text(body).slice(0, 8000) };
  });
  writeHelper(name, name, "see pages", entries);
  return { slug: name, pageCount: files.length };
}

const only = args.find((a) => !a.startsWith("--"));
const slugs = readdirSync(roomsRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory() && (!only || d.name === only))
  .filter((d) => existsSync(join(roomsRoot, d.name, "room.json")) || (console.warn(`build: skipping rooms/${d.name}/ (no room.json)`), false))
  .map((d) => d.name);
if (!slugs.length) fail("no rooms found in rooms/");

// The form check, before anything is written or removed: a room with form data that fails it
// is not built (and site/ is left as it was) unless this is a draft build.
const refused = slugs.filter((s) => formOf(s).gate && !formOf(s).gate.ok);
for (const s of refused) {
  const { gate } = formOf(s);
  console.error(`build: ${s}: form check FAILED (${gate.errors.length})${draft ? "; building anyway as a draft (--draft)" : ""}`);
  for (const e of gate.errors.slice(0, 40)) console.error(`  - ${e}`);
}
if (refused.length && !draft) fail(`not building: the form check failed for ${refused.join(", ")}. Fix what it lists (npm run form -- <slug> --check), or pass --draft to build a draft.`);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

rmSync(corpusRoot, { recursive: true, force: true });
const built = slugs.map(buildRoom);
const exDir = join(root, "examples");
if (existsSync(exDir) && !only) {
  for (const d of readdirSync(exDir, { withFileTypes: true })) if (d.isDirectory()) built.push(copyExample(d.name));
}

// The site root says nothing about what is behind it.
writeFileSync(join(out, "index.html"), tpl("root.html"));
writeFileSync(join(out, "robots.txt"), "User-agent: *\nDisallow: /\n");
writeFileSync(
  join(out, "_headers"),
  `/*\n  X-Robots-Tag: noindex, nofollow, noarchive, nosnippet\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n\n` +
    built.map((b) => `/${b.slug}/*\n  Cache-Control: private, max-age=0, no-store\n`).join("\n"),
);

for (const b of built) console.log(`built ${b.slug}: ${b.pageCount} pages -> site/${b.slug}/ (+ assist.html, knowledge.md)${refused.includes(b.slug) ? " [DRAFT: form check failed]" : ""}`);
