// Opt-in heavy lane helpers: run a Python sidecar or a binary as a separate program, with a time
// limit, JSON in and JSON out. Nothing here is imported by the default run. A missing Python, a
// missing library or a missing binary comes back as { ok: false, missing }, never a throw or a
// stall, so the module can write an "error" status with the install line.
//
// Licences: the sidecars call imagehash (BSD-2), trafilatura (Apache-2.0), youtube-transcript-api
// (MIT), faster-whisper (MIT) and edgartools (MIT) as installed libraries, and exiftool (Perl
// Artistic / GPL) only as a separate program. None of their code is copied into this repo.

import { spawn } from "node:child_process";
import { join, dirname, delimiter } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SIDECARS = join(HERE, "py");

/** The Python to use: OSINT_PYTHON, else python3 on PATH. */
export const pythonBin = (env = process.env) => env.OSINT_PYTHON || "python3";

/** Absolute path of a program on PATH, or null. */
export function which(bin, env = process.env) {
  if (bin.includes("/")) return existsSync(bin) ? bin : null;
  for (const d of String(env.PATH || "").split(delimiter)) {
    if (d && existsSync(join(d, bin))) return join(d, bin);
  }
  return null;
}

/**
 * Run a program. Resolves { ok, code, stdout, stderr, ms, timedOut, missing }.
 * missing is set when the program itself is not installed (ENOENT).
 */
export function runProgram(bin, args, { input = null, timeoutMs = 30000, env = process.env, cwd } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let child;
    try {
      child = spawn(bin, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, code: null, stdout: "", stderr: String(e.message || e), ms: 0, missing: bin });
    }
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout: out, stderr: String(e.message || e), ms: Date.now() - t0, timedOut, missing: e.code === "ENOENT" ? bin : null });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, stdout: out, stderr: err, ms: Date.now() - t0, timedOut, missing: null });
    });
    child.stdin.on("error", () => {}); // a program that exits early closes stdin; not an error here
    if (input != null) child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
    else child.stdin.end();
  });
}

/**
 * Run scripts/osint/py/<name>.py with a JSON request on stdin; the sidecar prints one JSON
 * object. A sidecar reports a missing library as {"missing": ["imagehash", ...]} and exit code 3.
 * Returns { ok, data, missing: [..] | null, error, ms }.
 */
export async function runSidecar(name, request, { timeoutMs = 60000, env = process.env } = {}) {
  const py = pythonBin(env);
  const r = await runProgram(py, ["-I", join(SIDECARS, `${name}.py`)], { input: request, timeoutMs, env });
  if (r.missing) return { ok: false, data: null, missing: ["python3"], error: `${py} not found`, ms: r.ms };
  if (r.timedOut) return { ok: false, data: null, missing: null, error: `timed out after ${Math.round(timeoutMs / 1000)} s`, ms: r.ms };
  let data = null;
  try {
    data = JSON.parse(r.stdout.trim().split("\n").filter(Boolean).at(-1) || "null");
  } catch {
    data = null;
  }
  if (data?.missing?.length) return { ok: false, data, missing: data.missing, error: `missing Python package(s): ${data.missing.join(", ")}`, ms: r.ms };
  if (!r.ok || !data) return { ok: false, data, missing: null, error: (data?.error || r.stderr || `exit ${r.code}`).toString().trim().split("\n").slice(-2).join(" ").slice(0, 300), ms: r.ms };
  return { ok: true, data, missing: null, error: data.error || null, ms: r.ms };
}

/** Which of these Python modules import (by importlib.util.find_spec): { name: true|false }, or null without Python. */
export async function pythonHas(mods, { env = process.env, timeoutMs = 8000 } = {}) {
  const code = `import importlib.util, json, sys\nprint(json.dumps({m: importlib.util.find_spec(m) is not None for m in sys.argv[1:]}))`;
  const r = await runProgram(pythonBin(env), ["-I", "-c", code, ...mods], { timeoutMs, env });
  if (r.missing || !r.ok) return null;
  try {
    return JSON.parse(r.stdout.trim());
  } catch {
    return null;
  }
}

/** pip line for missing import names. */
export const PIP = { imagehash: "imagehash", PIL: "pillow", trafilatura: "trafilatura", youtube_transcript_api: "youtube-transcript-api", faster_whisper: "faster-whisper", edgar: "edgartools", yt_dlp: "yt-dlp" };
export const pipLine = (missing) => `pip install ${[...new Set(missing.filter((m) => m !== "python3").map((m) => PIP[m] || m))].join(" ")}`;

/**
 * The standard way a heavy module reports a missing dependency: a miss on each of its variables
 * that reads "not run" (so the dossier shows it as unknown, not none) and module status "error".
 */
export function depMiss(ctx, vars, what, missing, fix, pyDeps = []) {
  const noPy = missing.includes("python3");
  const how = fix || (noPy ? `install Python 3 (or set OSINT_PYTHON to its path)${pyDeps.length ? `, then ${pipLine(pyDeps)}` : ""}` : pipLine(missing));
  const line = `${what}: not run, ${noPy ? "Python 3 not found" : `missing ${missing.join(", ")}`} · fix: ${how}`;
  for (const v of [].concat(vars)) ctx.miss(v, line, { blocked: true });
  ctx.status("error", line);
  return line;
}
