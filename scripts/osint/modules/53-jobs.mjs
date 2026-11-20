// Open roles from the company's public job board. Finds the ATS from the careers page
// (Greenhouse, Lever, Ashby, Gem, SmartRecruiters, Workable, Recruitee, Jobvite, Paylocity,
// Workday, BambooHR), else probes slug guesses on the keyless JSON APIs.
import { normName } from "../core.mjs";
import { parseJobs, paylocityPageData, parseJobviteHtml, deptOf, termCounts, reportsTo, titleWords, normCompany, htmlText, stripBoilerplate, titleFor } from "../colib.mjs";

const CAREERS = ["/careers", "/careers/", "/jobs", "/company/careers", "/about/careers", "/careers/open-positions/", "/join-us", "/work-with-us", "/about-us/careers"];

const DETECT = [
  ["greenhouse", /(?:boards|job-boards)(?:-api)?\.greenhouse\.io\/(?:v1\/boards\/|embed\/job_board(?:\/js)?\?for=)?([a-z0-9_-]+)/i],
  ["lever", /jobs\.lever\.co\/([a-z0-9_.-]+)/i],
  ["ashby", /jobs\.ashbyhq\.com\/([a-z0-9_.%-]+)/i],
  ["gem", /jobs\.gem\.com\/([a-z0-9_-]+)/i],
  ["smartrecruiters", /(?:jobs|careers)\.smartrecruiters\.com\/([a-z0-9_-]+)/i],
  ["workable", /apply\.workable\.com\/([a-z0-9_-]+)/i],
  ["recruitee", /([a-z0-9-]+)\.recruitee\.com/i],
  ["jobvite", /jobs\.jobvite\.com\/([a-z0-9_-]+)|jobvite\.com\/([a-z0-9_-]+)\/(?:jobs?|jobAlerts)/i],
  ["paylocity", /recruiting\.paylocity\.com\/recruiting\/jobs\/All\/([0-9a-f-]{36})(?:\/([^"'\s<>?]+))?/i],
  ["workday", /([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)/],
  ["bamboohr", /([a-z0-9-]+)\.bamboohr\.com\/(?:careers|jobs)/i],
];
const BAD_SLUG = /^(support|images|www|embed|js|api|static|careers|jobs|v1)$/i;

function detect(html) {
  const out = [];
  for (const [kind, re] of DETECT) {
    const m = String(html).match(re);
    if (!m) continue;
    const slug = m[1] || m[2];
    if (!slug || BAD_SLUG.test(slug)) continue;
    out.push({ kind, slug, extra: m.slice(2), how: "careers page" });
  }
  return out;
}

async function fetchBoard(http, b) {
  const s = encodeURIComponent(b.slug);
  switch (b.kind) {
    case "greenhouse": {
      const u = `https://boards-api.greenhouse.io/v1/boards/${s}/jobs?content=true`;
      const r = await http.json(u, { timeout: 15000 });
      return { url: `https://job-boards.greenhouse.io/${s}`, api: u, jobs: parseJobs("greenhouse", r.data), ok: !!r.data };
    }
    case "gem": {
      const u = `https://api.gem.com/job_board/v0/${s}/job_posts/`;
      const r = await http.json(u, { timeout: 15000 });
      return { url: `https://jobs.gem.com/${s}`, api: u, jobs: parseJobs("gem", r.data), ok: Array.isArray(r.data) };
    }
    case "lever": {
      const u = `https://api.lever.co/v0/postings/${s}?mode=json`;
      const r = await http.json(u, { timeout: 15000 });
      return { url: `https://jobs.lever.co/${s}`, api: u, jobs: parseJobs("lever", r.data), ok: Array.isArray(r.data) };
    }
    case "ashby": {
      const u = `https://api.ashbyhq.com/posting-api/job-board/${s}?includeCompensation=true`;
      const r = await http.json(u, { timeout: 15000 });
      return { url: `https://jobs.ashbyhq.com/${s}`, api: u, jobs: parseJobs("ashby", r.data), ok: !!r.data?.jobs };
    }
    case "smartrecruiters": {
      const u = `https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=100`;
      const r = await http.json(u, { timeout: 15000 });
      return { url: `https://jobs.smartrecruiters.com/${s}`, api: u, jobs: parseJobs("smartrecruiters", r.data), ok: !!r.data?.content, total: r.data?.totalFound };
    }
    case "workable": {
      const u = `https://apply.workable.com/api/v1/widget/accounts/${s}?details=true`;
      const r = await http.json(u, { timeout: 15000 });
      return { url: `https://apply.workable.com/${s}`, api: u, jobs: parseJobs("workable", r.data), ok: !!r.data?.jobs };
    }
    case "recruitee": {
      const u = `https://${s}.recruitee.com/api/offers/`;
      const r = await http.json(u, { timeout: 15000 });
      return { url: `https://${s}.recruitee.com`, api: u, jobs: parseJobs("recruitee", r.data), ok: !!r.data?.offers };
    }
    case "jobvite": {
      const u = `https://jobs.jobvite.com/${s}/jobs`;
      const r = await http.get(u, { timeout: 15000 });
      const jobs = r.ok ? parseJobviteHtml(r.text) : [];
      return { url: u, api: u, jobs, ok: r.ok && /jv-job-list|jv-page/.test(r.text) };
    }
    case "paylocity": {
      const u = `https://recruiting.paylocity.com/recruiting/jobs/All/${b.slug}${b.extra?.[0] ? "/" + b.extra[0] : ""}`;
      const r = await http.get(u, { timeout: 15000 });
      const pd = r.ok ? paylocityPageData(r.text) : null;
      return { url: u, api: u, jobs: parseJobs("paylocity", pd), ok: !!pd };
    }
    case "workday": {
      const [wd, site] = b.extra;
      const u = `https://${b.slug}.${wd}.myworkdayjobs.com/wday/cxs/${b.slug}/${site}/jobs`;
      const r = await http.get(u, { method: "POST", body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: "" }), headers: { "content-type": "application/json", accept: "application/json" }, timeout: 15000 });
      let d = null;
      try {
        d = JSON.parse(r.text);
      } catch {
        d = null; // Workday answered with HTML (blocked or moved): treated as no board
      }
      const jobs = (d?.jobPostings || []).map((j) => ({ title: j.title, dept: null, location: j.locationsText, url: `https://${b.slug}.${wd}.myworkdayjobs.com/${site}${j.externalPath}`, text: "", date: j.postedOn }));
      return { url: `https://${b.slug}.${wd}.myworkdayjobs.com/${site}`, api: u, jobs, ok: !!d, total: d?.total };
    }
    case "bamboohr": {
      const u = `https://${s}.bamboohr.com/careers/list`;
      const r = await http.json(u, { timeout: 15000 });
      const jobs = (r.data?.result || []).map((j) => ({ title: j.jobOpeningName, dept: j.departmentLabel, location: [j.location?.city, j.location?.state].filter(Boolean).join(", "), url: `https://${s}.bamboohr.com/careers/${j.id}`, text: "", date: null }));
      return { url: `https://${s}.bamboohr.com/careers`, api: u, jobs, ok: !!r.data?.result };
    }
  }
  return { ok: false, jobs: [] };
}

function slugGuesses(subject) {
  const d = (subject.domain || "").replace(/^www\./, "").split(".")[0];
  const c = normCompany(subject.company || "");
  return [...new Set([d, c.replace(/ /g, ""), c.replace(/ /g, "-"), normName(subject.company || "").replace(/ /g, "")].filter((x) => x && x.length > 2))];
}

export default {
  id: "jobs",
  label: "Job board: open roles, teams, reporting lines, tools",
  lane: "fast",
  needs: ["company"],
  budgetMs: 30000,
  async run(ctx) {
    const { http, add, miss, subject, shared } = ctx;
    let boards = [];
    const tried = [];
    if (subject.domain) {
      const root = `https://${subject.domain.replace(/^www\./, "")}`;
      const pages = (await Promise.all(CAREERS.map((p) => http.get(root + p, { timeout: 10000 })))).filter((r) => r.ok);
      for (const p of pages) boards.push(...detect(p.text));
      if (!boards.length) {
        // one hop: "open positions" / "see all jobs" links on the careers page
        const hops = new Set();
        for (const p of pages)
          for (const m of p.text.matchAll(/href=["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
            const t = htmlText(m[2]);
            if (/(open (positions|roles|jobs)|view (all )?(jobs|openings|positions)|see (all )?(jobs|openings)|current openings|job openings|search jobs|all jobs|join our team)/i.test(t) || /open-positions|openings|job-board|all-jobs/i.test(m[1])) {
              try {
                hops.add(new URL(m[1], p.url).href);
              } catch {
                // a malformed href on the careers page: skip it
              }
            }
          }
        const more = await Promise.all([...hops].slice(0, 3).map((u) => http.get(u, { timeout: 10000 })));
        for (const r of more) if (r.ok) boards.push(...detect(r.text), ...detect(r.url));
      }
      tried.push(`${pages.length} careers pages on ${subject.domain}`);
    }
    // dedupe, then fall back to slug probes on the JSON APIs
    const seen = new Set();
    boards = boards.filter((b) => !seen.has(b.kind + b.slug) && seen.add(b.kind + b.slug));
    let res = null;
    for (const b of boards) {
      const r = await fetchBoard(http, b);
      if (r.ok) {
        res = { ...r, board: b };
        break;
      }
    }
    if (!res) {
      const probes = [];
      for (const slug of slugGuesses(subject)) for (const kind of ["greenhouse", "lever", "ashby", "gem", "workable", "smartrecruiters", "recruitee"]) probes.push({ kind, slug, how: "slug guess" });
      tried.push(`${probes.length} slug probes (${slugGuesses(subject).join(", ")})`);
      const got = await Promise.all(probes.map(async (b) => ({ ...(await fetchBoard(http, b)), board: b })));
      res = got.filter((r) => r.ok && r.jobs.length).sort((a, b) => b.jobs.length - a.jobs.length)[0] || null;
    }
    if (!res) return miss("co.hiring", `no public job board found: ${tried.join("; ")}${boards.length ? `; detected ${boards.map((b) => b.kind).join(", ")} but could not read it` : ""}`);

    const { jobs, board } = res;
    const grade = board.how === "careers page" ? "v" : "p";
    const anchors = [board.how === "careers page" ? "linked-from-company-site" : "slug-guess"];
    shared.jobs = res.total ?? jobs.length;
    const byDept = {};
    const byLoc = {};
    for (const j of jobs) {
      const d = deptOf(j);
      byDept[d] = (byDept[d] || 0) + 1;
      const l = (j.location || "Unspecified").split(/[;|]/)[0].trim();
      byLoc[l] = (byLoc[l] || 0) + 1;
    }
    shared.jobsByDept = byDept;
    const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(", ");
    const jobsRow = add({ var: "co.hiring", value: `${shared.jobs} open roles on ${board.kind} (${top(byDept, 6)}); top locations: ${top(byLoc, 4)}`, url: res.url, grade, tier: "A", anchors, detail: { ats: board.kind, slug: board.slug, how: board.how, api: res.api, byDept, byLocation: byLoc } });

    if (jobsRow?.id) (shared.refs ||= {}).jobs = jobsRow.id;
    // the roles closest to the subject's seat: up to 10 that share a word with their title, else the 5 newest senior ones
    const words = titleWords(titleFor(shared, subject)?.title);
    const score = (j) => words.reduce((s, w) => s + (normName(j.title).includes(w) ? 3 : 0) + (normName(j.dept || "").includes(w) ? 2 : 0) + (normName(j.text || "").includes(w) ? 0.2 : 0), 0) + (/(director|head|vp|manager|lead)/i.test(j.title) ? 0.5 : 0);
    const ranked = [...jobs].map((j) => ({ ...j, s: score(j) })).sort((a, b) => b.s - a.s || String(b.date).localeCompare(String(a.date)));
    const near = ranked.filter((j) => j.s >= 1);
    for (const j of (near.length ? near.slice(0, 10) : ranked.slice(0, 5))) add({ var: "co.hiring", value: `${j.title}${j.location ? " · " + j.location : ""}${j.dept ? " · " + j.dept : ""}`, url: j.url || res.url, grade, tier: "A", date: j.date ? String(j.date).slice(0, 10) : null, detail: { relevance: Math.round(j.s * 10) / 10 } });

    // boards that list titles only (Paylocity, Jobvite, Workday): read the top postings' pages
    const thin = ranked.filter((j) => (j.text || "").length < 400 && j.url).slice(0, 8);
    await Promise.all(
      thin.map(async (j) => {
        const r = await http.get(j.url, { timeout: 10000 });
        if (r.ok) {
          const t = htmlText(r.text);
          const i = t.search(/\b(Description|About the (role|job|position)|Job Summary|Overview|Responsibilities)\b/i);
          j.text = t.slice(Math.max(0, i), Math.max(0, i) + 8000);
          const orig = jobs.find((x) => x.url === j.url);
          if (orig) orig.text = j.text;
        }
      }),
    );

    // reporting lines and the vocabulary of the postings
    const texts = stripBoilerplate(jobs.map((j) => `${j.title}. ${j.text || ""}`));
    const rt = reportsTo(jobs.map((j) => j.text || ""));
    if (rt.length) {
      const mineRt = rt.filter(([t]) => words.some((w) => normName(t).includes(w)));
      if (mineRt.length) add({ var: "role.directs", value: `${mineRt.reduce((s, [, n]) => s + n, 0)} open roles report to ${mineRt.map(([t]) => t).join(" / ")}`, url: res.url, grade: "i", tier: "C", detail: { reportsTo: rt } });
      // managers named in postings describe the company's org, not the subject's team: filed under hiring
      add({ var: "co.hiring", value: `Postings name these managers: ${rt.slice(0, 5).map(([t, n]) => `${t} (${n})`).join(", ")}`, url: res.url, grade: "i", tier: "C", detail: { reportsTo: rt } });
    }
    const relevant = stripBoilerplate(ranked.filter((j) => j.s >= 1).map((j) => `${j.title}. ${j.text || ""}`));
    const terms = termCounts(relevant.length >= 3 ? relevant : texts);
    const tlist = Object.entries(terms).slice(0, 10);
    if (tlist.length) {
      add({ var: "voice.priorities", value: `Postings${relevant.length >= 3 ? " in their area" : ""} stress: ${tlist.map(([t, n]) => `${t} (${n})`).join(", ")}`, url: res.url, grade: "i", tier: "C", detail: { terms, postingsRead: relevant.length >= 3 ? relevant.length : texts.length } });
      const stack = tlist.filter(([t]) => /^(Salesforce|HubSpot|Snowflake|dbt|SAP|NetSuite|Workday|ServiceNow|Kubernetes|AWS|Azure|GCP|Python|ERP|MES|Rust|LLM)$/.test(t));
      if (stack.length) add({ var: "fit.problem", value: `Tools named in postings: ${stack.map(([t, n]) => `${t} (${n})`).join(", ")}`, url: res.url, grade: "i", tier: "C" });
    }
    if (!jobs.some((j) => (j.text || "").length > 200)) miss("voice.priorities", `${board.kind} listing has titles only, no posting text to read`);
  },
};
