// The AI engines that do a room's research: Claude Code or Codex, run on the user's own
// machine with the user's own account (signed-in plan) or API key.
//
// Used by the studio (Connect AI panel), scripts/run-room.mjs (the run itself) and
// scripts/doctor.mjs (the setup check). Nothing here sends a key anywhere: keys live in .env,
// are passed to the engine's own CLI through its environment, and never appear in argv, logs
// or anything the studio page receives.
//
// The usage guard: on a signed-in plan, each engine reports how much of the plan's usage window
// is used (Claude in its event stream, Codex in its session log). A run stops itself once any
// window goes above the limit in config/engine.json (default 65%).

import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, chmodSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_USAGE_LIMIT = 65;

export const ENGINES = {
  claude: {
    id: "claude",
    name: "Claude Code",
    bin: "claude",
    keyVar: "ANTHROPIC_API_KEY",
    keyVars: ["ANTHROPIC_API_KEY"],
    keyHint: "sk-ant-…",
    defaultModel: "opus",
    install: "npm install -g @anthropic-ai/claude-code",
    login: "In a terminal, run: claude   then type /login",
  },
  codex: {
    id: "codex",
    name: "Codex",
    bin: "codex",
    keyVar: "OPENAI_API_KEY",
    keyVars: ["OPENAI_API_KEY", "CODEX_API_KEY"],
    keyHint: "sk-…",
    defaultModel: "",
    install: "npm install -g @openai/codex",
    login: "In a terminal, run: codex login",
  },
};

// What a Claude research run may do without asking. Web research, reading and writing files in
// the repo, subagents, and the shell commands the harvest stage uses. The deny list refuses rm,
// git commit, push and reset, netlify and sudo, but node, python3 and curl stay allowed, so a run
// can still delete or overwrite files through them: "never delete" is an instruction, not a lock.
export const CLAUDE_ALLOWED = [
  "WebSearch", "WebFetch", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "Agent", "Task", "TodoWrite",
  "Bash(curl:*)", "Bash(node:*)", "Bash(npm run:*)", "Bash(python3:*)", "Bash(yt-dlp:*)", "Bash(mkdir:*)",
  "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(grep:*)", "Bash(jq:*)", "Bash(sort:*)",
];
export const CLAUDE_DENIED_BASH = ["Bash(rm:*)", "Bash(git push:*)", "Bash(git commit:*)", "Bash(git reset:*)", "Bash(netlify:*)", "Bash(npx netlify:*)", "Bash(sudo:*)"];
// The ledgers are written only by code (the scripted pass, npm run entry). Claude Code's Edit
// rules cover every built-in tool that edits files (Edit, Write, MultiEdit, NotebookEdit; a
// Write(...) rule would not match, per the permissions docs) and shell redirects or tee into
// those paths. "/" anchors at the run's working directory, the repository root (run-room.mjs).
// A node or python script that opens the file itself is not covered; npm run entry is such a
// script, which is how entries still get in.
export const CLAUDE_DENIED_PATHS = ["Edit(/rooms/*/work/osint/**)"];
export const CLAUDE_DENIED = [...CLAUDE_DENIED_BASH, ...CLAUDE_DENIED_PATHS];

/**
 * What is actually blocked in an unattended run, per engine, for the prompts (stages.mjs and the
 * single-run brief in compose.mjs). Built from CLAUDE_DENIED and the Codex sandbox flags in
 * buildCommand, so it says what the code does.
 */
export function guardText() {
  const denied = CLAUDE_DENIED_BASH.map((d) => d.replace(/^Bash\((.*?)(?::\*)?\)$/, "$1"));
  return [
    "Never delete files: overwrite them instead. That is an instruction you keep, not a lock.",
    `What is actually blocked: under Claude Code, these shell commands are refused: ${denied.join(", ")}. node, python3 and curl are allowed and can still delete or overwrite files, so do not use them to delete.`,
    `Under Claude Code, direct edits to the ledgers are refused too (${CLAUDE_DENIED_PATHS.join(", ")}): hand facts in with npm run entry, which grades them.`,
    "Under Codex, the run is in a workspace-write sandbox: it can write only inside this repository (and the temp folder), and nothing inside the repository is blocked. Codex has no rule that can refuse edits to the ledgers, so on Codex \"never edit ledger.jsonl or osint.json by hand\" is an instruction only; the form regrades every row when it reads it either way.",
    "Every other rule here is an instruction too, not something the engine enforces.",
  ].join("\n");
}

// ---------------------------------------------------------------- config

const MODEL_RE = /^[A-Za-z0-9._:\-\[\]]{0,64}$/;

export function defaultConfig() {
  return { engine: null, auth: "login", model: "", usageLimit: DEFAULT_USAGE_LIMIT, maxBudgetUsd: null, test: null };
}

export function loadEngineConfig(file) {
  const base = defaultConfig();
  if (!existsSync(file)) return base;
  try {
    return { ...base, ...JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    return base;
  }
}

/** Validate and merge a change into the config. Throws on bad input. */
export function mergeEngineConfig(current, change = {}) {
  const next = { ...defaultConfig(), ...current };
  if ("engine" in change) {
    if (!ENGINES[change.engine]) throw new Error("engine must be claude or codex");
    if (change.engine !== next.engine) next.test = null;
    next.engine = change.engine;
  }
  if ("auth" in change) {
    if (!["login", "key"].includes(change.auth)) throw new Error("auth must be login or key");
    if (change.auth !== next.auth) next.test = null;
    next.auth = change.auth;
  }
  if ("model" in change) {
    const m = String(change.model ?? "").trim();
    if (!MODEL_RE.test(m)) throw new Error("model name: letters, digits, dots, dashes only");
    if (m !== next.model) next.test = null;
    next.model = m;
  }
  if ("usageLimit" in change) {
    const n = Number(change.usageLimit);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error("usage limit must be a whole number from 1 to 100");
    next.usageLimit = n;
  }
  if ("maxBudgetUsd" in change) {
    if (change.maxBudgetUsd === null || change.maxBudgetUsd === "") next.maxBudgetUsd = null;
    else {
      const n = Number(change.maxBudgetUsd);
      if (!Number.isFinite(n) || n <= 0 || n > 10000) throw new Error("max spend must be a dollar amount above 0");
      next.maxBudgetUsd = n;
    }
  }
  return next;
}

export function saveEngineConfig(file, cfg) {
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
}

export const modelFor = (cfg) => cfg.model || ENGINES[cfg.engine]?.defaultModel || "";

// ---------------------------------------------------------------- .env

const KEY_VALUE_RE = /^[A-Za-z0-9_\-.]{8,400}$/;

/** Set or remove (value null) one variable in a .env file, keeping every other line. Mode 0600. */
export function setEnvVar(file, name, value) {
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) throw new Error("bad variable name");
  if (value !== null && !KEY_VALUE_RE.test(String(value))) throw new Error("that does not look like an API key (letters, digits, - _ . only, no spaces)");
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  const re = new RegExp(`^\\s*(export\\s+)?${name}\\s*=`);
  const kept = lines.filter((l) => !re.test(l));
  while (kept.length && kept[kept.length - 1] === "") kept.pop();
  if (value !== null) kept.push(`${name}=${value}`);
  writeFileSync(file, kept.length ? kept.join("\n") + "\n" : "");
  chmodSync(file, 0o600);
}

/** Last four characters only, for display. */
export const maskKey = (v) => (v ? "…" + String(v).slice(-4) : null);

// ---------------------------------------------------------------- detection

function run(bin, args, { env, timeout = 15000, cwd } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { env, timeout, cwd, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, code: err?.code ?? 0, missing: err?.code === "ENOENT", stdout: String(stdout || ""), stderr: String(stderr || "") }),
    );
  });
}

/** Installed? Signed in? Key set? Flags only, never key values. */
export async function detect(env = process.env) {
  const out = {};
  for (const e of Object.values(ENGINES)) {
    const v = await run(e.bin, ["--version"], { env });
    const row = { id: e.id, name: e.name, installed: v.ok, version: v.ok ? v.stdout.trim().split("\n")[0] : null, loggedIn: false, loginMethod: null, keySet: e.keyVars.some((k) => !!env[k]), keyMask: maskKey(e.keyVars.map((k) => env[k]).find(Boolean)), install: e.install, login: e.login, keyVar: e.keyVar, defaultModel: e.defaultModel };
    if (v.ok && e.id === "claude") {
      const s = await run("claude", ["auth", "status"], { env: envFor("claude", "login", env) });
      try {
        const j = JSON.parse(s.stdout);
        row.loggedIn = !!j.loggedIn;
        row.loginMethod = j.authMethod || null;
      } catch {}
    }
    if (v.ok && e.id === "codex") {
      const s = await run("codex", ["login", "status"], { env: envFor("codex", "login", env) });
      const text = (s.stdout + s.stderr).trim();
      row.loggedIn = s.ok && /logged in/i.test(text) && !/not logged in/i.test(text);
      row.loginMethod = row.loggedIn ? text.replace(/^logged in (using|with)\s*/i, "") || "signed in" : null;
    }
    out[e.id] = row;
  }
  return out;
}

// ---------------------------------------------------------------- env and argv

/** The environment for an engine run. "login" strips the key so the signed-in plan is used. */
export function envFor(engineId, auth, base = process.env) {
  const env = { ...base };
  const e = ENGINES[engineId];
  if (!e) return env;
  if (auth === "login") for (const k of e.keyVars) delete env[k];
  if (auth === "key" && engineId === "codex" && env.OPENAI_API_KEY && !env.CODEX_API_KEY) env.CODEX_API_KEY = env.OPENAI_API_KEY;
  return env;
}

/**
 * argv for one unattended engine call. The prompt is always sent on stdin.
 * opts: { model, maxBudgetUsd, auth, lastMessageFile, test }
 */
export function buildCommand(engineId, opts = {}) {
  const model = opts.model || ENGINES[engineId]?.defaultModel || "";
  if (engineId === "claude") {
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (model) args.push("--model", model);
    if (opts.test) args.push("--max-turns", "1");
    // --strict-mcp-config with no --mcp-config: the user's own MCP servers stay out of the run.
    else args.push("--strict-mcp-config", "--permission-mode", "acceptEdits", "--allowedTools", ...CLAUDE_ALLOWED, "--disallowedTools", ...CLAUDE_DENIED);
    if (opts.auth === "key" && opts.maxBudgetUsd) args.push("--max-budget-usd", String(opts.maxBudgetUsd));
    return { bin: "claude", args };
  }
  if (engineId === "codex") {
    const args = opts.test ? [] : ["--search"];
    args.push("exec", "--json", "--skip-git-repo-check");
    if (!opts.test) args.push("--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=true");
    if (model) args.push("-m", model);
    if (opts.lastMessageFile) args.push("-o", opts.lastMessageFile);
    args.push("-");
    return { bin: "codex", args };
  }
  throw new Error(`unknown engine ${engineId}`);
}

// ---------------------------------------------------------------- usage

/** Highest plan-usage percentage in one event line (Claude stream or Codex session log), or null. */
export function usageFromLine(line) {
  if (!line || line[0] !== "{") return null;
  let j;
  try {
    j = JSON.parse(line);
  } catch {
    return null;
  }
  // Claude: {"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":{"five_hour":{"utilization":0.42}}}}
  if (j.type === "rate_limit_event" && j.rate_limit_info) {
    const info = j.rate_limit_info;
    const vals = [];
    for (const [name, w] of Object.entries(info.unifiedWindows || {})) if (typeof w?.utilization === "number") vals.push({ pct: w.utilization * 100, window: name });
    if (typeof info.utilization === "number") vals.push({ pct: info.utilization * 100, window: info.rateLimitType || "plan" });
    if (!vals.length) return null;
    return vals.reduce((a, b) => (b.pct > a.pct ? b : a));
  }
  // Codex session log: {"payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":3},"secondary":{"used_percent":27}}}}
  const rl = j.payload?.rate_limits || j.rate_limits || j.msg?.rate_limits;
  if (rl) {
    const vals = [];
    for (const [name, w] of Object.entries({ primary: rl.primary, secondary: rl.secondary })) {
      if (typeof w?.used_percent === "number") vals.push({ pct: w.used_percent, window: w.window_minutes ? `${Math.round(w.window_minutes / 60)}h` : name });
    }
    if (!vals.length) return null;
    return vals.reduce((a, b) => (b.pct > a.pct ? b : a));
  }
  return null;
}

/** Codex writes its session log at $CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<thread>.jsonl. */
export function findCodexSession(threadId, env = process.env) {
  const root = join(env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
  if (!threadId || !existsSync(root)) return null;
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    // newest folders first
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const d of entries) {
      const p = join(dir, d.name);
      if (d.isFile() && d.name.includes(threadId) && d.name.endsWith(".jsonl")) return p;
      if (d.isDirectory() && depth < 3) {
        const hit = walk(p, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(root, 0);
}

/** Read lines appended to a file since `pos`. Returns { lines, pos }. */
function readNew(file, pos) {
  const size = statSync(file).size;
  if (size <= pos) return { lines: [], pos };
  const buf = Buffer.alloc(size - pos);
  const fd = openSync(file, "r");
  readSync(fd, buf, 0, buf.length, pos);
  closeSync(fd);
  const text = buf.toString("utf8");
  const cut = text.lastIndexOf("\n");
  if (cut < 0) return { lines: [], pos };
  return { lines: text.slice(0, cut).split("\n"), pos: pos + Buffer.byteLength(text.slice(0, cut + 1)) };
}

// ---------------------------------------------------------------- running

/**
 * Run one unattended engine call. Streams every output line to log(line).
 * Stops the call when plan usage goes above usageLimit (signed-in plans only).
 * Resolves { code, usage, stoppedForUsage, error, text }.
 */
export function runEngine({ engineId, cfg, prompt, cwd, env = process.env, log = () => {}, lastMessageFile, test = false, usageState = { pct: null, window: null }, timeoutMs = 0 }) {
  const { bin, args } = buildCommand(engineId, { model: modelFor(cfg), maxBudgetUsd: cfg.maxBudgetUsd, auth: cfg.auth, lastMessageFile, test });
  const limit = cfg.usageLimit || DEFAULT_USAGE_LIMIT;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, env: envFor(engineId, cfg.auth, env), stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ code: 1, error: e.message, usage: usageState, stoppedForUsage: false, text: "" });
    }
    let stoppedForUsage = false, error = null, text = "", buf = "", errBuf = "", sessionTimer = null, sessionFile = null, sessionPos = 0, killTimer = null;

    const noteUsage = (u) => {
      if (!u) return;
      usageState.pct = Math.round(u.pct * 10) / 10;
      usageState.window = u.window;
      if (cfg.auth === "login" && u.pct > limit && !stoppedForUsage) {
        stoppedForUsage = true;
        log(`[usage-guard] plan usage at ${usageState.pct}% (${u.window}), above the ${limit}% limit: stopping this run.`);
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 10000);
      }
    };
    const onLine = (line) => {
      if (!line) return;
      log(line);
      noteUsage(usageFromLine(line));
      if (line[0] !== "{") return;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        return;
      }
      if (engineId === "claude") {
        if (j.type === "assistant") for (const c of j.message?.content || []) if (c.type === "text") text += c.text;
        if (j.type === "result" && j.is_error) error = j.result || j.subtype || "the run reported an error";
      } else {
        if (j.type === "thread.started" && j.thread_id) {
          // Codex keeps rate limits in its session log, not in --json output: watch that file.
          const tid = j.thread_id;
          sessionTimer = setInterval(() => {
            try {
              sessionFile ||= findCodexSession(tid, env);
              if (!sessionFile) return;
              const r = readNew(sessionFile, sessionPos);
              sessionPos = r.pos;
              for (const l of r.lines) noteUsage(usageFromLine(l));
            } catch {}
          }, test ? 500 : 5000);
        }
        if (j.type === "item.completed" && j.item?.type === "agent_message") text += j.item.text || "";
        if (j.type === "error") error = j.message;
        if (j.type === "turn.failed") error = j.error?.message || "the run failed";
      }
    };
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on("data", (d) => {
      errBuf = (errBuf + d).slice(-4000);
    });
    const timer = timeoutMs ? setTimeout(() => { error ||= `no answer within ${Math.round(timeoutMs / 1000)}s`; child.kill("SIGTERM"); }, timeoutMs) : null;
    child.on("error", (e) => {
      error = e.code === "ENOENT" ? `${bin} is not installed (${ENGINES[engineId].install})` : e.message;
    });
    child.on("close", async (code) => {
      if (buf) onLine(buf);
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (sessionTimer) {
        // one last read so the test call reports usage
        await new Promise((r) => setTimeout(r, test ? 800 : 0));
        try {
          sessionFile ||= findCodexSession(null, env);
          if (sessionFile) for (const l of readNew(sessionFile, sessionPos).lines) noteUsage(usageFromLine(l));
        } catch {}
        clearInterval(sessionTimer);
      }
      if (!error && code !== 0 && !stoppedForUsage) error = errBuf.trim().split("\n").slice(-3).join(" ") || `exited with code ${code}`;
      error = plainError(error, engineId);
      resolve({ code: code ?? 1, usage: usageState, stoppedForUsage, error, text });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

/** Engines nest the API's JSON error inside a string; show the sentence, plus the fix we know. */
export function plainError(error, engineId) {
  if (!error) return error;
  let msg = String(error);
  try {
    const j = JSON.parse(msg);
    msg = j.error?.message || j.message || msg;
  } catch {}
  if (/model is not supported|model_not_found|not_found_error.*model|invalid model/i.test(msg))
    msg += engineId === "codex" ? " Clear the Model box to use Codex's default, or type a model your plan includes." : " Clear the Model box, or try opus or sonnet.";
  return msg;
}

/** A tiny call that proves the engine answers with this account, and reads current plan usage. */
export async function testEngine(cfg, { cwd, env = process.env } = {}) {
  const usage = { pct: null, window: null };
  const r = await runEngine({ engineId: cfg.engine, cfg: { ...cfg, usageLimit: 100 }, prompt: "Reply with the single word OK.", cwd, env, test: true, usageState: usage, timeoutMs: 120000 });
  const ok = !r.error && /\bok\b/i.test(r.text);
  return { ok, at: new Date().toISOString(), engine: cfg.engine, auth: cfg.auth, model: modelFor(cfg), usagePct: usage.pct, usageWindow: usage.window, error: ok ? null : r.error || `unexpected answer: ${r.text.slice(0, 200)}` };
}

/** Is the saved config ready to run? Returns null if ready, else the reason. */
export function notReady(cfg, env = process.env) {
  if (!cfg.engine) return "connect an AI engine first";
  if (cfg.auth === "key" && !ENGINES[cfg.engine].keyVars.some((k) => env[k])) return `no ${ENGINES[cfg.engine].keyVar} saved; paste a key or switch to your signed-in account`;
  if (!cfg.test?.ok) return "press Test in Connect AI first";
  if (cfg.test.engine !== cfg.engine || cfg.test.auth !== cfg.auth || cfg.test.model !== modelFor(cfg)) return "settings changed since the last test; press Test again";
  if (cfg.auth === "login" && typeof cfg.test.usagePct === "number" && cfg.test.usagePct > cfg.usageLimit) return `plan usage is at ${cfg.test.usagePct}%, above your ${cfg.usageLimit}% limit`;
  return null;
}
