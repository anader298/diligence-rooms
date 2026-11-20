// The stage plan, for both engines (Claude Code and Codex): each stage of pipeline/PROMPTS.md
// becomes its own engine call with a fresh context, so the cold stages (P4a, P4b, P5e, the
// person AI slots) really never see our side, verification (P7) is done by calls that did not
// write the pages, and the order is fixed by code, not left to a model. run-room.mjs runs the
// scripted OSINT pass before the first wave and the form check and build after the last.

import { extractSection, fillPrompt } from "./compose.mjs";

/** A bold-labelled fenced block, e.g. **Cold add-on** (…):\n```\n…\n``` */
function addOn(md, label) {
  const m = String(md).match(new RegExp(`\\*\\*${label}\\*\\*[^\\n]*\\n\`\`\`[\\w-]*\\n([\\s\\S]*?)\\n\`\`\``));
  return m ? m[1].trim() : "";
}

/** Split a block like "P5a TRANSLATION: …\nP5b MODE PACK: …" into { P5a: "...", P5b: "..." } plus a tail. */
function splitSub(body, prefix) {
  const out = {};
  let tail = "";
  let cur = null;
  for (const line of String(body).split("\n")) {
    const m = line.match(new RegExp(`^(${prefix}[a-z])\\b`));
    if (m) {
      cur = m[1];
      out[cur] = line;
    } else if (cur && /^\s/.test(line)) out[cur] += "\n" + line;
    else {
      cur = null;
      tail += line + "\n";
    }
  }
  return { parts: out, tail: tail.trim() };
}

const header = (slug, id, label) => `You are one stage of an unattended diligence-room build, running in this repository.
Room folder: rooms/${slug}. Stage: ${id} (${label}). Read pipeline/STANDARD.md for the method.
Nobody is watching this run: never ask a question or wait for an answer. Append anything only the
user can answer to rooms/${slug}/work/questions.md (one line each: stage, question) and carry on.
Do not run npm run enrich (licensed data is fetched from the studio, with the user's yes; if
rooms/${slug}/work/connectors/merged.json exists, use it as leads). Do not deploy, commit or push.
Never delete files (deleting is blocked): overwrite them instead.`;

/**
 * The stages as waves: every stage in a wave may run at once; waves run in order.
 * Returns [{ wave, stages: [{ id, label, online, cold, prompt }] }].
 */
export function stagePlan(md, intake, slug, ours = {}) {
  const preamble = extractSection(md, "Common preamble") || "";
  const cold = addOn(md, "Cold add-on");
  const offline = addOn(md, "Offline add-on");
  const people = intake.people || [];

  const make = (id, label, body, { online = true, isCold = false, isOffline = false, person = null } = {}) => {
    let text = [header(slug, id, label), preamble, isCold ? cold : "", isOffline ? offline : "", body].filter(Boolean).join("\n\n");
    if (person) {
      text = text
        .replace(/\{\{\s*person\s*\}\}/gi, person.name)
        .replace(/\{\{\s*title\s*\}\}/gi, person.title || "title to confirm")
        .replace(/\{\{\s*person[_-]?slug\s*\}\}/gi, person.slug)
        .replace(/<person-slug>/g, person.slug);
      text += `\n\nThis stage covers one person only: ${person.name} (page suffix -${person.slug}).`;
    }
    // Cold stages get no trace of our side: not even our name.
    return { id, label, online, cold: isCold, prompt: fillPrompt(text, intake, slug, isCold ? {} : ours) };
  };
  const sec = (id) => extractSection(md, id);

  const waves = [];
  const push = (name, stages) => {
    const s = stages.filter((x) => x && x.prompt);
    if (s.length) waves.push({ wave: name, stages: s });
  };

  push("inventory", [sec("P1") && make("P1", "Inventory", sec("P1"), { online: false })]);
  push("harvest", [sec("P2") && make("P2", "Harvest", sec("P2"))]);
  push("research", ["P3a", "P3b", "P3c", "P3d", "P3e"].map((id) => sec(id) && make(id, "Research wave", sec(id))));
  if (sec("P4a")) push("people-osint", people.map((p) => make(`P4a ${p.slug}`, "Person OSINT", sec("P4a"), { isCold: true, person: p })));
  if (sec("P4b")) push("personas", people.map((p) => make(`P4b ${p.slug}`, "Persona and own words", sec("P4b"), { isCold: true, person: p })));
  push("mirror", [sec("P6") && make("P6", "Mirror (blind to the room)", sec("P6"))]);

  const p5 = splitSub(sec("P5") || "", "P5");
  push("synthesis", Object.entries(p5.parts).map(([id, body]) => make(id, "Synthesis", body, { online: false, isOffline: true, isCold: id === "P5e" })));

  const p7 = splitSub(sec("P7") || "", "P7");
  push("verification", Object.entries(p7.parts).map(([id, body]) => make(id, "Verification (you did not write what you check)", body)));
  if (Object.keys(p7.parts).length)
    push("corrections", [make("P7-fix", "Apply verification fixes", `Read every review written in the verification stage (ACCURACY REVIEW.md, GAP REVIEW.md, the grader's scores, the boundaries list) in rooms/${slug}/work/. ${p7.tail || "Apply the fixes and log every change in CORRECTIONS LOG.md (date, was, now, why)."}`, { online: false })]);

  // AI judgement slots, after the facts are in and checked: one cold stage per person (persona
  // verdict, drivers), one for the company and Start here. Entries only, each citing ledger ids.
  if (sec("P8a"))
    push("ai-slots", [
      ...people.map((p) => make(`P8a ${p.slug}`, "AI slots: person", sec("P8a"), { online: false, isCold: true, person: p })),
      make("P8a company", "AI slots: company and Start here", sec("P8a") + "\n\nThis stage covers the company buckets and Start here only (no person buckets).", { online: false }),
    ]);
  push("render", [sec("P8") && make("P8", "Render", sec("P8"), { online: false })]);
  push("one-card", [sec("P9") && make("P9", "One card and summary", sec("P9"), { online: false })]);
  return waves;
}

/** Run tasks with at most `limit` at once. */
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
