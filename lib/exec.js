// Process-spawning helpers — explicit argv (no shell interpolation) for
// portability across CMD/PowerShell/bash/zsh.

import { spawn, spawnSync } from "child_process";

const IS_WINDOWS = process.platform === "win32";

// Node 20.12+ refuses to spawn .cmd/.bat files on Windows unless `shell: true`
// is set (CVE-2024-27980 hardening). Without this auto-detect, calling
// `spawn('npm.cmd', …)` throws synchronously. We honor an explicit
// opts.shell if provided; otherwise we set true automatically for batch files.
function needsShell(cmd, opts) {
  if (opts.shell !== undefined) return opts.shell;
  if (!IS_WINDOWS) return false;
  const lower = String(cmd).toLowerCase();
  return lower.endsWith(".cmd") || lower.endsWith(".bat");
}

// Run a command, return { code, stdout, stderr }. Argv-based, no shell
// (except auto-true for Windows .cmd/.bat — see needsShell above).
export function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env || {}) },
        stdio: opts.stdio ?? "pipe",
        shell: needsShell(cmd, opts),
        windowsHide: true,
      });
    } catch (err) {
      // Synchronous spawn failure (e.g. ENOENT, EINVAL). Surface as a
      // resolved failure so callers can branch on r.code.
      resolve({ code: -1, stdout: "", stderr: err.message });
      return;
    }

    let stdout = "";
    let stderr = "";
    if (child.stdout) child.stdout.on("data", (d) => (stdout += d.toString()));
    if (child.stderr) child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => resolve({ code: -1, stdout, stderr: err.message }));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

export function runSync(cmd, args = [], opts = {}) {
  let result;
  try {
    result = spawnSync(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}) },
      encoding: "utf8",
      shell: needsShell(cmd, opts),
      windowsHide: true,
    });
  } catch (err) {
    return { code: -1, stdout: "", stderr: err.message };
  }
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? result.error.message : ""),
  };
}

// Inherit stdio so the user sees live output (unless opts.stdio overrides
// — pass "ignore" to suppress output entirely, useful when a StepLine is
// active on the same terminal).
export function runInherit(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env || {}) },
        stdio: opts.stdio ?? "inherit",
        shell: needsShell(cmd, opts),
        windowsHide: true,
      });
    } catch (err) {
      process.stderr.write(`spawn failed: ${err.message}\n`);
      resolve(-1);
      return;
    }
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", (err) => {
      process.stderr.write(`spawn error: ${err.message}\n`);
      resolve(-1);
    });
  });
}

// Fire-and-forget: spawn detached, redirect stdout+stderr to a log file,
// detach from the parent process group, return the PID. The child keeps
// running after `ym` exits — used for `ym up` so the terminal frees up.
export async function runDetached(cmd, args = [], opts = {}) {
  const fs = await import("fs");
  if (!opts.logFile) throw new Error("runDetached requires opts.logFile");

  // Make sure the log file directory exists.
  const path = await import("path");
  const dir = path.dirname(opts.logFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const out = fs.openSync(opts.logFile, "a");
  const err = fs.openSync(opts.logFile, "a");

  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env || {}) },
    stdio: ["ignore", out, err],
    shell: needsShell(cmd, opts),
    detached: true,
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

// sleep helper used by readiness polls.
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Does `cmd` exist on PATH?
export function commandExists(cmd) {
  const probe = IS_WINDOWS ? "where" : "command";
  const args = IS_WINDOWS ? [cmd] : ["-v", cmd];
  const result = runSync(probe, args, { shell: !IS_WINDOWS && probe === "command" });
  return result.code === 0;
}

// Run `tasks` (each `() => Promise`) with at most `concurrency` in flight.
export async function parallel(tasks, concurrency = 4) {
  const results = new Array(tasks.length);
  let next = 0;

  async function worker() {
    while (next < tasks.length) {
      const idx = next++;
      try {
        results[idx] = { ok: true, value: await tasks[idx]() };
      } catch (err) {
        results[idx] = { ok: false, error: err };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}
