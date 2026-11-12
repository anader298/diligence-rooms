// Companion service worker: the shell only, so the page opens fast and installs to the
// home screen. It caches assist.html and its own files (no room content in them) and
// nothing else: never room pages, never /api/*, never knowledge. Network first, the
// cached shell only when offline. Served as /<room>/assist-sw.js, so its scope is the
// room folder; every other request goes straight to the network untouched.
const CACHE = "companion-shell-v1";
const SHELL = ["assist.html", "assist/core.js", "assist/icon.svg", "assist/icon-192.png", "assist/icon-512.png", "assist-manifest.json"];
const base = new URL("./", self.location).pathname;
const isShell = (url) => url.origin === self.location.origin && SHELL.some((p) => url.pathname === base + p);

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((p) => base + p))).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || !isShell(url)) return; // not ours: the browser handles it
  e.respondWith(
    fetch(e.request).then((r) => {
      // Only a real page goes in the cache, never the gate's password form.
      if (r.ok && !r.redirected) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(base + url.pathname.slice(base.length), copy)); }
      return r;
    }).catch(() => caches.match(base + url.pathname.slice(base.length)).then((r) => r || Response.error())),
  );
});
