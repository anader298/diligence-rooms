// domain-intel: RDAP (the registry's structured WHOIS) for the company's domain via rdap.org's
// bootstrap redirect: registration date (a key date: how old the web presence is), expiry,
// registrar, nameservers (self-hosted DNS or a provider), lock status, and the registrant
// organisation when the registrar's RDAP shows it (most redact it). Keyless, 0.4-1.2 s.

const vcardFn = (e) => (e?.vcardArray?.[1] || []).find((x) => x[0] === "fn")?.[3] || null;
const vcardOrg = (e) => (e?.vcardArray?.[1] || []).find((x) => x[0] === "org")?.[3] || null;

/** Summary of an RDAP domain object. */
export function parseRdap(j) {
  if (!j || j.objectClassName !== "domain") return null;
  const ev = Object.fromEntries((j.events || []).map((e) => [e.eventAction, String(e.eventDate || "").slice(0, 10)]));
  const ents = j.entities || [];
  const registrar = ents.find((e) => (e.roles || []).includes("registrar"));
  const registrant = ents.find((e) => (e.roles || []).includes("registrant"));
  const org = registrant ? vcardOrg(registrant) || vcardFn(registrant) : null;
  return {
    domain: String(j.ldhName || "").toLowerCase(),
    registered: ev.registration || null,
    expires: ev.expiration || null,
    changed: ev["last changed"] || null,
    registrar: registrar ? vcardFn(registrar) : null,
    registrarId: registrar?.publicIds?.find((p) => /IANA/i.test(p.type))?.identifier || null,
    registrant: org && !/redacted|privacy|proxy|data protected|not disclosed/i.test(org) ? org : null,
    nameservers: (j.nameservers || []).map((n) => String(n.ldhName || "").toLowerCase()).filter(Boolean),
    status: j.status || [],
    dnssec: !!j.secureDNS?.delegationSigned,
    related: (j.links || []).find((l) => l.rel === "related" && /rdap/i.test(l.href || ""))?.href || null,
  };
}

/** Who runs the DNS, from nameserver names. */
export function dnsHost(ns, domain) {
  const all = ns.join(" ");
  const rules = [[/awsdns/, "Amazon Route 53"], [/cloudflare/, "Cloudflare"], [/azure-dns/, "Azure DNS"], [/googledomains|google\.com|ns-cloud/, "Google Cloud DNS"], [/akam|akamai/, "Akamai"], [/nsone/, "NS1"], [/ultradns/, "UltraDNS"], [/dynect/, "Dyn"], [/domaincontrol/, "GoDaddy"], [/registrar-servers|namecheap/, "Namecheap"], [/wixdns/, "Wix"], [/squarespacedns/, "Squarespace"], [/markmonitor/, "MarkMonitor"], [/csc(dns|globalnameservers)/, "CSC"]];
  const hit = rules.find(([re]) => re.test(all));
  if (hit) return hit[1];
  return ns.length && ns.every((n) => n.endsWith("." + domain)) ? "self-hosted" : null;
}

export default {
  id: "domain-intel",
  /** The ledger variables this module fills (config/form buckets read them to say "no tool yet"). */
  vars: ["co.domains"],
  label: "Domain registration (RDAP): age, registrar, DNS host",
  lane: "fast",
  needs: ["domain"],
  budgetMs: 10000,
  async run(ctx) {
    const { subject, http } = ctx;
    const dom = subject.domain.replace(/^www\./, "").toLowerCase();
    const r = await http.json(`https://rdap.org/domain/${dom}`, { timeout: 8000, headers: { accept: "application/rdap+json" } });
    const d = parseRdap(r.data);
    if (!d) return ctx.miss("co.domains", `RDAP for ${dom}: ${r.status === 404 ? "no record (the TLD may not offer RDAP)" : `HTTP ${r.status || r.error}, not checked`}`, { blocked: r.status !== 404 });
    // the registrar's own RDAP sometimes names the registrant organisation; one extra call, optional
    if (d.related && !d.registrant) {
      const rr = await http.json(d.related, { timeout: 4000, headers: { accept: "application/rdap+json" } });
      const d2 = parseRdap(rr.data);
      if (d2?.registrant) d.registrant = d2.registrant;
    }
    const host = dnsHost(d.nameservers, dom);
    const age = d.registered ? Math.floor((Date.now() - Date.parse(d.registered)) / (365.25 * 864e5)) : null;
    ctx.add({
      var: "co.domains",
      value: `${dom}: registered ${d.registered || "?"}${age != null ? ` (${age} years ago)` : ""}, expires ${d.expires || "?"}; registrar ${d.registrar || "?"}${d.registrant ? `; registrant ${d.registrant}` : ""}; DNS ${host || d.nameservers.slice(0, 2).join(", ") || "?"}${d.dnssec ? ", DNSSEC on" : ""}${d.status.some((s) => /server .* prohibited/.test(s)) ? "; registry lock" : ""}`,
      url: `https://client.rdap.org/?type=domain&object=${dom}`,
      grade: "v",
      tier: "A",
      date: d.registered,
      anchors: ["domain"],
      detail: { ...d, dnsHost: host },
    });
    if (d.registered) ctx.shared.domainRegistered = d.registered;
  },
};
