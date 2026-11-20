// registries: the company's place in its corporate group from GLEIF Level 2 data (CC0): direct
// and ultimate parent, and direct children (subsidiaries that report this LEI as their parent).
// Builds on company-resolve's LEI (scripts/osint/resolve.mjs). Keyless, about 0.5-1 s.

import { companyBase, countryOf } from "../resolve.mjs";

const GLEIF = "https://api.gleif.org/api/v1";
const H = { accept: "application/vnd.api+json" };

/** { lei, name, country, status } from a GLEIF lei-record. */
export function leiBrief(d) {
  if (!d?.id) return null;
  const e = d.attributes?.entity || {};
  return { lei: d.id, name: e.legalName?.name || d.id, country: countryOf(e.legalAddress?.country), city: e.legalAddress?.city || null, status: e.status || null };
}

export default {
  id: "registries",
  label: "Corporate group: parent and subsidiaries (GLEIF)",
  lane: "fast",
  needs: ["company"],
  budgetMs: 12000,
  async run(ctx) {
    const { http } = ctx;
    const c = await companyBase(ctx);
    if (!c.lei) return ctx.miss("co.structure", `no LEI found for "${ctx.subject.company}" in GLEIF, so no parent or subsidiary records${c.gleifStatus && c.gleifStatus !== 200 ? ` (GLEIF answered ${c.gleifStatus}: unknown)` : ""}`);
    const base = `${GLEIF}/lei-records/${c.lei}`;
    const [dp, up, kids] = await Promise.all([
      http.json(`${base}/direct-parent`, { headers: H, timeout: 8000 }),
      http.json(`${base}/ultimate-parent`, { headers: H, timeout: 8000 }),
      http.json(`${base}/direct-children?page[size]=25`, { headers: H, timeout: 8000 }),
    ]);
    const page = `https://search.gleif.org/#/record/${c.lei}`;
    const refused = [dp, up, kids].filter((r) => [403, 429, 503].includes(r.status) || r.status === 0);
    if (refused.length === 3) {
      ctx.status("blocked", `GLEIF ${refused[0].status || refused[0].error}`);
      return ctx.miss("co.structure", `GLEIF relationships: blocked (HTTP ${refused[0].status || refused[0].error}), unknown`);
    }
    const dParent = leiBrief(dp.data?.data);
    const uParent = leiBrief(up.data?.data);
    if (dParent) ctx.add({ var: "co.structure", value: `Direct parent: ${dParent.name} (LEI ${dParent.lei}, ${dParent.country || "?"})`, url: `https://search.gleif.org/#/record/${dParent.lei}`, grade: "v", tier: "A", anchors: ["lei"], detail: { relation: "direct-parent", of: c.lei, ...dParent } });
    if (uParent && uParent.lei !== dParent?.lei) ctx.add({ var: "co.structure", value: `Ultimate parent: ${uParent.name} (LEI ${uParent.lei}, ${uParent.country || "?"})`, url: `https://search.gleif.org/#/record/${uParent.lei}`, grade: "v", tier: "A", anchors: ["lei"], detail: { relation: "ultimate-parent", of: c.lei, ...uParent } });
    if (!dParent && !uParent && dp.status === 404) ctx.add({ var: "co.structure", value: `${c.leiRecord?.legalName || ctx.subject.company} reports no parent to GLEIF (top of its group, or a reporting exception)`, url: page, grade: "v", tier: "A", anchors: ["lei"], detail: { relation: "no-parent", of: c.lei } });
    const children = (kids.data?.data || []).map(leiBrief).filter(Boolean);
    const total = kids.data?.meta?.pagination?.total ?? children.length;
    if (children.length) {
      const byCountry = {};
      for (const k of children) byCountry[k.country || "?"] = (byCountry[k.country || "?"] || 0) + 1;
      ctx.add({
        var: "co.structure",
        value: `${total} direct subsidiar${total === 1 ? "y" : "ies"} with an LEI: ${children.slice(0, 8).map((k) => `${k.name} (${k.country || "?"})`).join("; ")}${total > 8 ? `; and ${total - 8} more` : ""}`,
        url: page,
        grade: "v",
        tier: "A",
        anchors: ["lei"],
        detail: { relation: "direct-children", of: c.lei, total, byCountry, children },
      });
    } else if (kids.ok) ctx.miss("co.structure", `GLEIF: no subsidiaries report LEI ${c.lei} as their direct parent`);
  },
};
