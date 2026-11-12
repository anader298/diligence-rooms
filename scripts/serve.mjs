#!/usr/bin/env node
// Local server for the built site that runs the real gate.
//
//   node --env-file=.env scripts/serve.mjs            gate on, like production
//   node scripts/serve.mjs --no-gate                  preview pages without a password
//
// Requests are passed through netlify/edge-functions/room-gate.ts with a small
// stand-in for Netlify's edge context, so the password form, the signed cookie
// and the redirects behave as they do when deployed. Node 23.6+ (runs .ts).

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import roomGate, { config } from "../netlify/edge-functions/room-gate.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "site");
const port = Number(process.env.PORT || 8888);
const gate = !process.argv.includes("--no-gate");
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".txt": "text/plain", ".json": "application/json", ".pdf": "application/pdf" };

globalThis.Netlify = { env: { get: (k) => process.env[k] } };

async function staticFile(pathname) {
  let p = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(root, p);
  if (!file.startsWith(root)) return new Response("Not found", { status: 404 });
  try {
    const s = await stat(file);
    if (s.isDirectory()) {
      if (!pathname.endsWith("/")) return new Response(null, { status: 301, headers: { location: pathname + "/" } });
      file = join(file, "index.html");
    }
    return new Response(await readFile(file), { headers: { "content-type": types[extname(file)] || "application/octet-stream" } });
  } catch {
    return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
  }
}

function context(req) {
  const jar = Object.fromEntries((req.headers.get("cookie") || "").split(/;\s*/).filter(Boolean).map((c) => [c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1)]));
  const out = [];
  return {
    out,
    cookies: {
      get: (n) => jar[n],
      set: (c) => out.push(`${c.name}=${c.value}; Path=${c.path}; Max-Age=${c.maxAge}; HttpOnly; SameSite=${c.sameSite}${c.secure ? "; Secure" : ""}`),
      delete: (c) => out.push(`${c.name}=; Path=${c.path}; Max-Age=0`),
    },
    next: () => staticFile(new URL(req.url).pathname),
  };
}

createServer(async (nreq, nres) => {
  const chunks = [];
  for await (const c of nreq) chunks.push(c);
  const url = `http://localhost:${port}${nreq.url}`;
  const req = new Request(url, { method: nreq.method, headers: nreq.headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
  const { pathname } = new URL(url);
  const excluded = config.excludedPath.includes(pathname);

  let res, ctx = context(req);
  if (gate && !excluded) res = await roomGate(req, ctx);
  else res = await staticFile(pathname);

  const headers = Object.fromEntries(res.headers);
  if (ctx.out.length) headers["set-cookie"] = ctx.out;
  nres.writeHead(res.status, headers);
  nres.end(Buffer.from(await res.arrayBuffer()));
  console.log(res.status, nreq.method, pathname);
}).listen(port, () => {
  console.log(`serving site/ on http://localhost:${port}/  (gate ${gate ? "on" : "off"})`);
  if (gate && !process.env.ROOM_COOKIE_SECRET) console.log("ROOM_COOKIE_SECRET is not set: every room will 404. Copy .env.example to .env.");
});
