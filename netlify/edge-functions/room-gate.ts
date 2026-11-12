// One password gate for every room on the site.
//
// The first path segment names the room: /northwind/people-map.html belongs to
// room "northwind". A room is open to anyone holding a valid signed cookie for
// it; everyone else gets the password form. Each room has its own password,
// read from the environment:
//
//   ROOM_COOKIE_SECRET        signs every session cookie (required)
//   ROOM_PASSWORD_<SLUG>      one per room; slug upper-cased, "-" becomes "_"
//                             e.g. ROOM_PASSWORD_NORTHWIND
//
// A path whose room has no password configured returns 404, so a room that is
// built but not yet switched on stays closed, and the gate does not reveal
// which rooms exist.
//
// This keeps casual visitors and crawlers out. It is a shared password, not
// per-person accounts: anyone who has the password can read the room.

import type { Config, Context } from "@netlify/edge-functions";
import { issue, passwordMatches, verify } from "./lib/session.ts";
import { loginPage } from "./lib/login-page.ts";

const ROOM = /^[a-z0-9][a-z0-9-]{0,40}$/;

const PRIVATE_HEADERS: Record<string, string> = {
  "cache-control": "private, max-age=0, no-store",
  "x-robots-tag": "noindex, nofollow, noarchive, nosnippet",
  "referrer-policy": "no-referrer",
};

function env(name: string): string {
  return (globalThis as any).Netlify?.env?.get(name) ?? "";
}

export function passwordVar(room: string): string {
  return "ROOM_PASSWORD_" + room.toUpperCase().replace(/-/g, "_");
}

function respond(body: string | null, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { ...PRIVATE_HEADERS, ...(body ? { "content-type": "text/html; charset=utf-8" } : {}), ...extra },
  });
}

function safeNext(room: string, next: string): string {
  // Only ever redirect back inside the same room.
  return next.startsWith(`/${room}/`) && !next.startsWith("//") ? next : `/${room}/`;
}

export default async function roomGate(req: Request, context: Context): Promise<Response> {
  const url = new URL(req.url);
  const room = url.pathname.split("/")[1] ?? "";
  const secret = env("ROOM_COOKIE_SECRET");
  const password = ROOM.test(room) ? env(passwordVar(room)) : "";

  if (!secret || !password) return respond("Not found", 404, { "content-type": "text/plain; charset=utf-8" });

  const cookieName = `room_${room.replace(/-/g, "_")}`;
  const cookiePath = `/${room}`;

  if (url.pathname === `/${room}/__login` && req.method === "POST") {
    const form = await req.formData();
    const next = safeNext(room, String(form.get("next") ?? ""));
    if (await passwordMatches(secret, String(form.get("password") ?? ""), password)) {
      const { value, maxAge } = await issue(secret, room, password);
      context.cookies.set({ name: cookieName, value, path: cookiePath, maxAge, httpOnly: true, secure: true, sameSite: "Lax" });
      return respond(null, 303, { location: next });
    }
    return respond(loginPage(room, next, true), 401);
  }

  if (url.pathname === `/${room}/__logout`) {
    context.cookies.delete({ name: cookieName, path: cookiePath });
    return respond(null, 303, { location: `/${room}/` });
  }

  if (await verify(secret, room, password, context.cookies.get(cookieName))) {
    const res = await context.next();
    for (const [k, v] of Object.entries(PRIVATE_HEADERS)) res.headers.set(k, v);
    return res;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    return respond(loginPage(room, safeNext(room, url.pathname + url.search)), 401);
  }
  return respond("Unauthorized", 401, { "content-type": "text/plain; charset=utf-8" });
}

export const config: Config = {
  path: "/*",
  excludedPath: ["/", "/index.html", "/robots.txt", "/favicon.ico"],
};
