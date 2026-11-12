// Run with: npm test   (Node 23.6 or later; no dependencies)
import { test } from "node:test";
import assert from "node:assert/strict";
import { issue, verify, passwordMatches, safeEqual } from "../netlify/edge-functions/lib/session.ts";
import roomGate, { passwordVar } from "../netlify/edge-functions/room-gate.ts";

const SECRET = "test-secret-not-for-production";
const PW = "correct horse";

test("a fresh cookie verifies for its own room", async () => {
  const { value } = await issue(SECRET, "northwind", PW);
  assert.equal(await verify(SECRET, "northwind", PW, value), true);
});

test("a cookie does not open a different room", async () => {
  const { value } = await issue(SECRET, "northwind", PW);
  assert.equal(await verify(SECRET, "southwind", PW, value), false);
});

test("changing the password or the secret signs everyone out", async () => {
  const { value } = await issue(SECRET, "northwind", PW);
  assert.equal(await verify(SECRET, "northwind", "new password", value), false);
  assert.equal(await verify("rotated-secret", "northwind", PW, value), false);
});

test("an expired cookie is refused", async () => {
  const start = Date.UTC(2026, 0, 1);
  const { value } = await issue(SECRET, "northwind", PW, start, 1);
  assert.equal(await verify(SECRET, "northwind", PW, value, start + 2 * 86400_000), false);
});

test("a tampered expiry or signature is refused", async () => {
  const { value } = await issue(SECRET, "northwind", PW);
  const [r, exp, sig] = value.split(".");
  assert.equal(await verify(SECRET, "northwind", PW, `${r}.${Number(exp) + 999999}.${sig}`), false);
  assert.equal(await verify(SECRET, "northwind", PW, `${r}.${exp}.${sig.slice(0, -2)}AA`), false);
  assert.equal(await verify(SECRET, "northwind", PW, "garbage"), false);
  assert.equal(await verify(SECRET, "northwind", PW, undefined), false);
});

test("password check and constant-time compare", async () => {
  assert.equal(await passwordMatches(SECRET, PW, PW), true);
  assert.equal(await passwordMatches(SECRET, "wrong", PW), false);
  assert.equal(await passwordMatches(SECRET, "", ""), false);
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
});

test("env var name per room", () => {
  assert.equal(passwordVar("northwind"), "ROOM_PASSWORD_NORTHWIND");
  assert.equal(passwordVar("north-wind"), "ROOM_PASSWORD_NORTH_WIND");
});

// --- the edge function end to end, with a minimal stand-in for Netlify's context ---

function fakeContext(cookieHeader = "") {
  const jar = new Map<string, string>();
  for (const part of cookieHeader.split(/;\s*/).filter(Boolean)) {
    const i = part.indexOf("=");
    jar.set(part.slice(0, i), part.slice(i + 1));
  }
  const set: any[] = [];
  return {
    set,
    cookies: {
      get: (n: string) => jar.get(n),
      set: (c: any) => set.push(c),
      delete: (c: any) => set.push({ ...c, value: "", maxAge: 0 }),
    },
    next: async () => new Response("room page", { status: 200 }),
  };
}

(globalThis as any).Netlify = {
  env: { get: (k: string) => ({ ROOM_COOKIE_SECRET: SECRET, ROOM_PASSWORD_NORTHWIND: PW } as any)[k] },
};

test("unknown room is a plain 404", async () => {
  const res = await roomGate(new Request("https://x.test/elsewhere/"), fakeContext() as any);
  assert.equal(res.status, 404);
});

test("no cookie gets the password form with private headers", async () => {
  const res = await roomGate(new Request("https://x.test/northwind/people-map.html"), fakeContext() as any);
  assert.equal(res.status, 401);
  assert.match(await res.text(), /name="next" value="\/northwind\/people-map.html"/);
  assert.match(res.headers.get("cache-control")!, /no-store/);
  assert.match(res.headers.get("x-robots-tag")!, /noindex/);
});

test("right password sets a cookie and redirects inside the room only", async () => {
  const body = new URLSearchParams({ password: PW, next: "https://evil.test/" });
  const ctx = fakeContext();
  const res = await roomGate(new Request("https://x.test/northwind/__login", { method: "POST", body }), ctx as any);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/northwind/");
  assert.equal(ctx.set[0].name, "room_northwind");
  assert.equal(ctx.set[0].httpOnly, true);
  assert.equal(ctx.set[0].path, "/northwind");

  const page = await roomGate(
    new Request("https://x.test/northwind/"),
    fakeContext(`room_northwind=${ctx.set[0].value}`) as any,
  );
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "room page");
  assert.match(page.headers.get("cache-control")!, /no-store/);
});

test("wrong password re-serves the form with an error", async () => {
  const body = new URLSearchParams({ password: "nope", next: "/northwind/" });
  const res = await roomGate(new Request("https://x.test/northwind/__login", { method: "POST", body }), fakeContext() as any);
  assert.equal(res.status, 401);
  assert.match(await res.text(), /did not work/);
});
