// Engine layer, usage guard, Codex stage plan and the studio's key handling.
// No real engine is called: a fake `claude` on PATH stands in where a process is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { buildCommand, envFor, setEnvVar, usageFromLine, mergeEngineConfig, defaultConfig, notReady, plainError, runEngine, CLAUDE_DENIED, CLAUDE_ALLOWED } from "../scripts/lib/engines.mjs";
import { stagePlan } from "../scripts/lib/stages.mjs";
import { REPO } from "../scripts/lib/compose.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "engines-"));

test("claude argv: headless, scoped permissions, no MCP, prompt on stdin, no key", () => {
  const { bin, args } = buildCommand("claude", { model: "opus", auth: "login", maxBudgetUsd: 20 });
  assert.equal(bin, "claude");
  assert.deepEqual(args.slice(0, 4), ["-p", "--output-format", "stream-json", "--verbose"]);
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  for (const d of CLAUDE_DENIED) assert.ok(args.includes(d), d);
  assert.ok(!args.includes("--max-budget-usd"), "budget applies to API keys only");
  const keyed = buildCommand("claude", { auth: "key", maxBudgetUsd: 20 }).args;
  assert.equal(keyed[keyed.indexOf("--max-budget-usd") + 1], "20");
});

test("codex argv: web search on, workspace sandbox with network, stdin prompt", () => {
  const { bin, args } = buildCommand("codex", { model: "gpt-6-astra", lastMessageFile: "/tmp/x.md" });
  assert.equal(bin, "codex");
  assert.ok(args.indexOf("--search") < args.indexOf("exec"), "--search is a top-level flag");
  assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
  assert.ok(args.includes("sandbox_workspace_write.network_access=true"));
  assert.equal(args.at(-1), "-");
  assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
});

test("envFor: signed-in runs drop the key; Codex key runs get CODEX_API_KEY", () => {
  const base = { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", CODEX_API_KEY: "c", PATH: "/bin" };
  assert.equal(envFor("claude", "login", base).ANTHROPIC_API_KEY, undefined);
  assert.equal(envFor("claude", "login", base).PATH, "/bin");
  const cx = envFor("codex", "login", base);
  assert.equal(cx.OPENAI_API_KEY, undefined);
  assert.equal(cx.CODEX_API_KEY, undefined);
  assert.equal(envFor("codex", "key", { OPENAI_API_KEY: "o" }).CODEX_API_KEY, "o");
  assert.equal(envFor("claude", "key", base).ANTHROPIC_API_KEY, "a");
});

test(".env writer keeps other lines, sets 0600, rejects injection, removes cleanly", () => {
  const d = tmp();
  try {
    const f = join(d, ".env");
    writeFileSync(f, "ROOM_COOKIE_SECRET=abc\n# note\nANTHROPIC_API_KEY=old\n");
    setEnvVar(f, "ANTHROPIC_API_KEY", "sk-ant-api03-new_KEY-123");
    assert.equal(readFileSync(f, "utf8"), "ROOM_COOKIE_SECRET=abc\n# note\nANTHROPIC_API_KEY=sk-ant-api03-new_KEY-123\n");
    assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.throws(() => setEnvVar(f, "ANTHROPIC_API_KEY", "sk-abc\nROOM_PASSWORD_X=1"));
    assert.throws(() => setEnvVar(f, "ANTHROPIC_API_KEY", "sk abc def ghi"));
    assert.throws(() => setEnvVar(f, "bad name", "sk-abcdefgh"));
    setEnvVar(f, "ANTHROPIC_API_KEY", null);
    assert.equal(readFileSync(f, "utf8"), "ROOM_COOKIE_SECRET=abc\n# note\n");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("usage: highest window from Claude events and Codex session logs", () => {
  const claude = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.31 }, seven_day: { utilization: 0.66 } } } });
  assert.deepEqual(usageFromLine(claude), { pct: 66, window: "seven_day" });
  const codex = JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 12, window_minutes: 300 }, secondary: { used_percent: 27, window_minutes: 10080 } } } });
  assert.deepEqual(usageFromLine(codex), { pct: 27, window: "168h" });
  assert.equal(usageFromLine("[run] hello"), null);
  assert.equal(usageFromLine('{"type":"assistant"}'), null);
});

test("config: validated; settings changes clear the last test; readiness reasons", () => {
  let c = mergeEngineConfig(defaultConfig(), { engine: "claude", auth: "login", model: "opus", usageLimit: 65 });
  assert.throws(() => mergeEngineConfig(c, { engine: "gpt" }));
  assert.throws(() => mergeEngineConfig(c, { usageLimit: 0 }));
  assert.throws(() => mergeEngineConfig(c, { model: "opus; rm -rf /" }));
  assert.match(notReady(defaultConfig(), {}), /connect an AI engine/);
  assert.match(notReady(c, {}), /press Test/);
  c = { ...c, test: { ok: true, engine: "claude", auth: "login", model: "opus", usagePct: 40 } };
  assert.equal(notReady(c, {}), null);
  assert.match(notReady({ ...c, test: { ...c.test, usagePct: 70 } }, {}), /above your 65% limit/);
  assert.equal(mergeEngineConfig(c, { model: "sonnet" }).test, null);
  assert.match(notReady({ ...c, auth: "key" }, {}), /no ANTHROPIC_API_KEY/);
});

test("plainError unwraps nested API errors and adds the model fix", () => {
  const e = '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'x\' model is not supported when using Codex with a ChatGPT account.","code":"model_not_found"}}';
  assert.match(plainError(e, "codex"), /^The 'x' model is not supported.*Clear the Model box/);
});

test("usage guard stops a run that goes above the limit", async () => {
  const d = tmp();
  try {
    // A fake claude: reports 70% plan usage, then would run for 30 seconds.
    const fake = join(d, "claude");
    writeFileSync(fake, `#!/usr/bin/env node
process.stdin.resume();
console.log(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { seven_day: { utilization: 0.7 } } } }));
setTimeout(() => console.log(JSON.stringify({ type: "result", is_error: false })), 30000);
`);
    chmodSync(fake, 0o755);
    const lines = [];
    const t = Date.now();
    const r = await runEngine({ engineId: "claude", cfg: { engine: "claude", auth: "login", model: "", usageLimit: 65 }, prompt: "x", cwd: d, env: { ...process.env, PATH: `${d}:${process.env.PATH}` }, log: (l) => lines.push(l) });
    assert.equal(r.stoppedForUsage, true);
    assert.equal(r.usage.pct, 70);
    assert.ok(Date.now() - t < 15000, "stopped well before the fake finished");
    assert.ok(lines.some((l) => l.startsWith("[usage-guard]")));
    // API-key runs are not plan-limited: the same events do not stop them.
    const fakeShort = join(d, "claude");
    writeFileSync(fakeShort, `#!/usr/bin/env node
process.stdin.resume();
console.log(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { seven_day: { utilization: 0.7 } } } }));
console.log(JSON.stringify({ type: "result", is_error: false }));
process.exit(0);
`);
    const k = await runEngine({ engineId: "claude", cfg: { engine: "claude", auth: "key", usageLimit: 65 }, prompt: "x", cwd: d, env: { ...process.env, PATH: `${d}:${process.env.PATH}` } });
    assert.equal(k.stoppedForUsage, false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("stage plan (both engines): fixed order, AI slots after verification; per-person cold stages carry no trace of our side", () => {
  const md = readFileSync(join(REPO, "pipeline", "PROMPTS.md"), "utf8");
  const intake = { company: "Acme Freight", people: [{ name: "Jane Doe", slug: "jane-doe" }, { name: "Raj Rao", slug: "raj-rao" }], goal: "pitch a contract", modes: ["pitch"], orgType: "other", meetingDate: "2026-12-01", tier: "light", meetings: [], deadlines: [] };
  const ours = { name: "Zed Ourname", organisation: "Ourco Unique", factsFile: "config/facts.md" };
  const waves = stagePlan(md, intake, "acme-freight", ours);
  const names = waves.map((w) => w.wave);
  assert.deepEqual(names, ["inventory", "harvest", "research", "people-osint", "personas", "mirror", "synthesis", "verification", "corrections", "ai-slots", "render", "one-card"]);
  const slots = waves.find((w) => w.wave === "ai-slots").stages;
  assert.deepEqual(slots.map((s) => s.id), ["P8a jane-doe", "P8a raj-rao", "P8a company"]);
  assert.ok(slots[0].cold && !slots[2].cold, "person slots are cold; the company slot may read our side");
  assert.match(slots[0].prompt, /--cites/);
  const osint = waves.find((w) => w.wave === "people-osint").stages;
  assert.deepEqual(osint.map((s) => s.id), ["P4a jane-doe", "P4a raj-rao"]);
  assert.match(osint[0].prompt, /This stage covers one person only: Jane Doe/);
  assert.match(osint[0].prompt, /npm run entry -- acme-freight --list --person jane-doe/, "agents hand in entries, by bucket");
  assert.doesNotMatch(osint[0].prompt, /Raj Rao.*\(page suffix/);
  const cold = waves.flatMap((w) => w.stages).filter((s) => s.cold);
  assert.ok(cold.length >= 7, "P4a x2, P4b x2, P5e, P8a x2");
  for (const s of cold) {
    assert.doesNotMatch(s.prompt, /Zed Ourname|Ourco Unique/, s.id);
    assert.match(s.prompt, /must not read config\/our-side\.json/, s.id);
  }
  const p1 = waves[0].stages[0];
  assert.match(p1.prompt, /never ask a question/);
  assert.match(p1.prompt, /Do not run npm run enrich/);
  assert.ok(waves.find((w) => w.wave === "verification").stages.length >= 4);
});

test("stage header: says what each engine really blocks, and that the rest is an instruction", () => {
  const md = readFileSync(join(REPO, "pipeline", "PROMPTS.md"), "utf8");
  const intake = { company: "Acme Freight", people: [{ name: "Jane Doe", slug: "jane-doe" }], goal: "pitch", modes: ["pitch"], orgType: "other", meetingDate: "2026-12-01", tier: "light", meetings: [], deadlines: [] };
  const p = stagePlan(md, intake, "acme-freight", {})[0].stages[0].prompt;
  assert.doesNotMatch(p, /deleting is blocked/i, "deleting is not blocked: node, python3 and curl can delete");
  // the deny list as the Claude argv really passes it
  for (const d of CLAUDE_DENIED) assert.ok(p.includes(d.replace(/^Bash\((.*?):\*\)$/, "$1")), d);
  for (const tool of ["node", "python3", "curl"]) assert.ok(CLAUDE_ALLOWED.includes(`Bash(${tool}:*)`), `${tool} is allowed, as the header says`);
  assert.match(p, /node, python3 and curl are allowed and can still delete or overwrite files/);
  // Codex: the sandbox flag in its argv, and what it does and does not stop
  const codex = buildCommand("codex", {}).args;
  assert.equal(codex[codex.indexOf("--sandbox") + 1], "workspace-write");
  assert.match(p, /Under Codex, the run is in a workspace-write sandbox: it can write only inside this repository/);
  assert.match(p, /instruction you keep, not a lock/);
  assert.match(p, /Every other rule here is an instruction too/);
});

test("studio never sends a key to the page and refuses other hosts", async () => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const secret = "sk-ant-api03-SECRETVALUEzz9876";
  const child = spawn(process.execPath, [join(REPO, "scripts", "studio.mjs")], { cwd: REPO, env: { ...process.env, STUDIO_PORT: String(port), ANTHROPIC_API_KEY: secret }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((res, rej) => {
      child.stdout.on("data", (d) => String(d).includes("studio on") && res());
      child.on("exit", () => rej(new Error("studio exited")));
      setTimeout(() => rej(new Error("studio did not start")), 10000);
    });
    const base = `http://127.0.0.1:${port}`;
    for (const p of ["/api/engine", "/api/state", "/api/doctor"]) {
      const text = await (await fetch(base + p)).text();
      assert.ok(!text.includes("SECRETVALUE"), `${p} leaks the key`);
    }
    const eng = await (await fetch(base + "/api/engine")).json();
    assert.equal(eng.engines.find((e) => e.id === "claude").keyMask, "…9876");
    const bad = await fetch(base + "/api/engine", { method: "POST", headers: { "content-type": "application/json", origin: "http://evil.example" }, body: "{}" });
    assert.equal(bad.status, 403);
    const notJson = await fetch(base + "/api/engine/key", { method: "POST", body: "engine=claude" });
    assert.equal(notJson.status, 415);
  } finally {
    child.kill();
  }
});

test("progress: pages drive the bar, Codex waves name the stage, a clean finish is 100", async () => {
  const { roomProgress } = await import("../scripts/lib/progress.mjs");
  const { mkdirSync } = await import("node:fs");
  const d = tmp();
  try {
    mkdirSync(join(d, "work"));
    writeFileSync(join(d, "room.json"), JSON.stringify({ slug: "x", summary: "" }));
    writeFileSync(join(d, "run.log"), "[run 10:00:00] == wave: research (P3a, P3b)\n");
    const lint = { pages: 40, skeleton: new Array(20).fill("p") };
    let g = roomProgress(d, lint, null, { running: true });
    assert.equal(g.pagesDone, 20);
    assert.equal(g.label, "Stage 3 of 12: Company research");
    assert.equal(g.pct, 43);
    writeFileSync(join(d, "work", "ACCURACY REVIEW.md"), "x");
    g = roomProgress(d, { pages: 40, skeleton: [] }, "", { running: true });
    assert.equal(g.pct, 88);
    assert.equal(g.label, "Checking the facts");
    writeFileSync(join(d, "work", "last-run.json"), JSON.stringify({ code: 0, endedAt: new Date(Date.now() + 1000).toISOString() }));
    g = roomProgress(d, lint, "", { running: false });
    assert.equal(g.pct, 100);
    assert.equal(g.done, true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
