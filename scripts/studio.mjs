#!/usr/bin/env node
// The local studio:  npm run studio  ->  http://localhost:8877  (bound to 127.0.0.1 only)
//
// One bar at the top: the person (or several, comma-separated), their company,
// and what you want to do; below it the meeting date, any further meetings and the
// deadlines (add-row lists), saved into room.json and intake.json.
// Start composes the room exactly as new-room does,
// writes rooms/<slug>/RUN.sh with the pipeline command, and shows it.
// The pipeline is only started from here when STUDIO_RUN=1 is set; it then runs
// in the background, logging to rooms/<slug>/run.log, tailed on the page.
// Below the bar: every room in rooms/ with its status, and a local preview of
// the built site (no gate). No dependencies; the page makes no outside calls.
// The Connectors panel lists the data providers (scripts/connectors/), whether each is
// configured (env key names present; values are never sent to the page), the credit
// estimate for the chosen room, and an Enrich button that shows the estimate first and
// runs `enrich --yes` only after the user confirms it.

import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, openSync, closeSync, readSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { REPO, composeRoom, writeRunScript, inferModes, inferOrgType, slugify, availableOptions, SLUG_RE, parsePeople, PERSON_PAGES, DEADLINE_KINDS } from "./lib/compose.mjs";
import { lintRoom } from "./lib/lint.mjs";
import { ADAPTERS, BY_ID, describe, loadConfig, roomPaths, staticCtx } from "./connectors/index.mjs";
import { enrich } from "./connectors/run.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.STUDIO_PORT || 8877);
const RUN = process.env.STUDIO_RUN === "1";
const roomsDir = join(REPO, "rooms");
const siteDir = join(REPO, "site");
const skeletonDir = join(REPO, "templates", "skeleton");
const running = new Map(); // slug -> child process

const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".md": "text/plain; charset=utf-8", ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".pdf": "application/pdf" };
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function roomStatus(slug) {
  const dir = join(roomsDir, slug);
  const room = JSON.parse(readFileSync(join(dir, "room.json"), "utf8"));
  let lint = null;
  try {
    lint = lintRoom(dir, { skeletonDir, pageTemplate: readFileSync(join(REPO, "templates", "page.html"), "utf8") });
  } catch (e) {
    lint = { error: e.message };
  }
  const intakeFile = join(dir, "intake.json");
  const intake = existsSync(intakeFile) ? JSON.parse(readFileSync(intakeFile, "utf8")) : null;
  const built = join(siteDir, slug, "index.html");
  return {
    slug,
    title: room.title,
    counterparty: room.counterparty || "",
    people: (room.people || []).map((p) => p.name),
    goal: intake?.goal || room.subtitle || "",
    nextMeeting: (room.meetings || []).map((m) => m.date).filter((d) => d >= new Date().toISOString().slice(0, 10)).sort()[0] || room.meetingDate || "",
    openDeadlines: (room.deadlines || []).filter((d) => !d.done).length,
    modes: room.modes || [],
    orgType: room.orgType || "",
    tier: room.tier || "full",
    asOf: room.asOf || "",
    pages: lint?.pages ?? 0,
    skeletonPct: lint?.pages ? Math.round(100 * lint.skeletonShare) : 0,
    score: lint?.score ?? null,
    lintOk: lint?.ok ?? false,
    anthony: lint?.anthony?.length ?? 0,
    lintError: lint?.error || null,
    lastBuild: existsSync(built) ? statSync(built).mtime.toISOString() : null,
    hasRun: existsSync(join(dir, "RUN.sh")),
    hasLog: existsSync(join(dir, "run.log")),
    running: running.has(slug),
  };
}

function listRooms() {
  if (!existsSync(roomsDir)) return [];
  return readdirSync(roomsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(roomsDir, d.name, "room.json")))
    .map((d) => {
      try {
        return roomStatus(d.name);
      } catch (e) {
        return { slug: d.name, title: d.name, error: e.message };
      }
    })
    .sort((a, b) => (b.asOf || "").localeCompare(a.asOf || ""));
}

function startRun(slug) {
  if (!RUN) throw new Error("running the pipeline from the studio is off; start it with STUDIO_RUN=1 npm run studio, or run RUN.sh yourself");
  if (running.has(slug)) throw new Error(`a run for ${slug} is already going`);
  const runFile = join(roomsDir, slug, "RUN.sh");
  if (!existsSync(runFile)) throw new Error(`rooms/${slug}/RUN.sh does not exist`);
  const fd = openSync(join(roomsDir, slug, "run.log"), "a");
  const child = spawn("bash", [runFile], { cwd: REPO, detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  running.set(slug, child);
  child.on("exit", () => running.delete(slug));
  child.on("error", () => running.delete(slug));
  child.unref();
}

function tailLog(slug, from) {
  const f = join(roomsDir, slug, "run.log");
  if (!existsSync(f)) return { size: 0, text: "", running: running.has(slug) };
  const size = statSync(f).size;
  let start = Number.isFinite(from) && from >= 0 && from <= size ? from : Math.max(0, size - 64 * 1024);
  if (size - start > 256 * 1024) start = size - 256 * 1024;
  const buf = Buffer.alloc(size - start);
  const fd = openSync(f, "r");
  readSync(fd, buf, 0, buf.length, start);
  closeSync(fd);
  return { size, text: buf.toString("utf8"), running: running.has(slug) };
}

// ---------------------------------------------------------------- connectors

const connectorsConfig = () => loadConfig(join(REPO, "config", "connectors.json"));

function connectorState(slug) {
  const config = connectorsConfig();
  const paths = roomPaths(roomsDir, slug || "_none");
  const intake = slug && existsSync(paths.intake) ? JSON.parse(readFileSync(paths.intake, "utf8")) : { people: [] };
  const rows = describe(ADAPTERS.map((a) => a.id), intake, staticCtx(paths, process.env, slug), config);
  const runFile = join(paths.out, "run.json");
  let lastRun = null;
  if (slug && existsSync(runFile))
    try {
      const r = JSON.parse(readFileSync(runFile, "utf8"));
      lastRun = { ranAt: r.ranAt, creditsUsed: r.creditsUsed, conflicts: r.conflicts, providers: (r.providers || []).filter((p) => p.ran).map((p) => p.id) };
    } catch {}
  return {
    slug: slug || null,
    intakeFound: !!slug && existsSync(paths.intake),
    people: (intake.people || []).length,
    config: config.file ? (config.example ? "config/connectors.example.json (copy to config/connectors.json)" : "config/connectors.json") : "none",
    enabled: config.enabled,
    maxCredits: config.maxCredits,
    lastRun,
    // Names of env keys only; never their values.
    providers: rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, configured: r.configured, missing: r.missing, envKeys: r.envKeys, apiStatus: r.apiStatus, docsUrl: r.docsUrl, fields: r.fields, estimate: r.estimate, mcp: r.mcp || null, enabled: config.enabled.includes(r.id) })),
  };
}

async function estimateRun(slug, providers) {
  const lines = [];
  const r = await enrich({ slug, providers, roomsDir, configFile: join(REPO, "config", "connectors.json"), log: (l) => lines.push(l), fetch: () => Promise.reject(new Error("no calls during an estimate")) });
  return { total: r.total, output: lines.join("\n") };
}

function runEnrich(slug, providers) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(REPO, "scripts", "enrich.mjs"), slug, "--providers", providers.join(","), "--yes"], { cwd: REPO, timeout: 600000, env: process.env }, (err, stdout, stderr) =>
      resolve({ ok: !err, output: (stdout + stderr).trim() }),
    );
  });
}

function build() {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(REPO, "scripts", "build.mjs")], { cwd: REPO, timeout: 120000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, output: (stdout + stderr).trim() }),
    );
  });
}

// ---------------------------------------------------------------- http

const send = (res, status, body, type = "application/json") => {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": CSP,
    "x-frame-options": "DENY",
  });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
};

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw Object.assign(new Error("request too large"), { status: 413 });
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("bad JSON"), { status: 400 });
  }
}

function serveFile(res, base, rel) {
  const p = normalize(rel).replace(/^(\.\.[/\\])+/, "");
  let file = join(base, p);
  if (!file.startsWith(base)) return send(res, 404, "Not found", "text/plain");
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) return send(res, 404, "Not built yet. Press Build, or run npm run build.", "text/plain; charset=utf-8");
  send(res, 200, readFileSync(file), types[extname(file)] || "application/octet-stream");
}

const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const server = createServer(async (req, res) => {
  try {
    // Only answer requests addressed to this machine (blocks DNS rebinding).
    if (!allowedHosts.has(req.headers.host || "")) return send(res, 403, { error: "forbidden host" });
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    if (req.method === "POST") {
      // Same-origin JSON only: a page elsewhere cannot drive the studio.
      const origin = req.headers.origin;
      if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ""))) return send(res, 403, { error: "forbidden origin" });
      if (!String(req.headers["content-type"] || "").startsWith("application/json")) return send(res, 415, { error: "JSON only" });
      const body = await readJsonBody(req);

      if (path === "/api/infer") {
        const slug = slugify(body.company || "");
        return send(res, 200, {
          modes: inferModes(body.goal || ""),
          orgType: inferOrgType(body.company || "", body.goal || ""),
          slug,
          exists: !!slug && existsSync(join(roomsDir, slug)),
          people: parsePeople(body.people || ""),
        });
      }
      if (path === "/api/start") {
        const r = composeRoom({
          company: body.company,
          people: body.people,
          goal: body.goal,
          modes: Array.isArray(body.modes) ? body.modes : [],
          orgType: body.orgType || "auto",
          date: body.date || "",
          meetings: Array.isArray(body.meetings) ? body.meetings.slice(0, 30) : [],
          deadlines: Array.isArray(body.deadlines) ? body.deadlines.slice(0, 50) : [],
          tier: body.tier || undefined,
        });
        const run = writeRunScript(r.slug, r.intake);
        let started = false, runError = null;
        if (RUN) {
          try {
            startRun(r.slug);
            started = true;
          } catch (e) {
            runError = e.message;
          }
        }
        return send(res, 200, { slug: r.slug, pageCount: r.pageCount, personPages: PERSON_PAGES, intake: r.intake, warnings: r.warnings, command: run.command, runFile: `rooms/${r.slug}/RUN.sh`, promptSource: run.source, runEnabled: RUN, started, runError });
      }
      if (path === "/api/run") {
        if (!SLUG_RE.test(body.slug || "")) return send(res, 400, { error: "bad slug" });
        startRun(body.slug);
        return send(res, 200, { started: true });
      }
      if (path === "/api/build") return send(res, 200, await build());
      if (path === "/api/enrich") {
        // Two steps: {confirm:false} returns the estimate; {confirm:true, expectTotal} runs with --yes,
        // and only if the estimate the user saw is still the estimate now.
        if (!SLUG_RE.test(body.slug || "")) return send(res, 400, { error: "bad slug" });
        if (!existsSync(join(roomsDir, body.slug, "intake.json"))) return send(res, 400, { error: `rooms/${body.slug}/intake.json not found` });
        const providers = (Array.isArray(body.providers) ? body.providers : []).filter((id) => BY_ID[id]).slice(0, ADAPTERS.length);
        if (!providers.length) return send(res, 400, { error: "choose at least one provider" });
        const est = await estimateRun(body.slug, providers);
        if (body.confirm !== true) return send(res, 200, { step: "estimate", ...est, providers });
        if (Number(body.expectTotal) !== est.total) return send(res, 409, { error: `the estimate changed to ${est.total} credits; review it and confirm again`, step: "estimate", ...est, providers });
        return send(res, 200, { step: "run", ...(await runEnrich(body.slug, providers)), state: connectorState(body.slug) });
      }
      return send(res, 404, { error: "not found" });
    }

    if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
    if (path === "/") return send(res, 200, readFileSync(join(REPO, "templates", "studio.html")), types[".html"]);
    if (path === "/assets/room.css") return send(res, 200, readFileSync(join(REPO, "templates", "room.css")), types[".css"]);
    if (path === "/api/state") {
      const opts = availableOptions(skeletonDir);
      // Business modes first; "interviewing" stays available but is listed last.
      opts.modes = [...opts.modes.filter((m) => m !== "interviewing"), ...opts.modes.filter((m) => m === "interviewing")];
      return send(res, 200, { ...opts, personPages: PERSON_PAGES, deadlineKinds: DEADLINE_KINDS, runEnabled: RUN, rooms: listRooms() });
    }
    if (path === "/api/connectors") {
      const slug = url.searchParams.get("slug") || "";
      if (slug && !SLUG_RE.test(slug)) return send(res, 400, { error: "bad slug" });
      return send(res, 200, connectorState(slug));
    }
    if (path === "/api/log") {
      const slug = url.searchParams.get("slug") || "";
      if (!SLUG_RE.test(slug)) return send(res, 400, { error: "bad slug" });
      return send(res, 200, tailLog(slug, Number(url.searchParams.get("from"))));
    }
    const pv = path.match(/^\/preview\/([a-z0-9][a-z0-9-]{0,40})(\/.*)?$/);
    if (pv) {
      if (!pv[2]) return res.writeHead(301, { location: `/preview/${pv[1]}/` }).end();
      return serveFile(res, join(siteDir, pv[1]), decodeURIComponent(pv[2]));
    }
    return send(res, 404, "Not found", "text/plain");
  } catch (e) {
    return send(res, e.status || (e.code === "EEXIST" ? 409 : 400), { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`studio on http://localhost:${PORT}/  (bound to ${HOST}; pipeline runs ${RUN ? "ON (STUDIO_RUN=1)" : "off"})`);
});
