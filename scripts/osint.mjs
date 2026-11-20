#!/usr/bin/env node
// Public-source research on one person and their company, in about a minute, with no paid keys.
//
//   npm run osint -- --name "Jane Doe" --company "Acme Corp" [--domain acme.com] [--title "VP Ops"]
//                    [--city Austin --state TX] [--handles janedoe,jdoe] [--photo <url>]
//                    [--aliases "Janet Doe,J. Doe"] [--ticker ACME]
//                    [--email jane@acme.com] [--country FR]
//                    [--room <slug>] [--only sec,fec] [--out <dir>] [--open]
//                    [--heavy headshot-match,article-extract,transcripts,doc-metadata,sec-proxy|all]
//                    [--transcribe] [--articles url1,url2] [--docs <dir>]
//
// Nicknames are handled for you: "Dan Holloway" also searches "Daniel Holloway" (and back).
// --aliases adds other names the person files or publishes under (maiden name, middle name).
//
// Writes <out>/ledger.jsonl (one row per finding, with its source), osint.json and dossier.html.
// With --room the output goes to rooms/<slug>/work/osint/<person>/, where the research agents
// and the studio read it. A folder that already holds a different person is moved aside first.
// Optional free keys in .env make more modules run: FEC_API_KEY, COURTLISTENER_TOKEN,
// OPENSANCTIONS_API_KEY, BRAVE_API_KEY, GITHUB_TOKEN, SEC_USER_AGENT, USPTO_API_KEY and more;
// `npm run doctor` lists them. The heavy lane (--heavy) runs Python sidecars and exiftool, opt-in
// only; a missing library is reported as an error row with the pip line. See docs/osint.md.
import { parseArgs } from "node:util";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { runOsint, REPO } from "./osint/run.mjs";
import { renderDossier } from "./osint/dossier.mjs";

const usage = 'usage: npm run osint -- --name "Full Name" --company "Company" [--domain d] [--title t] [--city c --state ST] [--handles a,b] [--aliases "Other Name,..."] [--ticker T] [--photo url] [--email e] [--country CC] [--room slug] [--only m1,m2] [--out dir] [--open] [--heavy ids|all] [--transcribe] [--articles u1,u2] [--docs dir]';
let values;
try {
  ({ values } = parseArgs({
    options: {
      name: { type: "string" },
      company: { type: "string" },
      domain: { type: "string" },
      title: { type: "string" },
      city: { type: "string" },
      state: { type: "string" },
      handles: { type: "string" },
      aliases: { type: "string" },
      photo: { type: "string" },
      ticker: { type: "string" },
      email: { type: "string" },
      country: { type: "string" },
      heavy: { type: "string" },
      transcribe: { type: "boolean", default: false },
      articles: { type: "string" },
      docs: { type: "string" },
      room: { type: "string" },
      only: { type: "string" },
      out: { type: "string" },
      open: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  }));
} catch (e) {
  console.error(e.message + "\n" + usage);
  process.exit(1);
}
if (values.help || !values.name) {
  console.log(usage);
  process.exit(values.help ? 0 : 1);
}
const list = (s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);
const subject = {
  name: values.name.trim(),
  company: values.company?.trim() || null,
  domain: values.domain?.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "") || null,
  title: values.title || null,
  city: values.city || null,
  state: values.state || null,
  handles: list(values.handles),
  aliases: list(values.aliases),
  photo: values.photo || null,
  ticker: values.ticker || null,
  email: values.email?.trim() || null,
  country: values.country?.trim().toUpperCase() || null,
};
const slugOf = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const outDir = values.out || (values.room ? join(REPO, "rooms", values.room, "work", "osint", slugOf(subject.name)) : join(REPO, "work", "osint", slugOf(subject.name)));

console.log(`OSINT: ${subject.name}${subject.company ? " · " + subject.company : ""} → ${outDir}`);
// --transcribe opts in to the transcripts module (and its Whisper fallback); --articles and --docs
// hand inputs to article-extract and doc-metadata.
const heavy = [...list(values.heavy), ...(values.transcribe ? ["transcripts"] : [])];
const opts = { transcribe: values.transcribe, articles: list(values.articles), docs: values.docs || null };
const result = await runOsint(subject, { outDir, only: values.only ? list(values.only) : null, heavy: heavy.length ? heavy : null, opts });
const file = join(outDir, "dossier.html");
writeFileSync(file, renderDossier(result));
const found = new Set(result.rows.map((r) => r.var)).size;
console.log(`\n${result.rows.length} findings across ${found} variables in ${result.seconds}s · ${result.http.calls} calls, ${result.http.blocked} blocked`);
for (const a of result.alerts || []) console.log(`ALERT: ${a.text}${a.url ? ` (${a.url})` : ""}`);
const blocked = result.modules.filter((m) => m.status === "blocked");
if (blocked.length) console.log(`blocked, not checked: ${blocked.map((m) => `${m.id}${m.why ? ` (${m.why})` : ""}`).join("; ")}`);
console.log(`dossier: ${file}`);
if (values.open) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [file]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", file]] : ["xdg-open", [file]];
  execFile(cmd, args, (err) => err && console.log(`could not open a browser (${err.message}); open ${file} yourself`));
}
