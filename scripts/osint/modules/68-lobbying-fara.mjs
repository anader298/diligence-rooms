// lobbying-fara: is the person a registered federal lobbyist (lda.gov lobbyist records, with the
// registrant firm that employs them), and is the company a registered foreign agent (FARA active
// registrants, efile.fara.gov)? The company's own lobbying spend as a client is in the `gov`
// module. Keyless; lda.gov allows 15 calls a minute, 120 with a free LDA_API_KEY.

import { nameParts, firstForms, normName, companyIn, isBlocked, blockedMiss } from "../person-lib.mjs";
import { normCompany } from "../colib.mjs";

const cap = (s) => String(s || "").toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, a, b) => a + b.toUpperCase());

/** LDA lobbyist records naming the subject, with the registrant firm and an employer anchor. */
export function matchLobbyists(json, subject) {
  const { first, last } = nameParts(subject.name);
  const forms = firstForms(first);
  return (json?.results || [])
    .filter((r) => normName(r.last_name) === last && (forms.includes(normName(r.first_name).split(" ")[0]) || forms.includes(normName(r.nickname || ""))))
    .map((r) => {
      const firm = r.registrant?.name || "";
      const co = companyIn(firm, subject);
      return { id: r.id, name: cap([r.first_name, r.middle_name, r.last_name].filter(Boolean).join(" ")), firm, firmId: r.registrant?.id, city: r.registrant?.city, state: r.registrant?.state, updated: r.registrant?.dt_updated?.slice(0, 10) || null, anchors: co ? ["name", "company"] : ["name"], grade: co ? "v" : "w" };
    });
}

/** FARA active registrants whose name is the company. */
export function matchFara(json, names) {
  const want = new Set(names.filter(Boolean).map(normCompany).filter((w) => w.length > 2));
  const rows = json?.REGISTRANTS_ACTIVE?.ROW;
  return (Array.isArray(rows) ? rows : rows ? [rows] : []).filter((r) => want.has(normCompany(r.Name)));
}

export default {
  id: "lobbying-fara",
  label: "Registered lobbyist (lda.gov) and foreign agent (FARA) checks",
  lane: "fast",
  needs: ["name"],
  env: ["LDA_API_KEY"],
  budgetMs: 12000,
  async run(ctx) {
    const { subject, http, env } = ctx;
    const ldaH = env.LDA_API_KEY ? { authorization: `Token ${env.LDA_API_KEY}` } : {};
    const [lda, fara] = await Promise.all([
      http.json(`https://lda.gov/api/v1/lobbyists/?lobbyist_name=${encodeURIComponent(subject.name)}&page_size=25`, { headers: ldaH, timeout: 8000 }),
      subject.company ? http.json("https://efile.fara.gov/api/v1/Registrants/json/Active", { timeout: 8000 }) : null,
    ]);
    const ldaWeb = `https://lda.gov/filings/public/lobbyist/search/?lobbyist_name=${encodeURIComponent(subject.name)}`;
    if (!lda.ok) {
      if (isBlocked(lda)) blockedMiss(ctx, "politics.person_lobbying", "lda.gov lobbyist search", lda, env.LDA_API_KEY ? "retry in a minute" : "set a free LDA_API_KEY (120 calls a minute) or retry in a minute", { partial: !!fara?.ok });
      else ctx.miss("politics.person_lobbying", `lda.gov lobbyist search: HTTP ${lda.status || lda.error}, not checked`);
    } else {
      const m = matchLobbyists(lda.data, subject);
      if (!m.length) ctx.add({ var: "politics.person_lobbying", value: `Not a registered federal lobbyist: no lda.gov lobbyist record for ${subject.name}`, url: ldaWeb, grade: "v", tier: "A", detail: { checked: "lda.gov /lobbyists", count: lda.data?.count ?? 0 } });
      const strong = m.filter((x) => x.anchors.length > 1);
      for (const x of (strong.length ? strong : m).slice(0, 6)) {
        ctx.add({ var: "politics.person_lobbying", value: `Registered lobbyist ${x.name} for ${x.firm}${x.city ? ` (${cap(x.city)}, ${x.state})` : ""}${x.anchors.includes("company") ? "" : " — name match only, could be a namesake"}`, url: x.firmId ? `https://lda.gov/api/v1/registrants/${x.firmId}/` : ldaWeb, grade: x.grade, tier: "A", anchors: x.anchors, date: x.updated, detail: x });
      }
    }
    if (!subject.company) return;
    if (!fara?.ok) {
      if (isBlocked(fara)) blockedMiss(ctx, "politics.company_pac", "FARA registrant list", fara, "retry later", { partial: true });
      else ctx.miss("politics.company_pac", `FARA registrant list: HTTP ${fara?.status || fara?.error}, not checked`);
      return;
    }
    const hits = matchFara(fara.data, [subject.company, ctx.shared.secName]);
    const total = fara.data?.REGISTRANTS_ACTIVE?.ROW?.length ?? 0;
    for (const h of hits) {
      ctx.add({ var: "politics.company_pac", value: `FARA: ${h.Name} is an active registered foreign agent, registration ${h.Registration_Number} since ${h.Registration_Date} (${h.City}, ${h.State})`, url: `https://efile.fara.gov/ords/fara/f?p=1381:200:::NO:RP,200:P200_REG_NUMBER:${h.Registration_Number}`, grade: "v", tier: "A", anchors: ["company"], date: h.Registration_Date ? h.Registration_Date.replace(/(\d+)\/(\d+)\/(\d{4})/, (_, mo, d, y) => `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`) : null, detail: h });
    }
    if (!hits.length) ctx.miss("politics.company_pac", `FARA: "${subject.company}" is not among the ${total} active foreign-agent registrants`);
  },
};
