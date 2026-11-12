// Signed room session cookies.
//
// Cookie value: "<room>.<expires>.<signature>"
//   room       the room slug, e.g. "northwind"
//   expires    unix seconds
//   signature  base64url HMAC-SHA256 over "v1|<room>|<expires>|<password>"
//              keyed with ROOM_COOKIE_SECRET
//
// The password is part of the signed message but never part of the cookie, so
// changing a room's password signs everyone out of that room, and changing
// ROOM_COOKIE_SECRET signs everyone out of every room.
//
// Uses only Web Crypto, so the same file runs on Netlify's Deno edge runtime
// and in Node 23.6+ (tests and the local server).

const enc = new TextEncoder();

export const SESSION_DAYS = 30;

function b64url(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

// Compare two strings without returning early on the first difference.
export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// Check a typed password against the configured one. Both sides are hashed
// first so the comparison takes the same time whatever their lengths.
export async function passwordMatches(secret: string, typed: string, expected: string): Promise<boolean> {
  if (!expected) return false;
  const [a, b] = await Promise.all([hmac(secret, "pw|" + typed), hmac(secret, "pw|" + expected)]);
  return safeEqual(a, b);
}

export async function issue(
  secret: string,
  room: string,
  password: string,
  now = Date.now(),
  days = SESSION_DAYS,
): Promise<{ value: string; maxAge: number }> {
  const maxAge = days * 24 * 60 * 60;
  const expires = Math.floor(now / 1000) + maxAge;
  const sig = await hmac(secret, `v1|${room}|${expires}|${password}`);
  return { value: `${room}.${expires}.${sig}`, maxAge };
}

export async function verify(
  secret: string,
  room: string,
  password: string,
  value: string | undefined,
  now = Date.now(),
): Promise<boolean> {
  if (!value || !secret || !password) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [r, exp, sig] = parts;
  if (r !== room) return false;
  const expires = Number(exp);
  if (!Number.isInteger(expires) || expires * 1000 <= now) return false;
  const expected = await hmac(secret, `v1|${room}|${expires}|${password}`);
  return safeEqual(sig, expected);
}
