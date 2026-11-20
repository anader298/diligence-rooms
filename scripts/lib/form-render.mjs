// The form rendered into a room by code: on each page, a block with that page's buckets and
// their states; and one "The form" page with every bucket, Other findings and the form check.
// The AI never edits these rows. Uses the room's existing classes (grade spans, a.src, .tw).
import { esc } from "./render.mjs";
import { STATE_LABEL, GRADE_CLASS, GRADE_LABEL } from "./form.mjs";

const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};
const valueText = (v) => (typeof v === "string" ? v : JSON.stringify(v ?? "")).replace(/\s+/g, " ").trim();
const clip = (s, n = 280) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function gradeSpan(g) {
  if (g === "intake") return `<span class="fstate intake">${GRADE_LABEL.intake}</span>`;
  return `<span class="grade ${GRADE_CLASS[g]}">${GRADE_LABEL[g]}</span>`;
}
function srcLink(r) {
  if (!r.url) return "";
  return `<a class="src" href="${esc(r.url)}">${esc(hostOf(r.url) || "source")}</a>`;
}
const refTag = (r) => `<small class="lref">${esc(r.ref)}</small>`;

/** One bucket as table rows: filled rows (up to `max`), or its state and why. */
export function bucketRows(b, { max = 5, withPage = false } = {}) {
  const head = `<td>${esc(b.label)}${b.kind === "ai" ? ' <span class="ai-tag">AI judgement</span>' : ""}${withPage ? `<br><small>${esc(b.pageId)}</small>` : ""}</td>`;
  const attrs = `class="fb ${b.state}" data-bucket="${esc(b.key)}"`;
  if (b.state === "filled" && b.grade === "intake") return `<tr ${attrs}>${head}<td>${esc(clip(b.value || ""))}</td><td>${gradeSpan("intake")}</td><td></td></tr>`;
  if (b.state === "filled") {
    const rows = b.rows.slice(0, max);
    const more = b.rows.length - rows.length;
    return rows
      .map((r, i) => {
        const cites = r.cites?.length ? `<br><small class="cites">Rests on ${r.cites.map(esc).join(", ")}</small>` : "";
        const finding = `${esc(clip(valueText(r.value)))}${r.note && r.entry ? `<br><small>${esc(clip(r.note, 160))}</small>` : ""}${cites}${i === rows.length - 1 && more > 0 ? `<br><small>+${more} more on the form page</small>` : ""}`;
        return `<tr ${attrs}>${i === 0 ? head : "<td></td>"}<td>${finding}</td><td>${gradeSpan(r.grade)}</td><td>${srcLink(r)} ${refTag(r)}</td></tr>`;
      })
      .join("");
  }
  return `<tr ${attrs}>${head}<td><small>${esc(clip(b.why || "", 220))}</small></td><td><span class="fstate ${b.state}">${STATE_LABEL[b.state]}</span></td><td></td></tr>`;
}

const tableOf = (rows) => `<div class="tw"><table class="form"><tr><th>Bucket</th><th>Finding</th><th>State</th><th>Source</th></tr>${rows}</table></div>`;

/** The block put on a page: its buckets by group. Empty string when the page has none. */
export function formBlock(buckets) {
  if (!buckets.length) return "";
  const groups = [...new Set(buckets.map((b) => b.group))];
  const rows = groups.map((g) => `<tr class="fg"><th colspan="4">${esc(g)}</th></tr>` + buckets.filter((b) => b.group === g).map((b) => bucketRows(b)).join("")).join("");
  const n = (s) => buckets.filter((b) => b.state === s).length;
  return `<section class="form-block"><h2>On the form</h2><p class="form-note">Filled by code from the research ledger: ${n("filled")} filled, ${n("empty")} searched with nothing found, ${n("blocked")} could not be checked, ${n("no-tool")} with no tool yet. <a href="form.html">The whole form</a></p>${tableOf(rows)}</section>\n`;
}

/** The body of the "The form" page: counts, the check, every bucket, and Other findings. */
export function formPage(form, gate) {
  const c = form.counts;
  const head = `<p>Every bucket this room fills, from the packs the intake chose (${form.packs.map((p) => esc(p.id)).join(", ")}). Each one is in exactly one state, computed from the research ledger: nothing on this page is written by an AI. AI judgement is labelled and lists the ledger rows it rests on.</p>`;
  const counts = `<h2>States</h2><div class="tw"><table><tr><th>State</th><th>Buckets</th><th>What it means</th></tr>` +
    `<tr><td>${STATE_LABEL.filled}</td><td>${c.filled}</td><td>A ledger row or the intake fills it, with its grade and source</td></tr>` +
    `<tr><td>${STATE_LABEL.empty}</td><td>${c.empty}</td><td>A tool or an agent searched and found nothing (what was searched is shown)</td></tr>` +
    `<tr><td>${STATE_LABEL.blocked}</td><td>${c.blocked}</td><td>The tools that feed it were blocked, need a key or a domain, or did not run</td></tr>` +
    `<tr><td>${STATE_LABEL["no-tool"]}</td><td>${c["no-tool"]}</td><td>No module feeds it yet and nobody handed in an entry</td></tr></table></div>`;
  const check = `<h2>Form check</h2>${gate.ok ? "<p>Passed: every required bucket has a state, every AI entry cites real ledger rows, and Start here is filled.</p>" : `<p>Failed (${gate.errors.length}). The build was allowed as a draft.</p><ul>${gate.errors.slice(0, 60).map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`}${gate.warnings.length ? `<p><small>${gate.warnings.slice(0, 20).map(esc).join("<br>")}</small></p>` : ""}`;
  const sections = [];
  const keyOf = (b) => `${b.pack}|${b.person || ""}`;
  for (const k of [...new Set(form.buckets.map(keyOf))]) {
    const bs = form.buckets.filter((b) => keyOf(b) === k);
    const title = `${bs[0].pack}${bs[0].personName ? `: ${bs[0].personName}` : ""}`;
    const groups = [...new Set(bs.map((b) => b.group))];
    sections.push(`<h2>${esc(clip(title, 39))}</h2>` + tableOf(groups.map((g) => `<tr class="fg"><th colspan="4">${esc(g)}</th></tr>` + bs.filter((b) => b.group === g).map((b) => bucketRows(b, { max: 3, withPage: true })).join("")).join("")));
  }
  const other = form.other.length
    ? `<h2>Other findings</h2><p>Ledger rows that fit no bucket on this form (a new tool, or a variable no pack lists yet). Add a bucket to show them in place.</p><div class="tw"><table><tr><th>Variable</th><th>Finding</th><th>Grade</th><th>Source</th></tr>${form.other
        .slice(0, 200)
        .map((r) => `<tr><td>${esc(r.bucket || r.var)}</td><td>${esc(clip(valueText(r.value)))}</td><td>${GRADE_CLASS[r.grade] ? gradeSpan(r.grade) : esc(r.grade || "")}</td><td>${srcLink(r)} ${refTag(r)}</td></tr>`)
        .join("")}</table></div>`
    : "";
  return `${head}\n${counts}\n${check}\n${sections.join("\n")}\n${other}\n`;
}

/** Insert a block before the page's "Open questions" or "Sources" heading, else at the end. */
export function insertBeforeTail(body, block) {
  const m = body.search(/<h2>\s*(Open questions|Sources|What I could not find)\s*<\/h2>/i);
  return m > -1 ? body.slice(0, m) + block + body.slice(m) : body + "\n" + block;
}

/** Insert a block after the page's opening paragraph (before the first h2), else at the top. */
export function insertAfterLead(body, block) {
  const at = body.search(/<\/p>/i);
  const firstH2 = body.search(/<h2[\s>]/i);
  return at > -1 && (firstH2 < 0 || at < firstH2) ? body.slice(0, at + 4) + "\n" + block + body.slice(at + 4) : block + body;
}
