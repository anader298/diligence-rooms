// The password form the gate serves in place of a room page.

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function loginPage(room: string, next: string, error = false): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>Diligence room</title>
<style>
:root{--bg:#faf7ff;--card:#fff;--line:#e6e1f0;--ink:#1c1e33;--mut:#5d6076;--acc:#8b2fd6;--navy:#10122b;--bad:#b42318}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
form{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px 24px 24px;box-shadow:0 1px 2px rgba(16,18,43,.04),0 8px 24px rgba(16,18,43,.05)}
.band{height:6px;width:56px;border-radius:999px;background:var(--acc);margin:0 auto 20px}
h1{margin:0 0 4px;text-align:center;font-size:22px;font-weight:600;color:var(--navy)}
.sub{margin:0 0 24px;text-align:center;color:var(--mut);font-size:13px}
label{display:block;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);margin-bottom:6px}
.row{position:relative}
input{width:100%;font:inherit;font-size:17px;padding:13px 64px 13px 14px;border:1px solid var(--line);border-radius:12px;background:#fff;color:var(--ink)}
input:focus{outline:2px solid var(--acc);outline-offset:1px}
.show{position:absolute;right:6px;top:6px;bottom:6px;border:0;background:none;color:var(--mut);font:inherit;font-size:12px;font-weight:700;cursor:pointer;padding:0 10px}
.go{width:100%;margin-top:14px;border:0;border-radius:999px;background:var(--acc);color:#fff;font:inherit;font-size:16px;font-weight:700;padding:14px;cursor:pointer}
.err{margin:12px 0 0;text-align:center;color:var(--bad);font-size:13px}
</style></head><body>
<form method="post" action="/${esc(room)}/__login">
<div class="band"></div>
<h1>Diligence room</h1>
<p class="sub">Enter the password you were given.</p>
<input type="hidden" name="next" value="${esc(next)}">
<label for="pw">Password</label>
<div class="row"><input id="pw" name="password" type="password" autocomplete="current-password" autocapitalize="off" autocorrect="off" autofocus required>
<button class="show" type="button" aria-controls="pw" onclick="var p=document.getElementById('pw'),h=p.type==='password';p.type=h?'text':'password';this.textContent=h?'Hide':'Show';p.focus()">Show</button></div>
<button class="go" type="submit">Enter</button>
${error ? '<p class="err" role="alert">That password did not work. Try again.</p>' : ""}
</form></body></html>`;
}
