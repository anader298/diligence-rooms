// The company's domain: mail provider and SaaS verification tokens from DNS (their stack),
// subdomains from certificate transparency (crt.sh), first web-archive capture.
import { isParkedPage } from "../colib.mjs";

const MX = [
  [/google(mail)?\.com|googlemail/i, "Google Workspace"],
  [/outlook\.com|protection\.outlook/i, "Microsoft 365"],
  [/pphosted\.com/i, "Proofpoint (gateway)"],
  [/mimecast/i, "Mimecast (gateway)"],
  [/barracuda/i, "Barracuda (gateway)"],
  [/zoho/i, "Zoho Mail"],
  [/secureserver\.net/i, "GoDaddy mail"],
  [/messagelabs|symantec/i, "Broadcom/Symantec (gateway)"],
  [/iphmx\.com/i, "Cisco Secure Email (gateway)"],
  [/forcepoint|mailcontrol/i, "Forcepoint (gateway)"],
];
const TXT = [
  [/^MS=/i, "Microsoft 365"],
  [/google-site-verification/i, "Google (Search Console/Workspace)"],
  [/atlassian-domain-verification/i, "Atlassian (Jira/Confluence)"],
  [/docusign/i, "DocuSign"],
  [/salesforce|pardot/i, "Salesforce"],
  [/hubspot|hs-site-verification/i, "HubSpot"],
  [/facebook-domain-verification/i, "Meta Business"],
  [/apple-domain-verification/i, "Apple Business"],
  [/adobe-idp-site-verification|adobe-sign-verification/i, "Adobe"],
  [/zoom_verify|zoom-domain-verification/i, "Zoom"],
  [/slack-domain-verification/i, "Slack"],
  [/stripe-verification/i, "Stripe"],
  [/openai-domain-verification/i, "OpenAI"],
  [/anthropic-domain-verification/i, "Anthropic"],
  [/miro-verification/i, "Miro"],
  [/dropbox-domain-verification/i, "Dropbox"],
  [/webexdomainverification|cisco-ci-domain-verification/i, "Cisco Webex"],
  [/citrix-verification-code/i, "Citrix"],
  [/mongodb-site-verification/i, "MongoDB Atlas"],
  [/airtable-verification/i, "Airtable"],
  [/canva-site-verification/i, "Canva"],
  [/figma/i, "Figma"],
  [/notion/i, "Notion"],
  [/okta/i, "Okta"],
  [/onetrust/i, "OneTrust"],
  [/klaviyo/i, "Klaviyo"],
  [/smartsheet/i, "Smartsheet"],
  [/workplace-domain-verification/i, "Meta Workplace"],
  [/twilio|sendgrid/i, "Twilio SendGrid"],
  [/github-challenge|_github/i, "GitHub"],
  [/amazonses/i, "Amazon SES"],
  [/knowbe4/i, "KnowBe4"],
  [/wiz-domain-verification/i, "Wiz"],
  [/postman-domain-verification/i, "Postman"],
  [/cursor-domain-verification/i, "Cursor"],
  [/1password/i, "1Password"],
  [/lastpass/i, "LastPass"],
  [/intercom/i, "Intercom"],
  [/zendesk/i, "Zendesk"],
];
const SPF = [
  [/_spf\.google\.com/i, "Google Workspace"],
  [/spf\.protection\.outlook\.com/i, "Microsoft 365"],
  [/salesforce\.com/i, "Salesforce"],
  [/mktomail\.com/i, "Marketo"],
  [/hubspotemail|hubspot/i, "HubSpot"],
  [/mcsv\.net|mailchimp|mandrillapp/i, "Mailchimp"],
  [/sendgrid\.net/i, "SendGrid"],
  [/mailgun\.org/i, "Mailgun"],
  [/amazonses\.com/i, "Amazon SES"],
  [/zendesk\.com/i, "Zendesk"],
  [/freshdesk|freshworks/i, "Freshworks"],
  [/pphosted\.com/i, "Proofpoint"],
  [/servicenow/i, "ServiceNow"],
  [/workday/i, "Workday"],
  [/netsuite/i, "NetSuite"],
  [/zoho/i, "Zoho"],
  [/qualtrics/i, "Qualtrics"],
  [/intercom/i, "Intercom"],
  [/greenhouse/i, "Greenhouse"],
  [/sparkpost/i, "SparkPost"],
  [/mimecast/i, "Mimecast"],
];

async function doh(http, name, type) {
  const r = await http.json(`https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`, { timeout: 8000 });
  return (r.data?.Answer || []).map((a) => String(a.data).replace(/^"|"$/g, "").replace(/" "/g, ""));
}

const dns = {
  id: "dns",
  label: "DNS: mail provider and SaaS stack from TXT/SPF",
  lane: "sweep",
  needs: ["domain"],
  budgetMs: 20000,
  async run(ctx) {
    const { http, add, miss, subject, shared } = ctx;
    const d = subject.domain.replace(/^www\./, "");
    const [mx, txt, dmarc] = await Promise.all([doh(http, d, "MX"), doh(http, d, "TXT"), doh(http, "_dmarc." + d, "TXT")]);
    const url = `https://dns.google/resolve?name=${d}&type=TXT`;
    if (!mx.length && !txt.length) return miss("co.domains", `no MX/TXT records returned for ${d} by dns.google`);
    const mail = [...new Set(mx.flatMap((m) => MX.filter(([re]) => re.test(m)).map(([, n]) => n)))];
    const tools = new Set();
    for (const t of txt) for (const [re, n] of TXT) if (re.test(t)) tools.add(n);
    const spf = txt.find((t) => /^v=spf1/i.test(t)) || "";
    for (const [re, n] of SPF) if (re.test(spf)) tools.add(n);
    const pol = dmarc.find((t) => /v=DMARC1/i.test(t))?.match(/p=(\w+)/i)?.[1];
    shared.stack = [...tools];
    add({ var: "co.domains", value: `Email on ${mail.join(" + ") || mx[0]?.split(" ").at(-1) || "unknown"}; DMARC ${pol || "none"}; ${tools.size} SaaS tools verified in DNS`, url, grade: "v", tier: "A", detail: { mx, txt, spf, dmarc } });
    if (tools.size) add({ var: "fit.problem", value: `Stack seen in DNS: ${[...tools].join(", ")}`, url, grade: "i", tier: "A", detail: { note: "domain-verification and SPF records show which SaaS the company has set up; it does not show who owns each tool", txt } });
  },
};

const crtsh = {
  id: "crtsh",
  label: "Certificate transparency: subdomains (crt.sh)",
  lane: "slow",
  needs: ["domain"],
  budgetMs: 25000,
  async run(ctx) {
    const { http, add, miss, subject } = ctx;
    const d = subject.domain.replace(/^www\./, "");
    const u = `https://crt.sh/?q=${encodeURIComponent("%." + d)}&output=json&exclude=expired`;
    let r = await http.json(u, { timeout: 15000 });
    let scope = "unexpired certificates";
    if (!r.data) {
      r = await http.json(`https://crt.sh/?q=${encodeURIComponent("%." + d)}&output=json`, { timeout: 8000 });
      scope = "all certificates, expired included";
    }
    if (!r.data) return miss("co.domains", `crt.sh ${r.status || r.error} (often slow or overloaded)`);
    const names = new Set();
    let first = null;
    for (const c of r.data) {
      for (const n of String(c.name_value || "").split(/\n/)) {
        const x = n.trim().toLowerCase().replace(/^\*\./, "");
        if (x.endsWith(d) && x !== d) names.add(x);
      }
      if (c.not_before && (!first || c.not_before < first)) first = c.not_before;
    }
    const list = [...names].sort();
    const notable = list.filter((n) => /(^|\.|-)(vpn|sso|okta|auth|login|jira|confluence|gitlab|github|jenkins|staging|stage|dev|test|uat|api|portal|shop|store|status|support|help|docs|mail|webmail|owa|citrix|remote|sap|erp|crm|hr|ats|careers|investors?|ir|partners?|app|admin|grafana|kibana|vault)\b/.test(n.replace(d, "")));
    add({ var: "co.domains", value: `${list.length} subdomains in certificate logs (${scope})${notable.length ? `; notable: ${notable.slice(0, 12).join(", ")}` : ""}`, url: `https://crt.sh/?q=%25.${d}`, grade: "v", tier: "A", detail: { subdomains: list.slice(0, 300), notable, oldestCertInSet: first, scope } });
    const hints = notable.filter((n) => /(jira|confluence|gitlab|jenkins|okta|sap|citrix|grafana|kibana|vault|erp|crm)/.test(n));
    if (hints.length) add({ var: "fit.problem", value: `Self-hosted systems in subdomains: ${hints.slice(0, 8).join(", ")}`, url: `https://crt.sh/?q=%25.${d}`, grade: "i", tier: "A" });
  },
};

const wayback = {
  id: "wayback",
  label: "Web archive: first capture of the company site",
  lane: "sweep",
  needs: ["domain"],
  budgetMs: 20000,
  async run(ctx) {
    const { http, add, miss, subject, shared } = ctx;
    const d = subject.domain.replace(/^www\./, "");
    // first captures that returned a page (status 200), one a month, oldest first
    const r = await http.json(`https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(d)}&output=json&fl=timestamp,original&filter=statuscode:200&collapse=timestamp:6&limit=8`, { timeout: 15000 });
    const caps = (r.data || []).slice(1);
    if (!caps.length) return miss("co.domains", `Wayback CDX ${r.status || r.error || "no captures that returned a page"}`);
    // skip parked and for-sale pages: those are a previous owner (or nobody), not the company
    let first = null;
    let parked = 0;
    for (const [ts, orig] of caps.slice(0, 4)) {
      const p = await http.get(`https://web.archive.org/web/${ts}id_/${orig}`, { timeout: 12000 });
      if (p.ok && isParkedPage(p.text)) {
        parked++;
        continue;
      }
      first = [ts, orig, p.ok];
      break;
    }
    if (!first) return miss("co.domains", `Wayback: the first ${parked} captures of ${d} are parked or for-sale pages`);
    const [ts, orig, read] = first;
    const date = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
    shared.firstSeenYear = Number(ts.slice(0, 4));
    add({ var: "co.domains", value: `${d} first served a page in the web archive on ${date}${parked ? ` (${parked} earlier parked/for-sale capture${parked === 1 ? "" : "s"} skipped)` : ""}`, url: `https://web.archive.org/web/${ts}/${orig}`, grade: read ? "v" : "p", tier: "A", date, detail: { note: "when the domain first served a real page; it may have belonged to a previous owner, so it is not the company's founding date", parkedSkipped: parked } });
  },
};

export default [dns, crtsh, wayback];
