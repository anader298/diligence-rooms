// Meetings, deadlines and the summary on the room index and the process page.
//
//   room.json "summary":   one paragraph (who, what we want, the three things that matter, the main risk)
//   room.json "meetings":  [{ date, time, title, who, format, length }]
//   room.json "deadlines": [{ date, title, kind, done }]
//
// The build renders these at build time; templates/room.js keeps the countdown live
// in the browser (each countdown carries data-at, a local date and time).
// No dependencies.

const esc = (s = "") => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const DAY = 86400000;

/** "2026-12-01" + "09:30" -> local Date; no time means the start of that day. */
export function meetingTime(m) {
  const [y, mo, d] = String(m.date || "").split("-").map(Number);
  if (!y || !mo || !d) return null;
  const [h, mi] = String(m.time || "").split(":").map(Number);
  return new Date(y, mo - 1, d, Number.isFinite(h) ? h : 0, Number.isFinite(mi) ? mi : 0);
}

/** The next meeting that has not started yet (a meeting with no time counts until the end of its day). */
export function nextMeeting(meetings = [], now = new Date()) {
  return (meetings || [])
    .map((m) => ({ m, at: meetingTime(m) }))
    .filter(({ m, at }) => at && (m.time ? at.getTime() : at.getTime() + DAY) > now.getTime())
    .sort((a, b) => a.at - b.at)[0]?.m || null;
}

/** Deadlines not yet done, from today on, soonest first; overdue ones (not done) first of all. */
export function upcomingDeadlines(deadlines = [], now = new Date(), limit = 6) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return (deadlines || [])
    .filter((d) => d && !d.done && meetingTime(d))
    .map((d) => ({ ...d, days: Math.round((meetingTime(d).getTime() - today) / DAY) }))
    .sort((a, b) => a.days - b.days)
    .slice(0, limit);
}

/** "in 3 days", "today", "2 days late". */
export function dayWords(days) {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "1 day late";
  return days > 0 ? `in ${days} days` : `${-days} days late`;
}

/** "3 d 4 h", "4 h 12 min", "12 min", "now". */
export function countdownWords(ms) {
  if (ms <= 0) return "now";
  const d = Math.floor(ms / DAY), h = Math.floor((ms % DAY) / 3600000), m = Math.floor((ms % 3600000) / 60000);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
}

const localIso = (at) => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}T${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
const meetingLine = (m) => [m.who, m.format, m.length].filter(Boolean).map(esc).join(" · ");

/** The summary paragraph for the top of the room index (inside the room head). */
export function summaryHtml(room) {
  const s = String(room.summary || "").trim();
  return s ? `<div class="summary"><p class="lbl">In one paragraph</p><p>${esc(s)}</p></div>` : "";
}

const WEEKDAYS = "Sunday Monday Tuesday Wednesday Thursday Friday Saturday".split(" ");
const MONTHS = "January February March April May June July August September October November December".split(" ");
const hhmm = (at) => `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
const initials = (n) => { const w = String(n).trim().split(/\s+/); return ((w[0]?.[0] || "") + (w.length > 1 ? w[w.length - 1][0] : "")).toUpperCase(); };

/**
 * The index aside: the next-meeting card (countdown filled at build time, kept live by room.js),
 * a strip of every meeting, the open deadlines, and the Companion and Feed it launchers.
 * `pages` is the set of page ids in the room (the one card and practice buttons need their page).
 */
export function asideHtml(room, now = new Date(), pages = new Set()) {
  const meetings = room.meetings || [];
  const deadlines = room.deadlines || [];
  const next = nextMeeting(meetings, now);
  let card;
  if (next) {
    const at = meetingTime(next);
    if (!next.time) at.setHours(9, 0);
    const ms = Math.max(0, at.getTime() - now.getTime());
    const d = Math.floor(ms / DAY), h = Math.floor((ms % DAY) / 3600000), mi = Math.floor((ms % 3600000) / 60000);
    const when = `${WEEKDAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]}, ${next.time ? hhmm(at) + (next.tz ? "&nbsp;" + esc(next.tz) : "") : "time to be confirmed"}` +
      [next.format, next.length].filter(Boolean).map((x) => " · " + esc(x)).join("");
    const people = (room.people || []).filter((p) => next.who && new RegExp(`\\b(${esc(p.name.split(" ")[0])}|${esc(p.slug || "-")})\\b`, "i").test(next.who));
    const withs = next.who ? `<p class="withs">${people.map((p) => `<span class="mono" aria-hidden="true">${initials(p.name)}</span>`).join("")}<span class="names">${esc(next.who)}</span></p>` : "";
    const acts = [pages.has("one-card") ? `<a class="btn solid" href="one-card.html">Read the one card</a>` : "", pages.has("practice") ? `<a class="btn" href="practice.html">Practise</a>` : pages.has("practice-bank") ? `<a class="btn" href="practice-bank.html">Practise</a>` : ""].join("");
    const strip = meetings.length > 1
      ? `<ol class="mtgs">${[...meetings].sort((a, b) => (meetingTime(a) || 0) - (meetingTime(b) || 0)).map((m) => { const t = meetingTime(m); const st = m === next ? "next" : t && t < now ? "done" : "todo"; return `<li class="is-${st}"><b>${esc(m.title)}</b><span>${t ? `${t.getDate()} ${MONTHS[t.getMonth()].slice(0, 3)}` : ""}${m.who ? `, ${esc(m.who)}` : ""}</span></li>`; }).join("")}</ol>`
      : "";
    card = `<section class="next" data-meeting="${localIso(at)}" aria-labelledby="nx"><p class="lbl">Next meeting</p><h2 id="nx">${esc(next.title)}</h2><p class="when">${when}</p>` +
      `<div class="count" role="timer" aria-live="off"><span><b class="cd">${d}</b><small>days</small></span><span><b class="ch">${h}</b><small>hours</small></span><span><b class="cm">${mi}</b><small>min</small></span></div>` +
      `${withs}${acts ? `<div class="acts">${acts}</div>` : ""}${strip}</section>`;
  } else {
    card = `<section class="next" aria-labelledby="nx"><p class="lbl">Next meeting</p><h2 id="nx">${meetings.length ? "None scheduled" : "Not set"}</h2><p class="when">${meetings.length ? "Add the next one to room.json." : "[FILL: meeting date]"}</p></section>`;
  }
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dl = (deadlines || [])
    .filter((x) => x && !x.done && meetingTime(x))
    .map((x) => ({ ...x, days: Math.round((meetingTime(x).getTime() - today) / DAY) }))
    .filter((x) => x.days >= -3)
    .sort((a, b) => a.days - b.days)
    .slice(0, 6);
  const dlHtml = `<section class="dl" aria-labelledby="dlh"><h2 id="dlh">Deadlines</h2>${
    dl.length
      ? `<ol>${dl.map((x) => { const t = meetingTime(x); return `<li data-due="${esc(x.date)}T${esc(x.time || "23:59")}"><span class="d">${MONTHS[t.getMonth()].slice(0, 3)}<b>${t.getDate()}</b></span><span><span class="t">${esc(x.title)}</span><span class="rel">${dayWords(x.days)}</span></span></li>`; }).join("")}</ol>`
      : `<p>None open.</p>`
  }</section>`;
  const launch = `<section class="launch" aria-label="Live tools"><a class="lt comp" href="assist.html"><span class="dot" aria-hidden="true"></span><b>Companion</b><span>Answers from this room on your phone, during the meeting.</span></a><button class="lt feedlt" type="button" data-open-feed><b>Feed it</b><span>Add a debrief, a new fact or a correction. <em class="fb-count"></em></span></button></section>`;
  return `<aside class="aside" aria-label="Next meeting, deadlines and launch" data-hide-on-search>\n${card}\n${dlHtml}\n${launch}\n</aside>`;
}

/** For the one card: "Starts in ..." with data-until, from the next meeting. */
export function oneCardWhen(room, now = new Date()) {
  const next = nextMeeting(room.meetings || [], now);
  if (!next) return { heading: "", when: "" };
  const at = meetingTime(next);
  if (!next.time) at.setHours(9, 0);
  const heading = `${next.title}, ${WEEKDAYS[at.getDay()]}${next.time ? " " + hhmm(at) : ""}`;
  const where = [next.where, next.length, next.format].filter(Boolean).map(esc).join(" · ");
  return { heading, when: `<p class="when" data-until="${localIso(at)}">Starts in ${countdownWords(at.getTime() - now.getTime())}</p>${where ? `<p class="where">${where}</p>` : ""}` };
}

/** Countdown to the next meeting and the upcoming deadlines, for the top of the room index. */
export function scheduleHtml(room, now = new Date()) {
  const meetings = room.meetings || [];
  const deadlines = room.deadlines || [];
  if (!meetings.length && !deadlines.length) return "";
  const next = nextMeeting(meetings, now);
  let left = "";
  if (next) {
    const at = meetingTime(next);
    const ms = at.getTime() - now.getTime();
    left = `<div class="next"><span class="lbl">Next meeting</span><b>${esc(next.title)}</b><span class="when">${esc(next.date)}${next.time ? " " + esc(next.time) : ""}</span>${
      meetingLine(next) ? `<span class="who">${meetingLine(next)}</span>` : ""
    }<span class="cd" data-at="${localIso(at)}"${next.time ? "" : ' data-allday="1"'}>${next.time ? countdownWords(ms) : dayWords(Math.round((at.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / DAY))}</span></div>`;
  } else if (meetings.length) {
    left = `<div class="next"><span class="lbl">Next meeting</span><b>None scheduled</b><span class="who">The last one was ${esc(meetings[meetings.length - 1].date)}. Add the next to room.json.</span></div>`;
  } else {
    left = `<div class="next"><span class="lbl">Next meeting</span><b>Not set</b><span class="who">[FILL: meeting date]</span></div>`;
  }
  const up = upcomingDeadlines(deadlines, now);
  const right = `<div class="dl"><span class="lbl">Deadlines</span>${
    up.length
      ? `<ul>${up.map((d) => `<li class="${d.days < 0 ? "late" : d.days <= 2 ? "soon" : ""}"><b>${esc(d.title)}</b><span>${esc(d.date)} · ${esc(d.kind)} · <em data-due="${esc(d.date)}">${dayWords(d.days)}</em></span></li>`).join("")}</ul>`
      : `<p>None open.</p>`
  }</div>`;
  return `<section class="schedule" aria-label="Next meeting and deadlines">${left}${right}</section>`;
}

/** Meetings and deadlines as tables, put at the top of the process page. */
export function processBlock(room) {
  const meetings = room.meetings || [];
  const deadlines = room.deadlines || [];
  const m = meetings.length
    ? `<div class="tw"><table><tr><th>Date</th><th>Time</th><th>Meeting</th><th>Who</th><th>Format</th><th>Length</th></tr>${meetings
        .map((x) => `<tr><td>${esc(x.date)}</td><td>${esc(x.time || "")}</td><td>${esc(x.title)}</td><td>${esc(x.who || "")}</td><td>${esc(x.format || "")}</td><td>${esc(x.length || "")}</td></tr>`)
        .join("")}</table></div>`
    : `<p>No meetings set yet. [FILL: meeting date, time, who, format, length]</p>`;
  const d = deadlines.length
    ? `<div class="tw"><table><tr><th>Date</th><th>Deadline</th><th>Kind</th><th>Status</th></tr>${deadlines
        .map((x) => `<tr><td>${esc(x.date)}</td><td>${esc(x.title)}</td><td>${esc(x.kind || "other")}</td><td>${x.done ? "done" : "open"}</td></tr>`)
        .join("")}</table></div>`
    : `<p>No deadlines set.</p>`;
  return `<h2>Meetings</h2>\n${m}\n<h2>Deadlines</h2>\n${d}\n`;
}
