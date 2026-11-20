// Compose a new room from the skeleton: core + one or more modes + one org type,
// with the per-person pages repeated for each person across the table.
//
//   templates/skeleton/core/room.json            base room (tokens filled here)
//   templates/skeleton/core/pages/<id>.html      core pages
//   templates/skeleton/core/person/<id>.html     per-person pages (id holds __PERSON_SLUG__)
//   templates/skeleton/modes/<mode>/pack.json    + pages/   interviewing | deal | audit | pitch
//   templates/skeleton/orgtypes/<type>/pack.json + pages/   asset-owner | private-equity | ...
//   templates/skeleton/extras/<name>/pack.json   optional packs, off by default (practice)
//
// If core/ is not there, the older flat skeleton (templates/skeleton/room.json +
// pages/) is used as the core and its "persona" page is repeated per person.
//
// Tokens: __SLUG__ __TITLE__ __DATE__ __COMPANY__ __PERSON__ __PERSON_SLUG__
// (plus __GOAL__ and __MEETING_DATE__). No dependencies.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MODES = ["interviewing", "deal", "audit", "pitch"];
export const ORG_TYPES = ["asset-owner", "private-equity", "public-company", "consultancy", "health-system", "government", "startup", "energy", "other"];
/** Optional page packs (templates/skeleton/extras/<name>), off unless asked for. */
export const EXTRAS = ["practice"];
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
/** The per-person page ids, in order (each becomes <id>-<person slug>). */
export const PERSON_PAGES = ["persona", "interests", "socials", "partner-socials", "linkedin", "education", "writing", "names", "own-words", "network", "public-record", "financials", "timeline", "relate"];
/** Per-person pages in the Personal half of a person's block; the rest are Professional. */
export const PERSONAL_PAGES = ["interests", "socials", "partner-socials", "names", "education", "financials", "relate"];
/**
 * The room index groups, in display order. "start" (Start here) sits on top, the three big
 * groups follow (the person, the role and the deal, the company), and "behind" (the mirror
 * and the record) is collapsed at the bottom.
 */
export const GROUPS = [
  { id: "start", title: "Start here" },
  { id: "person", title: "The people" },
  { id: "role", title: "The role, the deal, the specifics" },
  { id: "company", title: "The company" },
  { id: "behind", title: "Behind the room" },
];
const GROUP_BY_SECTION = { start: "start", them: "company", outside: "company", people: "company", brief: "company", person: "person", ask: "role", meetings: "role", drills: "role", mirror: "behind", record: "behind" };
/** The group a section belongs to: its own "group", else by its id (packs: modes -> role, org types -> company). */
export function groupOf(section) {
  const ids = GROUPS.map((g) => g.id);
  if (section && ids.includes(section.group)) return section.group;
  if (section?.person || section?.perPerson) return "person";
  const id = String(section?.id || "");
  if (GROUP_BY_SECTION[id]) return GROUP_BY_SECTION[id];
  if (ORG_TYPES.includes(id)) return "company";
  return "role";
}
/** "personal" or "professional" for a per-person page: its own "part", else by its id. */
export function partOf(page) {
  if (page?.part === "personal" || page?.part === "professional") return page.part;
  const id = String(page?.id || "");
  const base = [...PERSON_PAGES, ...Object.keys(RENAMED_PAGES)].sort((a, b) => b.length - a.length).find((x) => id === x || id.startsWith(x + "-"));
  return base && PERSONAL_PAGES.includes(RENAMED_PAGES[base] || base) ? "personal" : "professional";
}
/** Old page ids that now live under a new id (a room.json or pack may still name the old one). */
export const RENAMED_PAGES = { footprint: "socials" };
export const DEADLINE_KINDS = ["submission", "decision", "document", "prep", "follow-up", "other"];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const str = (x, max = 200) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Meetings and deadlines from the studio or the CLI, checked and sorted by date.
 * meetings: [{ date, time, title, who, format, length }]   deadlines: [{ date, title, kind, done }]
 * Rows with nothing in them are dropped; a row with content but no valid date is refused.
 */
export function normaliseSchedule(meetingsIn = [], deadlinesIn = []) {
  const meetings = (Array.isArray(meetingsIn) ? meetingsIn : [])
    .filter((m) => m && Object.values(m).some((v) => str(v)))
    .map((m, i) => {
      const date = str(m.date, 10), time = str(m.time, 5);
      if (!DATE_RE.test(date)) throw new Error(`meeting ${i + 1}: date "${date}" must be YYYY-MM-DD`);
      if (time && !TIME_RE.test(time)) throw new Error(`meeting ${i + 1}: time "${time}" must be HH:MM (24-hour)`);
      return { date, time, title: str(m.title), who: str(m.who), format: str(m.format, 80), length: str(m.length, 40) };
    })
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
    .map((m, i) => ({ ...m, title: m.title || `Meeting ${i + 1}` }));
  const deadlines = (Array.isArray(deadlinesIn) ? deadlinesIn : [])
    .filter((d) => d && [d.date, d.title].some((v) => str(v)))
    .map((d, i) => {
      const date = str(d.date, 10);
      if (!DATE_RE.test(date)) throw new Error(`deadline ${i + 1}: date "${date}" must be YYYY-MM-DD`);
      const kind = str(d.kind, 20).toLowerCase() || "other";
      return { date, title: str(d.title) || "Deadline", kind: DEADLINE_KINDS.includes(kind) ? kind : "other", done: d.done === true || d.done === "true" };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  return { meetings, deadlines };
}

const escHtml = (s = "") => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** "Acme Capital, LLC" -> "acme-capital-llc"; accents folded; max 41 chars. */
export function slugify(s) {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 41)
    .replace(/-+$/g, "");
}

const MODE_RULES = [
  ["interviewing", /\b(interview|hiring|hire|role|job|recruit|candidaci)/i],
  ["deal", /\b(deal|negotiat|acqui|invest(?!igat)|raise|raising|licen[cs]|term ?sheet|buy|merger)/i],
  ["audit", /\b(audit|diligence on|due diligence|verify|verif|review|check on)/i],
  ["pitch", /\b(pitch|sell|selling|sponsor|partner|proposal|win (the|their|a) (client|contract|account))/i],
];

/** Modes implied by the free-text goal, in the fixed order. Defaults to ["deal"]. */
export function inferModes(goal) {
  const g = String(goal || "");
  const hits = MODE_RULES.filter(([, re]) => re.test(g)).map(([m]) => m);
  return hits.length ? hits : ["deal"];
}

const ORG_RULES = [
  ["asset-owner", /\b(pension|endowment|sovereign|retirement (system|fund)|superannuation|insurance fund|family office)/i],
  ["private-equity", /\b(capital|equity|buyout|partners|ventures|growth fund|fund [ivx]+\b)/i],
  ["health-system", /\b(health|hospital|clinic|medical cent|healthcare)/i],
  ["energy", /\b(energy|power|solar|wind|oil|gas|utility|utilities|petroleum|renewable)/i],
  ["consultancy", /\b(consult|advisory|advisors)/i],
  ["government", /\b(ministry|department of|agency|city of|county|state of|government|municipal|authority)/i],
  ["startup", /\b(startup|start-up|seed|series [a-c]\b|pre-seed)/i],
  ["public-company", /\b(plc|nyse|nasdaq|listed|public company|ticker)/i],
];

/** Org type guessed from the company name and goal; "other" when nothing matches. */
export function inferOrgType(company, goal = "") {
  for (const [t, re] of ORG_RULES) if (re.test(String(company || ""))) return t;
  for (const [t, re] of ORG_RULES) if (re.test(String(goal || ""))) return t;
  return "other";
}

/** "Jane Doe, John Roe" or ["Jane Doe", "John Roe"] -> ["Jane Doe", "John Roe"] */
export function parsePeople(input) {
  const list = Array.isArray(input) ? input : [input];
  return list
    .flatMap((x) => String(x ?? "").split(/[,;\n]/))
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function fillString(s, vars, html) {
  return Object.keys(vars)
    .sort((a, b) => b.length - a.length)
    .reduce((acc, k) => acc.replaceAll(k, html ? escHtml(vars[k]) : vars[k]), s);
}
function fillDeep(v, vars) {
  if (typeof v === "string") return fillString(v, vars, false);
  if (Array.isArray(v)) return v.map((x) => fillDeep(x, vars));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillDeep(x, vars)]));
  return v;
}
const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));

/** Where the skeleton lives and which layout it uses. */
export function skeletonLayout(skeletonDir) {
  if (existsSync(join(skeletonDir, "core", "room.json"))) return "packs";
  if (existsSync(join(skeletonDir, "room.json"))) return "flat";
  return "none";
}

/** Modes and org types the skeleton actually has packs for (falls back to the fixed lists). */
export function availableOptions(skeletonDir) {
  const list = (d, fallback) => {
    const p = join(skeletonDir, d);
    if (!existsSync(p)) return fallback;
    const found = readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(p, e.name, "pack.json"))).map((e) => e.name);
    return found.length ? [...fallback.filter((x) => found.includes(x)), ...found.filter((x) => !fallback.includes(x))] : fallback;
  };
  return { modes: list("modes", MODES), orgTypes: list("orgtypes", ORG_TYPES), extras: list("extras", EXTRAS), layout: skeletonLayout(skeletonDir) };
}

/**
 * Compose a room in memory and write it to <roomsDir>/<slug>/.
 * opts: { company, domain, people[], goal, modes[], orgType, date, slug, tier, practice, now }
 * paths: { skeletonDir, roomsDir, configDir }
 */
export function composeRoom(opts, paths = {}) {
  const skeletonDir = paths.skeletonDir || join(REPO, "templates", "skeleton");
  const roomsDir = paths.roomsDir || join(REPO, "rooms");
  const configDir = paths.configDir || join(REPO, "config");
  const warnings = [];

  const company = String(opts.company || "").replace(/\s+/g, " ").trim();
  if (!company) throw new Error("company is required");
  const goal = String(opts.goal || "").trim();
  const domain = normDomain(opts.domain);
  if (opts.domain && !domain) warnings.push(`domain "${opts.domain}" does not look like a domain (acme.com); left out`);
  const slug = opts.slug ? String(opts.slug) : slugify(company);
  if (!SLUG_RE.test(slug)) throw new Error(`cannot make a room slug from "${company}"; pass --slug (lower-case letters, digits, dashes)`);
  const dir = join(roomsDir, slug);
  if (existsSync(dir)) {
    const e = new Error(`rooms/${slug} already exists; not overwriting`);
    e.code = "EEXIST";
    throw e;
  }

  const modesGiven = (opts.modes || []).map((m) => String(m).trim().toLowerCase()).filter(Boolean);
  const modes = [...new Set(modesGiven.length ? modesGiven : inferModes(goal))];
  for (const m of modes) if (!MODES.includes(m)) throw new Error(`unknown mode "${m}" (use ${MODES.join(", ")})`);
  const orgRaw = String(opts.orgType || "auto").trim().toLowerCase();
  const orgType = orgRaw === "auto" ? inferOrgType(company, goal) : orgRaw;
  if (!ORG_TYPES.includes(orgType)) throw new Error(`unknown org type "${orgType}" (use ${ORG_TYPES.join(", ")})`);
  const dateGiven = opts.date ? String(opts.date) : "";
  if (dateGiven && !DATE_RE.test(dateGiven)) throw new Error(`meeting date "${dateGiven}" must be YYYY-MM-DD`);
  const schedule = normaliseSchedule(opts.meetings, opts.deadlines);
  // The meeting date and the meetings list agree: a date with no matching meeting becomes meeting 1.
  if (dateGiven && !schedule.meetings.some((m) => m.date === dateGiven))
    schedule.meetings = normaliseSchedule([{ date: dateGiven, title: "Meeting 1" }, ...schedule.meetings]).meetings;
  const now = opts.now ? new Date(opts.now) : new Date();
  const today = now.toISOString().slice(0, 10);
  // The meeting date is the one given, else the next meeting from today, else the first listed.
  const meetingDate = dateGiven || (schedule.meetings.find((m) => m.date >= today) || schedule.meetings[0] || {}).date || "";
  // STANDARD.md: full, unless the meeting is under 48 hours away, then light.
  const soon = meetingDate && Date.parse(meetingDate + "T23:59:59Z") - now.getTime() < 48 * 3600 * 1000;
  const tier = opts.tier === "light" || opts.tier === "full" ? opts.tier : soon ? "light" : "full";

  // people, with unique slugs
  const names = parsePeople(opts.people || []);
  if (!names.length) warnings.push("no person given: per-person pages use a placeholder 'Lead contact'");
  const used = new Set();
  const people = (names.length ? names : ["Lead contact"]).map((name) => {
    let base = slugify(name) || "person", s = base, n = 2;
    while (used.has(s)) s = `${base}-${n++}`;
    used.add(s);
    return { name, title: "", slug: s };
  });

  const baseVars = {
    __SLUG__: slug,
    __TITLE__: company,
    __COMPANY__: company,
    __DATE__: today,
    __GOAL__: goal,
    __MEETING_DATE__: meetingDate || "to be set",
    __PERSON__: people.map((p) => p.name).join(", "),
    __PERSON_SLUG__: people[0].slug,
  };

  // 1. core
  const layout = skeletonLayout(skeletonDir);
  if (layout === "none") throw new Error(`no skeleton found in ${skeletonDir}`);
  let core, coreDirs;
  if (layout === "packs") {
    core = readJson(join(skeletonDir, "core", "room.json"));
    coreDirs = [join(skeletonDir, "core", "pages"), join(skeletonDir, "core", "person")];
  } else {
    core = readJson(join(skeletonDir, "room.json"));
    coreDirs = [join(skeletonDir, "pages")];
    // the flat skeleton has one "persona" page; repeat it per person
    for (const s of core.sections || [])
      for (const p of s.pages || [])
        if (p.id === "persona") Object.assign(p, { id: "persona-__PERSON_SLUG__", title: "Persona: __PERSON__", _file: "persona" });
    for (const h of core.heroes || []) if (h.page === "persona") Object.assign(h, { page: "persona-__PERSON_SLUG__", title: "Persona: __PERSON__" });
  }
  const sections = clone(core.sections || []);
  for (const s of sections) for (const p of s.pages || []) p._dirs = coreDirs;

  // 2. packs: modes in order, then the org type, inserted right after the core
  //    section "ask" (at the end if there is none). Same section id = pages merged in.
  // The practice pack (answer bank, practice bank, push-back gym, mock transcripts) is opt-in.
  const extras = opts.practice === true || opts.practice === "true" ? ["practice"] : [];
  const packs = layout === "packs" ? [...modes.map((m) => ["modes", m]), ["orgtypes", orgType], ...extras.map((x) => ["extras", x])] : [];
  if (layout === "flat") warnings.push("skeleton has no core/modes/orgtypes yet: used the flat skeleton only");
  const added = [];
  for (const [kind, name] of packs) {
    const pdir = join(skeletonDir, kind, name);
    if (!existsSync(join(pdir, "pack.json"))) {
      warnings.push(`no pack at templates/skeleton/${kind}/${name}/pack.json; skipped`);
      continue;
    }
    const pack = readJson(join(pdir, "pack.json"));
    // Mode packs sit under the role group, org-type packs under the company group.
    const packGroup = kind === "orgtypes" ? "company" : "role";
    for (const ps0 of pack.sections || []) {
      const ps = { ...ps0, group: ps0.group || packGroup };
      const pages = (ps.pages || []).map((p) => ({ ...p, _dirs: [join(pdir, "pages"), ...coreDirs] }));
      const existing = sections.find((s) => s.id === ps.id) || added.find((s) => s.id === ps.id);
      if (existing) {
        existing.pages = [...(existing.pages || []), ...pages];
        if (ps.brief && !existing.brief) existing.brief = ps.brief;
        if (ps.note && !existing.note) existing.note = ps.note;
      } else added.push({ ...clone({ ...ps, pages: [] }), pages });
    }
  }
  const askAt = sections.findIndex((s) => s.id === "ask");
  sections.splice(askAt < 0 ? sections.length : askAt + 1, 0, ...added);

  // 3. per-person repetition. A section with "perPerson": true is repeated whole,
  //    once per person (id "<section>-<person slug>", title the person's name).
  //    Elsewhere, a page whose id holds __PERSON_SLUG__ is repeated in place.
  const personVars = (p) => ({ ...baseVars, __PERSON__: p.name, __PERSON_SLUG__: p.slug });
  const expanded = sections.flatMap((s) =>
    s.perPerson
      ? people.map((p) => ({ ...s, id: `${s.id}-${p.slug}`, title: p.name, _vars: personVars(p) }))
      : [s],
  );
  const seen = new Set();
  const plan = []; // { id, source:{file,kind}|null, vars }
  for (const s of expanded) {
    const out = [];
    for (const page of s.pages || []) {
      const perPerson = !s._vars && page.id.includes("__PERSON_SLUG__");
      for (const vars of s._vars ? [s._vars] : perPerson ? people.map(personVars) : [baseVars]) {
        const { _dirs, _file, ...meta } = page;
        const filled = fillDeep(meta, vars);
        if (seen.has(filled.id)) {
          warnings.push(`page "${filled.id}" appears twice; kept the first`);
          continue;
        }
        seen.add(filled.id);
        out.push(filled);
        plan.push({ id: filled.id, title: filled.title, source: findSource(page.id, _file, _dirs), vars });
      }
    }
    s.pages = out;
  }
  const finalSections = expanded
    .map(({ _vars, perPerson, ...s }) => ({ ...fillDeep(s, _vars || baseVars), ...(perPerson ? { person: _vars.__PERSON_SLUG__ } : {}) }))
    .filter((s) => s.pages.length);

  const heroes = (core.heroes || []).flatMap((h) =>
    String(h.page || "").includes("__PERSON_SLUG__") ? people.map((p) => fillDeep(h, personVars(p))) : [fillDeep(h, baseVars)],
  ).filter((h) => seen.has(h.page));

  // 4. room.json
  const { sections: _s, heroes: _h, ...rest } = core;
  const room = fillDeep(rest, baseVars);
  room.slug = slug;
  room.title = room.title && !String(core.title || "").includes("__") ? room.title : company;
  if (!core.subtitle || !String(core.subtitle).includes("__")) room.subtitle = goal || room.subtitle || "";
  room.asOf = today;
  room.counterparty = company;
  room.people = people;
  room.modes = modes;
  room.orgType = orgType;
  room.tier = tier;
  if (domain) room.domain = domain;
  const ourSideFile = join(configDir, "our-side.json");
  if (existsSync(ourSideFile)) {
    try {
      const ours = readJson(ourSideFile);
      room.ourSide = ours.name || ours.ourSide || room.ourSide || "";
    } catch {
      warnings.push("config/our-side.json is not valid JSON; ourSide left as in the skeleton");
    }
  }
  if (meetingDate) room.meetingDate = meetingDate;
  room.summary = room.summary || "";
  room.meetings = schedule.meetings;
  room.deadlines = schedule.deadlines;
  room.heroes = heroes;
  room.sections = finalSections;

  const intake = {
    people: people.map(({ name, slug: s }) => ({ name, slug: s })),
    person: people[0].name,
    company,
    domain: domain || null,
    goal,
    modes,
    practice: extras.includes("practice"),
    modesInferred: !modesGiven.length,
    orgType,
    orgTypeInferred: orgRaw === "auto",
    tier: room.tier,
    meetingDate: meetingDate || null,
    meetings: schedule.meetings,
    deadlines: schedule.deadlines,
    createdAt: now.toISOString(),
    // the same, under the names pipeline/PROMPTS.md uses
    counterparty: company,
    the_ask: goal,
    mode: modes,
    org_type: orgType,
    meeting_date: meetingDate || null,
    raw_line: [people.map((p) => p.name).join(", "), company, goal].filter(Boolean).join(" | "),
  };

  // 5. write
  mkdirSync(join(dir, "pages"), { recursive: true });
  const manifest = {};
  try {
    for (const p of plan) {
      let content, ext;
      if (p.source) {
        content = fillString(readFileSync(p.source.file, "utf8"), p.vars, true);
        ext = p.source.kind;
      } else {
        warnings.push(`no skeleton page for "${p.id}"; wrote a stub`);
        content = `<!-- No skeleton page for this id yet. -->\n<h2>${escHtml(p.title || p.id)}</h2>\n<p></p>\n`;
        ext = "html";
      }
      writeFileSync(join(dir, "pages", `${p.id}.${ext}`), content);
      manifest[p.id] = sha256(content);
    }
    writeFileSync(join(dir, "room.json"), JSON.stringify(room, null, 2) + "\n");
    writeFileSync(join(dir, "intake.json"), JSON.stringify(intake, null, 2) + "\n");
    writeFileSync(join(dir, ".skeleton.json"), JSON.stringify({ note: "sha256 of each page as composed; lint compares against it", pages: manifest }, null, 2) + "\n");
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return { slug, dir, room, intake, pageCount: plan.length, warnings };
}

/** "https://www.Acme.com/about" -> "acme.com"; "" when it does not look like a domain. */
export function normDomain(x) {
  const d = String(x || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[\/?#].*$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : "";
}

function findSource(rawId, fileHint, dirs) {
  const base = rawId.replace(/-?__PERSON_SLUG__-?/g, "");
  const names = [...new Set([fileHint, rawId, base, RENAMED_PAGES[base], rawId.replace(/__PERSON_SLUG__/g, "person")].filter(Boolean))];
  for (const d of dirs)
    for (const n of names)
      for (const kind of ["html", "md"]) {
        const f = join(d, `${n}.${kind}`);
        if (existsSync(f)) return { file: f, kind };
      }
  return null;
}

// ---------------------------------------------------------------- pipeline run

const FALLBACK_P0 = `You are the orchestrator for a diligence room build.

Read README.md and the room folder named below. Build the room for the intake below: research the organisation and every person across the table from public sources only, fill every page in rooms/{{slug}}/pages/, grade every fact (verified, partly verified, weak, inference, none found, not public, unknown) with a source link, keep every checklist row (found, weak, or None found with what was searched) and log every check, found or not, in the OSINT log; the personal life page shows findings only, and nothing about the people is ever matched to our side; write the persona verdict (Proven / Mixed / Unproven, claims against the record) and what drives each person and the company (financial, social, commercial, technical) with evidence; ask for the meeting date and deadlines if room.json has none ({{meetings}}; {{deadlines}}), write room.json summary last with the one card, and leave [FILL: ...] markers for anything only Anthony can answer. Do not read our side's file while writing the people pages. Run npm run lint {{slug}} and npm run build {{slug}} before you stop. Do not deploy, commit or push.`;

/** The P0 section of pipeline/PROMPTS.md (heading containing "P0"), or null. */
export function extractSection(md, id = "P0") {
  const lines = String(md).split("\n");
  const re = new RegExp(`^(#{1,6})\\s*[\`*_]*${id}\\b`);
  const start = lines.findIndex((l) => re.test(l));
  if (start < 0) return null;
  const level = lines[start].match(/^#+/)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s/);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  let body = lines.slice(start + 1, end).join("\n").replace(/\n-{3,}\s*$/, "").trim();
  // a prompt kept in one fenced block: use what is inside the fence
  const fenced = body.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
  if (fenced) body = fenced[1];
  return body.trim();
}

/** Meetings or deadlines as one readable line each, for prompts. */
export function scheduleText(list, kind = "meetings") {
  if (!Array.isArray(list) || !list.length) return `none given (ask for the ${kind})`;
  return list
    .map((x) => (kind === "meetings" ? [x.date + (x.time ? " " + x.time : ""), x.title, x.who, x.format, x.length] : [x.date, x.title, x.kind, x.done ? "done" : ""]).filter(Boolean).join(" · "))
    .join("; ");
}

/** Fill a prompt with the intake: {{key}}, {key} and __KEY__ forms. */
export function fillPrompt(text, intake, slug, ours = {}) {
  const vals = {
    rawline: intake.raw_line || [intake.people.map((p) => p.name).join(", "), intake.company, intake.goal].filter(Boolean).join(" | "),
    counterparty: intake.company,
    domain: intake.domain || "not given",
    theask: intake.goal,
    today: (intake.createdAt || new Date().toISOString()).slice(0, 10),
    ourname: ours.name || "(config/our-side.json: name)",
    ourorganisation: ours.organisation || "(config/our-side.json: organisation)",
    factsfile: ours.factsFile || "(config/our-side.json: factsFile)",
    slug,
    company: intake.company,
    person: intake.people.map((p) => p.name).join(", "),
    people: intake.people.map((p) => p.name).join(", "),
    goal: intake.goal,
    modes: intake.modes.join(", "),
    mode: intake.modes.join(", "),
    orgtype: intake.orgType,
    org: intake.orgType,
    meetingdate: intake.meetingDate || "not set",
    date: intake.meetingDate || "not set",
    tier: intake.tier,
    meetings: scheduleText(intake.meetings, "meetings"),
    deadlines: scheduleText(intake.deadlines, "deadlines"),
    roomdir: `rooms/${slug}`,
    intake: JSON.stringify(intake, null, 2),
  };
  const get = (k) => {
    const key = k.toLowerCase().replace(/[_\s-]/g, "");
    return key in vals ? vals[key] : null;
  };
  return text
    .replace(/\{\{\s*([\w-]+)\s*\}\}/g, (m, k) => get(k) ?? m)
    .replace(/__([A-Z][A-Z_]*?)__/g, (m, k) => get(k) ?? m);
}

/** Rules for a run nobody is watching: no questions, no credit spend, no deploy. */
export function unattendedBlock(slug) {
  return `

## This run is unattended

Nobody is watching this run, so nobody can answer. These rules override steps 3 and 5 of the
orchestrator above:
- Never ask a question or wait for an answer. Use the intake below; where something is missing,
  append the question to rooms/${slug}/work/questions.md (one line each: stage, question), mark it
  [FILL: question] on the page, and carry on.
- Do not run npm run enrich and do not spend licensed-data credits. The studio fetches licensed
  data with the user's yes before the run; if rooms/${slug}/work/connectors/merged.json exists,
  use it as leads.
- Never deploy, commit or push. Never delete files (deleting is blocked): overwrite them instead.
`;
}

/**
 * Write rooms/<slug>/work/P0.md and rooms/<slug>/RUN.sh. Returns the command.
 */
export function writeRunScript(slug, intake, paths = {}) {
  const repo = paths.repo || REPO;
  const roomDir = join(paths.roomsDir || join(repo, "rooms"), slug);
  const promptsFile = paths.promptsFile || join(repo, "pipeline", "PROMPTS.md");
  const p0 = existsSync(promptsFile) ? extractSection(readFileSync(promptsFile, "utf8"), "P0") : null;
  const source = p0 ? "pipeline/PROMPTS.md#P0" : "built-in fallback (pipeline/PROMPTS.md has no P0 yet)";
  let ours = {};
  const oursFile = join(paths.configDir || join(repo, "config"), "our-side.json");
  if (existsSync(oursFile)) try { ours = JSON.parse(readFileSync(oursFile, "utf8")); } catch {}
  const prompt =
    fillPrompt(p0 || FALLBACK_P0, intake, slug, ours) +
    `\n\n## Intake (from the studio)\n\nThe room is already composed from the skeleton (core + ${intake.modes.join(" + ")} + ${intake.orgType}, person pages per person): rooms/${slug}/room.json, rooms/${slug}/pages/, rooms/${slug}/intake.json. Do not compose it again; parse nothing from the line that the intake below already gives, create the workspace, and continue with the stages.\n\n\`\`\`json\n${JSON.stringify(intake, null, 2)}\n\`\`\`\n`;
  mkdirSync(join(roomDir, "work"), { recursive: true });
  writeFileSync(join(roomDir, "work", "P0.md"), prompt + unattendedBlock(slug));
  // The engine (Claude Code or Codex), account and usage limit come from config/engine.json,
  // set in the studio's Connect AI panel, so this script never needs rewriting when they change.
  const command = `node --env-file-if-exists=.env scripts/run-room.mjs ${slug}`;
  const script = `#!/usr/bin/env bash
# Pipeline run for rooms/${slug}. Written by the studio / new-room; gitignored.
# Prompt: rooms/${slug}/work/P0.md (from ${source}, filled with intake.json)
# Engine: config/engine.json (studio > Connect AI). Stops itself above the plan usage limit.
set -euo pipefail
cd "$(dirname "$0")/../.."
exec ${command} "$@"
`;
  const runFile = join(roomDir, "RUN.sh");
  writeFileSync(runFile, script);
  chmodSync(runFile, 0o755);
  return { command, runFile, promptFile: join(roomDir, "work", "P0.md"), source };
}
