// Other names the person has used: a maiden or former surname ("Dana (Albrecht) Whitlock",
// "Jane Doe, née Smith", "formerly Jane Smith"), read from the search and news snippets already
// in hand. No network. A form is kept only when the same text names the company, so a stranger's
// wedding notice is not taken as the subject's. Found names go to subject.foundAliases, which
// nameVariants() reads, so the modules that run after this one match them too.

import { nameParts, companyIn, normName, firstForms } from "../person-lib.mjs";

const SKIP = new Set("ceo cfo cto coo cmo vp svp evp phd mba md jd cpa inc llc the and of at for jr sr ii iii linkedin".split(" "));
const word = "[A-Z][a-zA-Z'’-]{1,24}";

/** Other surnames for the subject found in one text. Returns [{ alias, kind, match }]. */
export function aliasesIn(text, subject) {
  const t = String(text || "").replace(/\s+/g, " ");
  const raw = String(subject.name || "").trim().split(/\s+/);
  const First = raw[0];
  const Last = raw.at(-1);
  const { first, last } = nameParts(subject.name);
  if (!first || !last) return [];
  const F = First.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const L = Last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const out = [];
  const keep = (x, kind, match) => {
    const n = normName(x);
    if (!n || n === last || SKIP.has(n) || n.length < 3 || firstForms(first).includes(n)) return;
    if (!out.some((o) => normName(o.alias) === normName(`${First} ${x}`))) out.push({ alias: `${First} ${x}`, surname: x, kind, match: match.slice(0, 120) });
  };
  const pats = [
    [new RegExp(`\\b${F}\\s+\\((?:n[ée]e\\s+)?(${word})\\)\\s+${L}\\b`, "g"), "maiden (in parentheses)"],
    [new RegExp(`\\b${F}\\s+${L}\\s*\\((?:n[ée]e|born|formerly)\\s+(${word})\\)`, "gi"), "née"],
    [new RegExp(`\\b${F}\\s+${L},?\\s+(?:n[ée]e|born)\\s+(${word})\\b`, "g"), "née"],
    [new RegExp(`\\b${F}\\s+${L},?\\s+\\(?formerly\\s+(?:known as\\s+)?${F}\\s+(${word})\\b`, "gi"), "former name"],
    [new RegExp(`\\b(?:formerly|previously)\\s+(?:known as\\s+)?${F}\\s+(${word})\\b[^.]{0,80}\\b${F}\\s+${L}\\b`, "gi"), "former name"],
    [new RegExp(`\\b${F}\\s+(${word})\\s+${L}\\b`, "g"), "middle or maiden"],
  ];
  for (const [re, kind] of pats) {
    for (const m of t.matchAll(re)) {
      const x = m[1];
      // "First Middle Last": only a capitalised surname-like middle word that is not an initial,
      // a title or a common first name; it is still a lead, so it is marked as such.
      if (kind === "middle or maiden" && (x.length < 4 || /^(Mary|Ann|Anne|Lee|Lynn|Marie|Jean|Jo|Michael|James|John|Paul|David|Joseph|Elizabeth)$/i.test(x))) continue;
      keep(x, kind, m[0]);
    }
  }
  return out;
}

export default {
  id: "aliases",
  label: "Other names (maiden, former) from snippets",
  lane: "sweep",
  needs: ["name"],
  budgetMs: 3000,
  async run(ctx) {
    const { subject, shared } = ctx;
    const texts = [...(shared.searchResults || []), ...(shared.newsItems || [])];
    const found = new Map();
    for (const r of texts) {
      const t = `${r.title || ""} ${r.snippet || ""}`;
      if (!companyIn(t, subject)) continue;
      for (const a of aliasesIn(t, subject)) {
        const k = normName(a.alias);
        if (!found.has(k)) found.set(k, { ...a, urls: [] });
        found.get(k).urls.push(r.url);
      }
    }
    // A middle word seen once is noise; a parenthesised or née form is a statement.
    const keep = [...found.values()].filter((a) => a.kind !== "middle or maiden" || a.urls.length >= 2);
    if (!keep.length) {
      ctx.miss("names.aliases", `no maiden or former name in ${texts.length} search and news snippets (patterns: "First (X) Last", "née X", "formerly First X")`);
      return;
    }
    subject.foundAliases = [...new Set([...(subject.foundAliases || []), ...keep.map((a) => a.alias)])];
    shared.aliases = subject.foundAliases;
    for (const a of keep) {
      ctx.add({ var: "names.aliases", tab: "professional", label: "Other names (maiden, former)", group: "Career", value: `${a.alias} (${a.kind}: "${a.match}")`, url: a.urls[0], grade: a.kind === "middle or maiden" ? "w" : "p", tier: "C", anchors: ["name", "company"], detail: { surname: a.surname, kind: a.kind, sources: a.urls.slice(0, 5) } });
    }
  },
};
