// =============================================================================
// All `ym <subcommand>` implementations. The dispatcher in cli.js calls into
// these. Each is small enough to read end-to-end.
// =============================================================================

import fs from "fs";
import path from "path";
import crypto from "crypto";
import readline from "readline";
import { spawn } from "child_process";

import { YM_ROOT, YM_LOCAL, TOOL_ROOT } from "./bootstrap.js";
import { c, ok, warn, fail, info, nextStep, section, table, spinner } from "./term.js";
import { run, runInherit, runSync, commandExists, parallel } from "./exec.js";
import { loadServices, byName, isCompanion, repoDirOf, envNames, envBranch, envForBranch, gatewayPort } from "./services.js";
import { LiveTable, StepLine } from "./live.js";
import { npmRunnerFor, requiredMajor, ensureNodeMajors, nodeFixHint } from "./node-runner.js";
import * as git from "./git.js";
import * as ports from "./ports.js";
import * as tilt from "./tilt.js";
import * as state from "./state.js";
import { notify } from "./notify.js";
import { openExternal } from "./openurl.js";
import { writeNginxConf, writeVSCodeWorkspace } from "./codegen.js";
import * as presets from "./presets.js";
import * as stacks from "./stacks.js";

const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

// Resolve the active set as full service objects (not just names). Reads
// the active selection from state and falls back to the default preset.
// Replaces the old `activeSvcs()` — the `enabled` flag no longer exists;
// activity is decided by presets/stacks.
function activeSvcs() {
  const names = new Set(presets.activeServiceNames());
  return loadServices().services.filter((s) => names.has(s.name));
}

// If Tilt is running, restart it so the latest active selection takes
// effect (Tilt's --only filter is frozen at process start). No-op if Tilt
// isn't running. Shared by every command that mutates active selection in
// ways Tilt can't pick up live: ym add, ym remove, ym stack apply,
// ym stack edit (when the edited stack is active).
//
//   opts.suffix  short tail for the success line; e.g. "orders-api
//                now removed" → "running (pid 1234) — orders-api now
//                removed"
//
// Returns { restarted, ok }:
//   restarted=false        Tilt wasn't running; caller should hint `ym up`
//   restarted=true, ok=true  successful bounce; nothing more to do
//   restarted=true, ok=false something failed mid-bounce; helper already
//                            printed the diagnostic + a warn() — caller
//                            should usually just return
async function restartTiltIfRunning(opts = {}) {
  if (!(await tilt.isRunning())) {
    return { restarted: false, ok: true };
  }
  const { StepLine } = await import("./live.js");
  const step = new StepLine("Restarting Tilt");
  step.start("stopping current instance");

  const stopRes = await tilt.down();
  if (!stopRes.stopped) {
    step.fail(stopRes.reason || "couldn't stop Tilt");
    warn("Run `ym down && ym up` manually to apply the change");
    return { restarted: true, ok: false };
  }

  step.update("starting with updated selection");
  const sel = presets.activeSelection().services ?? [];
  const pid = await tilt.up({ only: sel });
  if (!pid) {
    step.fail("Tilt failed to start");
    process.stdout.write("\nLast log lines:\n" + c.gray(tilt.tailLog(30)) + "\n");
    return { restarted: true, ok: false };
  }

  step.update(`waiting for API (pid ${pid})`);
  const ready = await tilt.waitForReady(20000);
  if (!ready) {
    step.fail(`Tilt did not respond on :${tilt.TILT_PORT} within 20s`);
    process.stdout.write("\nLast log lines:\n" + c.gray(tilt.tailLog(30)) + "\n");
    return { restarted: true, ok: false };
  }

  const tail = opts.suffix ? ` — ${opts.suffix}` : "";
  step.succeed(`running (pid ${pid})${tail}`);
  return { restarted: true, ok: true };
}

// ---- shared picker helpers ------------------------------------------------
// Used by every command that takes a positional `<service>` and offers an
// interactive picker when the positional is omitted. See lib/picker.js for
// the lower-level inquirer wrappers.

async function pickClonedService(message) {
  const picker = await import("./picker.js");
  // Cloned = present on disk. The picker shows any cloned service so
  // commands like `ym shell` work for services brought in via `ym add`
  // even when they're not part of the active selection.
  const cloned = loadServices().services.filter((s) =>
    fs.existsSync(path.join(YM_ROOT, repoDirOf(s))),
  );
  return picker.pickOne(
    message,
    cloned.map((s) => ({
      value: s.name,
      label: s.name,
      description: isCompanion(s) ? `↳ ${s.source}` : `port ${s.port}`,
    })),
    {
      tag: "Service",
      emptyMessage: "No services cloned yet. Run `ym add <name>` first.",
      pageSize: 20,
    },
  );
}

// -----------------------------------------------------------------------------
// regen — rebuild nginx.conf from services.yaml
// -----------------------------------------------------------------------------
export async function regen() {
  const { StepLine } = await import("./live.js");
  const step = new StepLine("Codegen");
  step.start("rewriting nginx.conf + yardmaster.code-workspace");

  const dest = writeNginxConf();
  // If the nginx runtime dir exists, mirror it there so `nginx -s reload` works.
  const nginxConfTarget = path.join(YM_LOCAL, "nginx", "conf", "nginx.conf");
  if (fs.existsSync(path.dirname(nginxConfTarget))) {
    fs.copyFileSync(dest, nginxConfTarget);
  }
  writeVSCodeWorkspace();

  step.succeed("nginx.conf + yardmaster.code-workspace");
}

// -----------------------------------------------------------------------------
// up [services...] [--attach|-a] — start Tilt
//
// Default: detached. Spawns tilt in the background, polls until its API
// answers, prints URLs, returns to the prompt. The user's terminal stays
// free. Stop with `ym down`. Tail logs with `ym logs --tilt`.
//
// `--attach` (or `-a`) keeps the legacy foreground behavior — Tilt streams
// its TUI and you Ctrl+C to stop.
//
// Filter precedence:
//   1. Positional args to `ym up svc1 svc2`
//   2. Active preset / custom selection from state
//   3. Nothing — Tilt registers every service in the active selection
//      (or the default preset if no selection is set)
// -----------------------------------------------------------------------------
export async function up(args) {
  const attach = args.includes("--attach") || args.includes("-a");
  const positionals = args.filter((a) => a !== "--attach" && a !== "-a");

  const fromArgs = positionals.length > 0 ? positionals : null;
  const fromState = presets.activeSelection().services;
  const onlyEffective = fromArgs ?? fromState ?? [];

  // Short-circuit if Tilt is already up. This MUST come before preflight()
  // and regen(): otherwise we'd run "port already bound" warnings against
  // ports that *we* bound, plus emit "regenerated" lines for files that
  // didn't actually change. The previous flow surfaced both as noise and
  // then contradicted itself with "Starting 14 service(s)" followed by
  // "Tilt is already running" — confusing and worse than useless.
  //
  // Check our PID file FIRST (instant, no network): on a big stack the
  // /api/view probe can time out under load and false-negative, which made
  // `ym up` think Tilt was down and collide on the ports the live Tilt
  // already holds. ourTiltAlive() short-circuits that for any ym-started Tilt.
  const foreign = await tilt.foreignTilt();
  if (foreign) {
    fail(`Another Tilt (${foreign}) is already using :${tilt.TILT_PORT}.`);
    nextStep("stop that Tilt, or set `tilt_port:` in services.yaml to run side by side");
    process.exit(1);
  }
  if (tilt.ourTiltAlive() || await tilt.isRunning()) {
    info(`Tilt is already running on :${tilt.TILT_PORT}`);
    process.stdout.write("\n");
    if (fromArgs && fromArgs.length > 0) {
      // User asked for specific services with a running Tilt. We can't
      // mutate the live Tilt's --only filter — its config args are frozen
      // at startup. Point them at the right tool.
      for (const name of fromArgs) {
        nextStep(`ym add ${name}             add to running session`);
      }
      nextStep(`ym down && ym up ${fromArgs.join(" ")}    restart with the new selection`);
    } else {
      nextStep("ym status        see what's running");
      nextStep("ym down          stop it");
      nextStep("ym logs --tilt   tail the Tilt log");
    }
    return;
  }

  await preflight(onlyEffective);
  await regen();   // always regen first so nginx and Tilt agree

  if (onlyEffective.length > 0) {
    const sel = presets.activeSelection();
    const tag = fromArgs
      ? c.gray("(from args)")
      : sel.stackKey
        ? c.gray(`(stack: ${sel.stackKey})`)
        : c.gray("(custom selection)");
    info(`Starting ${onlyEffective.length} service(s) ${tag}`);
  }

  if (attach) {
    // Legacy foreground mode — also where the crash-toast watcher lives,
    // because in detached mode there's no parent process to watch.
    const watcher = startCrashWatcher();
    const code = await tilt.up({ only: onlyEffective, attach: true });
    watcher.stop();
    if (code !== 0) {
      notify("ym up failed", `tilt exited with code ${code}`, { urgency: "critical" });
    }
    process.exit(code);
  }

  // Default: detached.
  const pid = await tilt.up({ only: onlyEffective, attach: false });
  const sp = spinner(`starting Tilt (pid ${pid})`);
  const ready = await tilt.waitForReady(20000);

  if (!ready) {
    sp.stop(c.red("✖"), `Tilt did not respond on :${tilt.TILT_PORT} within 20s`);
    process.stdout.write("\nLast log lines:\n");
    process.stdout.write(c.gray(tilt.tailLog(30)) + "\n");
    notify("ym up failed", "Tilt did not start", { urgency: "critical" });
    process.exit(1);
  }
  sp.stop(undefined, `Tilt is up (pid ${pid})`);

  // Print the useful URLs and how to interact from here.
  const fronts = activeSvcs().filter((s) => s.kind === "frontend");
  process.stdout.write("\n");
  ok(`Dashboard:   ${tilt.dashboardUrl()}`);
  for (const f of fronts) ok(`${f.name.padEnd(12)} http://localhost:${f.port}${f.health_path || "/"}`);
  ok(`Nginx:       http://localhost:${gatewayPort()}/`);
  process.stdout.write("\n");
  nextStep("ym status    see service health");
  nextStep("ym down      stop everything");
}

function startCrashWatcher() {
  // Track last-seen status per service so we only notify on transitions.
  const lastSeen = new Map();
  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      const map = await tilt.resourceMap();
      for (const [name, info] of Object.entries(map)) {
        const status = info.runtimeStatus || info.status || "unknown";
        const prev = lastSeen.get(name);
        const isBad = status === "error" || status === "crashed";
        const wasOk = prev && prev !== "error" && prev !== "crashed";

        if (isBad && wasOk) {
          notify(`${name} crashed`, info.lastBuildError || `runtime status: ${status}`, {
            urgency: "critical",
          });
        }
        lastSeen.set(name, status);
      }
    } catch {
      /* tilt API not ready yet; ignore */
    }
    if (!stopped) setTimeout(tick, 4000);
  }

  setTimeout(tick, 3000);   // small startup delay
  return { stop: () => { stopped = true; } };
}

async function preflight(filter) {
  // When the user has an explicit selection (preset or args), use it.
  // Otherwise, fall back to the active set (resolved from selection or
  // default preset by activeSvcs()).
  const allSvcs = loadServices().services;
  const target = filter.length
    ? allSvcs.filter((s) => filter.includes(s.name))
    : activeSvcs();
  if (filter.length && target.length === 0) {
    fail(`No services matched: ${filter.join(", ")}`);
    process.exit(1);
  }

  // Port collision: anything bound that we want to use? Skip companions (no port).
  const conflicts = [];
  const checks = target.map(async (s) => {
    if (!s.port) return;
    if (await ports.isPortInUse(s.port)) conflicts.push(s);
  });
  await Promise.all(checks);

  if (conflicts.length) {
    warn("Ports already bound before Tilt starts:");
    for (const s of conflicts) {
      warn(`  ${s.port} (needed by ${s.name})`);
    }
    warn("Stop the conflicting process or run `ym doctor` for details.");
  }

  // Repo presence sanity check. Companions live inside their `source:` repo, not their own folder.
  const missing = target.filter((s) => !fs.existsSync(path.join(YM_ROOT, s.source || s.name)));
  if (missing.length) {
    fail(
      `These services are in your active selection but not cloned yet:\n  ${missing
        .map((s) => s.name)
        .join("\n  ")}\nRun \`ym setup\` or \`ym add <name>\`.`,
    );
    process.exit(1);
  }
}

// -----------------------------------------------------------------------------
// down — stop the detached Tilt process tree (since `tilt down` is a no-op
// for local_resource setups).
// -----------------------------------------------------------------------------
export async function down() {
  const { StepLine } = await import("./live.js");
  const step = new StepLine("Stopping Tilt");
  step.start("signalling process tree");

  const result = await tilt.down();
  if (result.stopped) {
    step.succeed("all processes stopped");
  } else if (result.reason === "Tilt is not running") {
    step.skip(result.reason);
  } else {
    step.fail(result.reason || "Tilt did not exit");
    process.exit(1);
  }
}

// -----------------------------------------------------------------------------
// env <env> — regenerate every service's .env file for an environment.
//
// Was previously named `ym switch`; that name now means "switch all repos
// to a branch" (see `switchBranch` below). The two cleanly separate:
//   ym env <env>        config files only — no git
//   ym switch <branch>  git only (plus auto env-files when branch == env)
// -----------------------------------------------------------------------------
export async function env(args) {
  const ENVS = envNames();
  let envName = args[0];
  if (!envName) {
    const picker = await import("./picker.js");
    envName = await picker.pickOne(
      "Regenerate .env files for which environment?",
      ENVS.map((e) => ({ value: e, label: e })),
      { default: state.getEnv(), tag: "Environment" },
    );
  }
  if (!ENVS.includes(envName)) {
    fail(`Unknown env: ${envName}. Known: ${ENVS.join(", ")}`);
    process.exit(1);
  }

  const { StepLine } = await import("./live.js");
  const { generateEnvFiles } = await import("./env-compiler.js");

  const step = new StepLine(`Environment '${envName}'`);
  step.start("checking .env files");

  let results;
  try {
    results = generateEnvFiles(envName);
  } catch (err) {
    step.fail(err.message);
    process.exit(1);
  }

  const wrote = results.filter((r) => r.status === "written").length;
  const unchanged = results.filter((r) => r.status === "unchanged").length;
  const skipped = results.filter((r) => r.status === "skipped").length;

  // True no-op: nothing changed AND we were already on this env.
  if (wrote === 0 && state.getEnv() === envName) {
    step.succeed(`already current (${unchanged} unchanged)`);
    return;
  }

  const parts = [];
  if (wrote) parts.push(`${wrote} written`);
  if (unchanged) parts.push(`${unchanged} unchanged`);
  if (skipped) parts.push(`${skipped} skipped`);
  step.succeed(parts.join(", "));

  // Surface skipped services (not cloned). One short line each, gray.
  for (const r of results) {
    if (r.status === "skipped") info(`  ${r.name}  ${c.gray(r.reason)}`);
  }

  state.setEnv(envName);

  // Hint about restarting Tilt only when (a) Tilt is running AND (b) at
  // least one file actually changed. Skipping the hint on no-ops keeps
  // re-running `ym env <same>` silent.
  if (wrote > 0 && await tilt.isRunning()) {
    nextStep("Tilt is running — restart with `ym down && ym up` to pick up the new env");
  }
}

// -----------------------------------------------------------------------------
// switch <branch> [--stash] — move every cloned repo onto <branch>.
//
//   Default: dirty repos are SKIPPED with a clear message. User decides
//            whether to commit/discard, then re-runs.
//   --stash: dirty repos get stashed (tagged ym-switch@<target>@<iso>) and
//            the stash is LEFT PARKED on the new branch — not auto-reapplied.
//            Prevents the cross-branch work-leakage footgun.
//
// If <branch> is an environment's branch (services.yaml), .env files are
// regenerated for that environment.
//
// `ym switch` USED to mean .env-file regen only; that lives at `ym env`
// now.
// -----------------------------------------------------------------------------
// Picker choices for switch/sync: each environment's branch, deduplicated.
function envBranchChoices() {
  return [...new Set(envNames().map(envBranch))].map((b) => ({ value: b, label: b }));
}

export async function switchBranch(args) {
  const stash = args.includes("--stash");
  const positionals = args.filter((a) => a !== "--stash");
  let target = positionals[0];

  if (!target) {
    const picker = await import("./picker.js");
    const currentEnv = state.getEnv();
    target = await picker.pickOneOrType(
      "Switch every repo to which branch?",
      envBranchChoices(),
      {
        default: envBranch(currentEnv),
        otherPrompt: "Branch name:",
        validate: (v) => (v && v.trim().length > 0) || "Branch can't be empty",
        tag: "Switch target",
      },
    );
    target = String(target).trim();
  }

  const { syncAll } = await import("./sync.js");
  const { results } = await syncAll(target, {
    stayOnTarget: true,
    dirtyMode: stash ? "stash" : "skip",
    commandTag: "ym-switch",
  });

  if (results.length === 0) {
    info("No cloned repos found. Run `ym setup` first.");
    return;
  }

  // ---- summary -----------------------------------------------------------
  const switched = results.filter((r) => r.status.startsWith("switched"));
  const stashedAndKept = results.filter((r) => r.status === "switched (work stashed)");
  const dirtySkipped = results.filter(
    (r) => r.status === "skipped" && /uncommitted/.test(r.reason || ""),
  );
  const otherSkipped = results.filter(
    (r) => r.status === "skipped" && !/uncommitted/.test(r.reason || ""),
  );
  const failures = results.filter((r) => r.status === "failed");
  const pullDiverged = results.filter((r) => r.pullWarning);

  process.stdout.write("\n");
  const parts = [c.green(`${switched.length} switched`)];
  if (dirtySkipped.length) parts.push(c.yellow(`${dirtySkipped.length} skipped (dirty)`));
  if (otherSkipped.length) parts.push(c.gray(`${otherSkipped.length} skipped`));
  if (failures.length) parts.push(c.red(`${failures.length} failed`));
  process.stdout.write("  " + parts.join("  ·  ") + "\n");

  // Dirty repos that were skipped: tell the user how to recover.
  if (dirtySkipped.length) {
    process.stdout.write("\n" + c.bold(c.yellow("Skipped — uncommitted changes")) + "\n");
    for (const r of dirtySkipped) {
      process.stdout.write(`  ${c.yellow("!")} ${r.repo}\n`);
    }
    process.stdout.write(
      c.gray(
        `\n  Resolve by committing or discarding the changes in each repo, then\n` +
        `  re-run \`ym switch ${target}\`. Or pass --stash to park them instead:\n` +
        `      ym switch ${target} --stash\n`,
      ),
    );
  }

  // Stashed-and-kept: print copy-pasteable recovery commands.
  if (stashedAndKept.length) {
    process.stdout.write("\n" + c.bold("Stashed (NOT auto-reapplied)") + "\n");
    for (const r of stashedAndKept) {
      process.stdout.write(
        `  ${c.cyan("📦")} ${r.repo.padEnd(28)} ${c.gray(r.stashMessage)}\n`,
      );
    }
    process.stdout.write(
      c.gray(
        `\n  Recover with:\n` +
        stashedAndKept
          .map((r) => `      cd ${r.repo} && git stash pop`)
          .join("\n") +
        "\n",
      ),
    );
  }

  // Non-dirty skips (mid-rebase, target-not-on-remote, etc.).
  if (otherSkipped.length) {
    process.stdout.write("\n" + c.bold("Skipped — other reasons") + "\n");
    for (const r of otherSkipped) {
      process.stdout.write(`  ${c.gray("·")} ${r.repo.padEnd(28)} ${c.gray(r.reason)}\n`);
    }
  }

  // Hard failures.
  if (failures.length) {
    process.stdout.write("\n" + c.bold(c.red("Failed")) + "\n");
    for (const r of failures) {
      const reason = String(r.reason || "").split("\n")[0].slice(0, 120);
      process.stdout.write(
        `  ${c.red("✗")} ${r.repo.padEnd(28)} ${c.gray(`${r.phase || "?"}: ${reason}`)}\n`,
      );
    }
  }

  if (pullDiverged.length) {
    process.stdout.write("\n" + c.bold("Pull skipped (local diverged)") + "\n");
    for (const r of pullDiverged) {
      process.stdout.write(`  ${c.yellow("!")} ${r.repo.padEnd(28)} ${c.gray(r.pullWarning)}\n`);
    }
  }

  // ---- env-file regen (when target matches a known env) -----------------
  // Only fires when the user clearly intended a full env switch — if the
  // user passed a custom branch (feature/x, production, …), env regen is
  // not appropriate and we stay out of the way.
  const targetEnv = envForBranch(target);
  if (targetEnv && switched.length > 0 && state.getEnv() !== targetEnv) {
    process.stdout.write("\n");
    await env([targetEnv]);
  }

  // Branch switches don't change which environment you're on, and git never
  // touches .env (it's git-ignored / untracked), so the .env you had is
  // preserved automatically. The one gap Tilt can't recover from is a repo
  // with NO .env yet (freshly cloned, or deleted by hand). Fill those in for
  // the current env without overwriting any existing file.
  {
    const { ensureEnvFiles } = await import("./env-compiler.js");
    const created = ensureEnvFiles(state.getEnv()).filter((r) => r.status === "created");
    if (created.length) {
      info(`Generated missing .env for ${created.length} repo(s): ${created.map((r) => r.name).join(", ")}`);
    }
  }

  // Exit non-zero only on hard failures, not on dirty-skips (which are
  // an expected outcome users opt into).
  if (failures.length > 0) {
    process.exit(1);
  }
}

// -----------------------------------------------------------------------------
// checkout <svc=branch>... — per-service branch override
// -----------------------------------------------------------------------------
export async function checkout(args) {
  // Interactive: prompt for a service and a branch when no positional args.
  // Only one service per interactive invocation; for multi-service moves the
  // user can pass positionals (`ym checkout a=feature b=feature`).
  if (!args.length) {
    const picker = await import("./picker.js");
    const name = await pickClonedService("Check out a branch on which service?");
    const svc = byName(name);
    const repoPath = path.join(YM_ROOT, name);
    const currentBranch = svc && fs.existsSync(repoPath)
      ? git.currentBranch(repoPath)
      : null;
    const branch = await picker.askText("Branch:", {
      default: currentBranch ?? state.getEnv(),
      validate: (v) => (v && v.trim().length > 0) || "Branch can't be empty",
      tag: "Branch",
    });
    args = [`${name}=${branch.trim()}`];
  }
  for (const arg of args) {
    const m = arg.match(/^([^=]+)=(.+)$/);
    if (!m) {
      fail(`Bad form: ${arg} (expected name=branch)`);
      continue;
    }
    const [, name, branch] = m;
    const svc = byName(name);
    if (!svc) {
      fail(`unknown service: ${name}`);
      continue;
    }
    const repoPath = path.join(YM_ROOT, name);
    if (!fs.existsSync(repoPath)) {
      fail(`${name} not cloned yet`);
      continue;
    }
    await git.fetch(repoPath);
    // Resilient: transparently sets aside a blocking untracked .env so a
    // checkout onto a branch that commits .env doesn't hard-error.
    const r = await git.checkoutResilient(repoPath, branch);
    if (r.code !== 0) {
      fail(`${name}: checkout ${branch} failed (${r.stderr.trim()})`);
      continue;
    }
    await git.pull(repoPath, branch);
    ok(`${name} → ${branch}${r.setAside?.length ? c.gray(` (using branch's ${r.setAside.join(", ")})`) : ""}`);
  }

  // Same rationale as `ym switch`: a checkout never changes the environment
  // and git leaves .env alone, so preserve any existing .env and only fill in
  // a missing one so Tilt can boot the service.
  {
    const { ensureEnvFiles } = await import("./env-compiler.js");
    const created = ensureEnvFiles(state.getEnv()).filter((r) => r.status === "created");
    if (created.length) {
      info(`Generated missing .env for ${created.length} repo(s): ${created.map((r) => r.name).join(", ")}`);
    }
  }
}

// -----------------------------------------------------------------------------
// status [-r|--routes] — one-screen summary.
//
// --routes / -r adds a ROUTES column showing each service's nginx route
// prefixes. Folds in what used to be the separate `ym routes` command.
// -----------------------------------------------------------------------------
export async function status(args = []) {
  const showRoutes = args.includes("--routes") || args.includes("-r");

  // Show the active set — selected_services if the user picked a preset or
  // custom selection, otherwise the default preset's services (handled by
  // activeSvcs()).
  const active = presets.activeSelection();
  const all = activeSvcs();

  const NGINX_PORT = gatewayPort();

  // Three classes of data we need: (a) Tilt's authoritative runtime status
  // for each service, (b) a TCP-probe fallback per port, (c) per-repo git
  // state. All three are independent — fire them concurrently and wait once.
  //
  // Before this refactor, status() did three SYNC git calls (branch / dirty
  // / behind) inside a synchronous .map() over services, which serialized
  // 45 git invocations on Windows and made status feel like it hung for
  // ~5s. gatherStatusSnapshot batches all three into one git command, and
  // the surrounding Promise.all parallelizes across services — total time
  // is now bounded by the slowest single call.
  const { StepLine } = await import("./live.js");
  const step = new StepLine("Gathering status");
  step.start(`querying Tilt + ${all.length} service(s)`);

  let tiltState, portUseMap, snapshotMap, nginxPortInUse;
  try {
    const repoPaths = all.map((s) => path.join(YM_ROOT, repoDirOf(s)));
    [tiltState, portUseMap, snapshotMap, nginxPortInUse] = await Promise.all([
      tilt.resourceMap(),
      Promise.all(all.map((s) =>
        (s.port ? ports.isPortInUse(s.port) : Promise.resolve(false)).then((b) => [s.name, b])))
        .then((entries) => Object.fromEntries(entries)),
      Promise.all(
        all.map((s, i) =>
          git.gatherStatusSnapshot(repoPaths[i]).then((snap) => [s.name, snap]),
        ),
      ).then((entries) => Object.fromEntries(entries)),
      ports.isPortInUse(NGINX_PORT),
    ]);
  } catch (err) {
    step.fail(err.message || String(err));
    throw err;
  }
  step.succeed(`${all.length} service(s)`);

  // Shared cell formatter so the nginx row uses identical state→color mapping.
  function fmtStatus(tiltInfo, portInUse) {
    if (tiltInfo) {
      const st = tiltInfo.runtimeStatus || tiltInfo.status;
      const color =
        st === "ok" || st === "running" ? c.green
        : st === "pending" ? c.yellow
        : st === "error" || st === "crashed" ? c.red
        : c.gray;
      return color(st);
    }
    return portInUse ? c.green("running*") : c.gray("stopped");
  }

  const rows = all.map((s) => {
    const snap = snapshotMap[s.name];           // null if not cloned
    const exists = snap !== null;
    const branch = snap?.branch ?? null;
    const dirty = exists && snap.dirty;
    const behind = snap?.behind ?? null;

    const statusCell = !exists
      ? c.gray("not cloned")
      : fmtStatus(tiltState[tilt.toTiltName(s.name)], portUseMap[s.name]);

    const row = [
      c.bold(s.name),
      branch ?? c.gray("—"),
      statusCell,
      s.port ? String(s.port) : c.gray("—"),
      dirty ? c.yellow("●") : "",
      behind && behind > 0 ? c.yellow(String(behind)) : "",
    ];
    if (showRoutes) {
      const routes = (s.routes && s.routes.length)
        ? s.routes.join(", ")
        : c.gray("—");
      row.push(routes);
    }
    return row;
  });

  // Prepend the nginx infra row. nginx isn't in services.yaml (it's the
  // local reverse proxy, registered directly in the Tiltfile), so it needs
  // a dedicated row here. Shown at the top because it gates routing for
  // every other service. Probes the gateway port directly.
  const nginxRow = [
    c.bold("nginx"),
    c.gray("—"),
    fmtStatus(tiltState["nginx"], nginxPortInUse),
    String(NGINX_PORT),
    "",
    "",
  ];
  if (showRoutes) nginxRow.push(c.gray("(routes everything)"));
  rows.unshift(nginxRow);

  let stackTag;
  if (active.stackKey) {
    const p = presets.getPreset(active.stackKey);
    stackTag = p ? `stack: ${c.bold(p.key)} (${p.label})` : `stack: ${active.stackKey}`;
  } else if (active.services && active.services.length) {
    stackTag = `custom selection (${active.services.length} services)`;
  } else {
    const def = presets.defaultPresetKey();
    stackTag = def ? `stack: ${c.bold(def)} (default fallback)` : "no selection";
  }
  section("Status", c.gray(`env=${state.getEnv()} · ${stackTag}`));
  process.stdout.write("\n");
  const headers = ["SERVICE", "BRANCH", "STATUS", "PORT", "DIRTY", "BEHIND"];
  if (showRoutes) headers.push("ROUTES");
  table(rows, headers);
  if (Object.keys(tiltState).length === 0) {
    info(c.gray("* = port probe (Tilt API didn't answer)"));
  }
}

// -----------------------------------------------------------------------------
// logs / restart / shell / open / routes
// -----------------------------------------------------------------------------
export async function logs(args) {
  // --tilt: tail the detached Tilt launcher's own log file (the one written
  // when `ym up` runs in default detached mode). Per-service logs go through
  // Tilt's API instead.
  if (args.includes("--tilt")) {
    const follow = args.includes("-f") || args.includes("--follow");
    return tailLocalFile(tilt.TILT_LOG, { follow });
  }

  const idx = args.findIndex((a) => a === "-f" || a === "--follow");
  const follow = idx !== -1;
  let name = args.filter((_, i) => i !== idx)[0];
  if (!name) {
    name = await pickClonedService("Tail logs for which service?");
  }
  if (!byName(name)) {
    fail(`unknown service: ${name}`);
    process.exit(1);
  }
  const code = await tilt.logs(name, { follow });
  process.exit(code);
}

async function tailLocalFile(file, { follow }) {
  if (!fs.existsSync(file)) {
    fail(`No log file at ${file}. Has \`ym up\` been run?`);
    process.exit(1);
  }
  process.stdout.write(fs.readFileSync(file, "utf8"));
  if (!follow) return;

  // Lightweight tail-follow: poll size every 500ms, stream the delta.
  let size = fs.statSync(file).size;
  process.on("SIGINT", () => process.exit(0));
  while (true) {
    await new Promise((r) => setTimeout(r, 500));
    const cur = fs.statSync(file).size;
    if (cur > size) {
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(cur - size);
      fs.readSync(fd, buf, 0, buf.length, size);
      fs.closeSync(fd);
      process.stdout.write(buf.toString("utf8"));
      size = cur;
    } else if (cur < size) {
      // File was truncated/rotated — restart from 0.
      size = 0;
    }
  }
}

// restart [service...] [--all|-a] — re-trigger one, several, or every active
// cloned service in Tilt.
export async function restart(args) {
  const all = args.includes("--all") || args.includes("-a");
  let names = args.filter((a) => !a.startsWith("-"));

  if (all) {
    if (!(await tilt.isRunning())) {
      fail("Tilt isn't running — run `ym up` first.");
      process.exit(1);
    }
    names = activeSvcs()
      .filter((s) => fs.existsSync(path.join(YM_ROOT, repoDirOf(s))))
      .map((s) => s.name);
    if (names.length === 0) {
      info("No active cloned services to restart.");
      return;
    }
  } else if (names.length === 0) {
    names = [await pickClonedService("Restart which service?")];
  }

  // Validate up front so a typo in a multi-arg call fails before we trigger
  // any of the valid ones.
  for (const name of names) {
    if (!byName(name)) {
      fail(`unknown service: ${name}`);
      process.exit(1);
    }
  }

  // Single service keeps the original behavior (inherit Tilt's output, exit
  // with its code). Multi / --all prints a compact per-service line instead.
  if (names.length === 1 && !all) {
    process.exit(await tilt.restart(names[0]));
  }

  let lastNonZero = 0;
  for (const name of names) {
    const code = await tilt.restart(name);
    if (code === 0) ok(`restarted ${name}`);
    else { warn(`${name}: trigger exited ${code}`); lastNonZero = code; }
  }
  process.exit(lastNonZero);
}

export async function shell(args) {
  const idx = args.findIndex((a) => a === "--shell");
  const shellOverride = idx !== -1 ? args[idx + 1] : null;
  const drop = idx === -1 ? new Set() : new Set([idx, idx + 1]);
  const positionals = args.filter((_, i) => !drop.has(i));
  let name = positionals[0];

  if (!name) {
    name = await pickClonedService("Open a shell in which service?");
  }
  const svc = byName(name);
  if (!svc) {
    fail(`unknown service: ${name}`);
    process.exit(1);
  }
  const repoPath = path.join(YM_ROOT, repoDirOf(svc));   // companions → source dir
  if (!fs.existsSync(repoPath)) {
    fail(`${name} not cloned`);
    process.exit(1);
  }

  // Load the service's .env into the spawned shell (a companion uses its
  // source's .env).
  const envPath = path.join(repoPath, ".env");
  const extraEnv = { ...process.env };
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      // Accept both `KEY: "value"` (this project's convention) and KEY=value.
      const m1 = line.match(/^([A-Z0-9_]+):\s*"(.*)"$/);
      const m2 = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m1) extraEnv[m1[1]] = m1[2];
      else if (m2) extraEnv[m2[1]] = m2[2];
    }
  }
  extraEnv.YM_SERVICE = name;
  if (svc.port) extraEnv.PORT = String(svc.port);
  // Surface a companion's role vars (LABEL_ROLE, …) so the subshell matches Tilt.
  for (const [k, v] of Object.entries(svc.env || {})) extraEnv[k] = String(v);

  // Pick a shell. Override > $SHELL > platform default.
  const isWin = process.platform === "win32";
  let shellCmd = shellOverride
    || process.env.SHELL
    || (isWin ? "powershell" : "bash");

  // Map friendly names to real exe.
  const map = { pwsh: "pwsh", powershell: "powershell", cmd: "cmd.exe", bash: "bash", zsh: "zsh" };
  if (map[shellCmd]) shellCmd = map[shellCmd];

  process.stdout.write(c.cyan(`Entering shell for ${name} (port ${svc.port}); exit to leave.\n`));
  const child = spawn(shellCmd, [], {
    cwd: repoPath,
    env: extraEnv,
    stdio: "inherit",
    windowsHide: false,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

export async function open(args) {
  let name = args[0];
  if (!name) {
    const picker = await import("./picker.js");
    const cloned = loadServices().services.filter((s) =>
      fs.existsSync(path.join(YM_ROOT, s.name)),
    );
    name = await picker.pickOne(
      "Open what in your browser?",
      [
        { value: "tilt", label: "tilt", description: "Tilt dashboard" },
        { value: "nginx", label: "nginx", description: `the local reverse proxy at :${gatewayPort()}` },
        ...cloned.map((s) => ({
          value: s.name,
          label: s.name,
          description: `port ${s.port}`,
        })),
      ],
      { tag: "Open target", pageSize: 20 },
    );
  }
  if (name === "tilt") {
    openExternal(tilt.dashboardUrl());
    return;
  }
  if (name === "nginx") {
    openExternal(`http://localhost:${gatewayPort()}/`);
    return;
  }
  const svc = byName(name);
  if (!svc) {
    fail(`unknown target: ${name}`);
    process.exit(1);
  }
  if (!svc.port) {
    fail(`${name} has no port to open (companion process — nothing to view in a browser).`);
    process.exit(1);
  }
  if (svc.kind === "frontend") {
    openExternal(`http://localhost:${svc.port}/`);
  } else {
    openExternal(`http://localhost:${svc.port}${svc.health_path || "/"}`);
  }
}

// -----------------------------------------------------------------------------
// code [service...] — open in VS Code.
//
//   ym code                         Open yardmaster.code-workspace (multi-root view).
//   ym code <svc>                   Open just that service's folder.
//   ym code <svc1> <svc2> ...       Open each in its own VS Code window
//                                   (VS Code's default for multiple folders).
//
// Tolerant arg parsing: shell tab-completion often hands us path-style
// values like `./web/` or `.\web\`. Strip leading `./` / `.\` and
// trailing slashes so those resolve to plain service names.
//
// Requires the `code` CLI to be on PATH. On macOS users may need to run
// "Shell Command: Install 'code' command in PATH" from the VS Code command
// palette once. We surface a clear message if it's missing rather than a
// raw ENOENT.
//
// Detaches from the ym process so the terminal returns immediately — VS
// Code launches in the background.
// -----------------------------------------------------------------------------
export async function code(args) {
  const codeCmd = process.platform === "win32" ? "code.cmd" : "code";
  if (!(await commandExists(codeCmd))) {
    fail(
      `'${codeCmd}' is not on your PATH.\n` +
      `  Install VS Code's shell command: open VS Code → \`Cmd/Ctrl+Shift+P\` →\n` +
      `  "Shell Command: Install 'code' command in PATH".`,
    );
    process.exit(1);
  }

  const names = args.map(normalizeServiceArg).filter(Boolean);
  let targets;
  let label;

  if (names.length === 0) {
    // No arg: open the multi-root workspace generated by codegen.
    const ws = path.join(YM_ROOT, "yardmaster.code-workspace");
    if (!fs.existsSync(ws)) {
      fail(
        `yardmaster.code-workspace not found at ${ws}.\n` +
        `  Run \`ym regen\` to generate it.`,
      );
      process.exit(1);
    }
    targets = [ws];
    label = "yardmaster.code-workspace";
  } else {
    // Fail-fast on any unknown / not-cloned name before launching anything —
    // matches the ym add pattern. We don't want to open 4 windows only to
    // discover the 5th name was a typo.
    targets = [];
    for (const name of names) {
      const svc = byName(name);
      if (!svc) {
        fail(`unknown service: ${name}`);
        process.exit(1);
      }
      const repoPath = path.join(YM_ROOT, repoDirOf(svc));   // companions → source dir
      if (!fs.existsSync(repoPath)) {
        fail(`${name} is not cloned — run \`ym add ${name}\` first.`);
        process.exit(1);
      }
      targets.push(repoPath);
    }
    label = names.length === 1 ? names[0] : `${names.length} services (${names.join(", ")})`;
  }

  // Spawn one `code` invocation per target. Passing multiple folders to a
  // single `code` invocation merges them into a multi-root workspace, not
  // separate windows; the only reliable way to get truly separate windows
  // is one process per folder. When opening just one thing (a service or
  // the .code-workspace file) we still use a single invocation and let
  // VS Code decide between current/new window per its own settings.
  //
  // Windows-specific care: route each spawn through `cmd /c` with
  // shell:false. shell:true would concatenate argv with spaces and no
  // quoting, so a path like C:\Users\First Last\… would be split into
  // two bogus paths that VS Code opens as untitled files. With cmd /c,
  // Node escapes argv for CreateProcess, cmd preserves the quoting when
  // forwarding to code.cmd (resolved via PATHEXT). windowsHide hides
  // cmd's transient console.
  const forceNewWindow = targets.length > 1;
  for (const target of targets) {
    const codeArgs = forceNewWindow ? ["-n", target] : [target];
    const child = process.platform === "win32"
      ? spawn("cmd", ["/c", "code", ...codeArgs], {
          stdio: "ignore",
          detached: true,
          windowsHide: true,
        })
      : spawn("code", codeArgs, {
          stdio: "ignore",
          detached: true,
        });
    child.unref();
  }

  info(`→ Opening ${label} in VS Code`);
}

// Normalize a service-name positional. Shell completion often inserts
// `./` (or `.\` on Windows) before the path and a trailing slash after
// it — `ym code ./web/` should be the same as `ym code web`.
// Anything that still contains a path separator after stripping returns
// unchanged, so it'll fall through to the standard "unknown service"
// error rather than being silently truncated.
function normalizeServiceArg(input) {
  return String(input)
    .replace(/^\.[\\/]/, "")     // leading ./ or .\
    .replace(/[\\/]+$/, "");      // trailing slashes (any kind, any count)
}

// (`ym routes` folded into `ym status --routes` — see status() above)

// -----------------------------------------------------------------------------
// doctor — actionable diagnostics in section layout. All-pass sections
// collapse to a single summary line; only failures expand with a one-line
// reason and a copy-pasteable Fix command.
// -----------------------------------------------------------------------------
export async function doctor(args = []) {
  const wantsFix = args.includes("--fix");
  const { StepLine } = await import("./live.js");
  const svcs = activeSvcs();

  // Phase 1 — gather everything in parallel under a spinner.
  //
  // The slow operations: Tilt API HTTP call (with timeout), N port
  // probes (TCP connect with 600ms timeout each), nginx port probe,
  // disk-space query (powershell on Windows). All independent.
  // Sequential, these add up to multiple seconds; parallel, bounded
  // by the slowest single call (typically 0.5–1.5s).
  const step = new StepLine("Gathering diagnostics");
  step.start(`probing ${svcs.length} service(s)`);

  // Per-service port check is two phases: TCP probe, then (if busy)
  // an HTTP probe to disambiguate "held by us" vs "foreign process."
  // Chain them per-service so services still run in parallel overall.
  const portCheck = async (svc) => {
    const busy = await ports.isPortInUse(svc.port);
    if (!busy) return { svc, busy: false, alive: false };
    const alive = await ports.isHttpAlive(svc.port, svc.health_path || "/");
    return { svc, busy, alive };
  };

  let tiltUp, tiltPidAlive, portResults, nginxBusy, disk;
  try {
    [tiltUp, tiltPidAlive, portResults, nginxBusy, disk] = await Promise.all([
      tiltApiProbeForDoctor(),
      Promise.resolve(tilt.ourTiltAlive()),
      Promise.all(svcs.filter((s) => s.port).map(portCheck)),   // companions bind no port
      ports.isPortInUse(gatewayPort()),
      diskFreeBytes(YM_ROOT),
    ]);
  } catch (err) {
    step.fail(err.message || String(err));
    throw err;
  }
  step.succeed(`${svcs.length} service(s) probed`);

  // Phase 2 — build sections from the gathered data, then render.
  // The section heading itself goes out AFTER we know the verdict so we
  // can put it in the subtitle ("Doctor — Healthy" vs "Doctor — 1 issue
  // found"). Devs see the verdict before scanning the body.

  const sections = [];
  let totalIssues = 0;
  let totalWarnings = 0;

  // === Toolchain ===
  {
    const items = [];
    const nv = process.versions.node;
    items.push(item("Node", nv, parseInt(nv.split(".")[0], 10) >= 20, "Install Node 20+ via nvm/fnm/nvs"));
    items.push(item("git", "on PATH", commandExists("git"), "Install Git for Windows / brew install git / apt install git"));
    items.push(item("Tilt", "installed", tilt.isInstalled(), "Run `ym setup` — it installs Tilt"));

    // Pinned Node majors: any active service whose services.yaml `node_version`
    // differs from the running Node needs a way to reach that toolchain (fnm,
    // or YM_NPM_NODE<major>). Without it, that service's `npm install` fails —
    // this surfaces the cause before the user hits the build error.
    const { requiredMajor, nodeMajorReachable, CURRENT_MAJOR } =
      await import("./node-runner.js");
    const pinnedMajors = [...new Set(svcs.map(requiredMajor).filter(Boolean))]
      .filter((m) => m !== CURRENT_MAJOR);
    for (const major of pinnedMajors) {
      const reachable = nodeMajorReachable(major);
      items.push(item(
        `Node ${major} (pinned)`,
        reachable ? "reachable (fnm / YM_NPM_NODE)" : "not reachable",
        reachable,
        `Install fnm, or set YM_NPM_NODE${major} — required by services pinned to Node ${major}`,
      ));
    }
    sections.push({
      title: "Toolchain",
      items,
      summary: (passed, total) => `${passed}/${total} installed`,
    });
  }

  // === Configuration ===
  {
    const items = [];
    let yamlOk = true;
    let yamlErr = null;
    try { loadServices(); } catch (e) { yamlOk = false; yamlErr = e.message; }
    items.push(item("services.yaml", "valid", yamlOk, yamlErr));

    items.push(item(
      "Tilt API",
      tiltUp ? `responding on :${tilt.TILT_PORT}` : "not responding (start Tilt first)",
      tiltUp,
      "Run `ym up` to start Tilt",
      { warnOnly: true },     // not running != broken; user may intend it
    ));

    // Active-stack divergence (warn-only)
    const active = presets.activeSelection();
    if (active.stackKey) {
      const def = presets.getPreset(active.stackKey);
      if (def) {
        const sel = new Set(active.services || []);
        const missing = def.services.filter((s) => !sel.has(s));
        const stackItem = item(
          `Stack "${def.label}"`,
          missing.length === 0 ? "in sync" : `selection missing ${missing.length} service(s) the stack now includes`,
          missing.length === 0,
          `Run \`ym stack apply ${active.stackKey}\` to re-sync`,
          { warnOnly: true },
        );
        items.push(stackItem);
      }
    }

    sections.push({
      title: "Configuration",
      items,
      summary: (passed, total) => `${passed}/${total} ok`,
    });
  }

  // === Repositories ===
  {
    const items = svcs.map((svc) => {
      // Companions have no own clone — they're "present" when their source
      // repo is cloned (the source service has its own row above/below).
      if (isCompanion(svc)) {
        const ok = fs.existsSync(path.join(YM_ROOT, svc.source));
        return item(svc.name, ok ? `shares ${svc.source}` : `source ${svc.source} missing`, ok, `ym add ${svc.source}`);
      }
      const exists = fs.existsSync(path.join(YM_ROOT, svc.name));
      return item(svc.name, exists ? "cloned" : "missing", exists, `ym add ${svc.name}`);
    });
    sections.push({
      title: "Repositories",
      items,
      summary: (passed, total) => `${passed}/${total} cloned`,
    });
  }

  // === Env files ===
  // A cloned repo with no .env can't boot under Tilt — and nothing else in
  // doctor would catch it (Repositories only checks the clone exists). This is
  // the diagnostic that explains the "why won't my added service start?"
  // confusion. Only cloned services are checked; missing clones are already
  // flagged in Repositories above.
  {
    const items = svcs
      .filter((svc) => fs.existsSync(path.join(YM_ROOT, svc.name)))
      .map((svc) => {
        const hasEnv = fs.existsSync(path.join(YM_ROOT, svc.name, ".env"));
        return item(`${svc.name} .env`, hasEnv ? "present" : "missing", hasEnv, "ym env");
      });
    sections.push({
      title: "Env files",
      items,
      summary: (passed, total) => `${passed}/${total} present`,
    });
  }

  // === Drift ===
  // Config/state that has silently fallen out of sync. All warn-only — none
  // breaks a running stack, but each explains a "why is X stale?" surprise.
  // `ym doctor --fix` auto-resolves the ym-owned ones (regen + env files).
  {
    const items = [];
    const env = state.getEnv();

    // Generated config (nginx.conf + yardmaster.code-workspace) vs services.yaml.
    const codegen = await import("./codegen.js");
    let codegenStale = false;
    try {
      const nginxPath = path.join(YM_LOCAL, "nginx.conf");
      const wsPath = path.join(YM_ROOT, "yardmaster.code-workspace");
      const diskNginx = fs.existsSync(nginxPath) ? fs.readFileSync(nginxPath, "utf8") : "";
      const diskWs = fs.existsSync(wsPath) ? fs.readFileSync(wsPath, "utf8") : "";
      const wantWs = JSON.stringify(codegen.generateVSCodeWorkspace(), null, 2) + "\n";
      codegenStale = diskNginx !== codegen.generateNginxConf() || diskWs !== wantWs;
    } catch { /* read error → treat as in-sync, don't false-alarm */ }
    items.push(item(
      "Generated config",
      codegenStale ? "stale vs services.yaml" : "in sync",
      !codegenStale,
      "ym regen",
      { warnOnly: true },
    ));

    // .env key drift — a cloned service's .env lacks keys .env.example now has.
    const { envKeyDrift } = await import("./env-compiler.js");
    let drifted = [];
    try { drifted = envKeyDrift(env); } catch { /* ignore */ }
    items.push(item(
      ".env keys",
      drifted.length === 0
        ? "match template"
        : `${drifted.length} service(s) missing keys: ${drifted.map((d) => d.name).join(", ")}`,
      drifted.length === 0,
      "ym env   (regenerates .env — back up local edits first)",
      { warnOnly: true },
    ));

    // ym itself behind origin. Uses the last fetch's refs (no network here),
    // so it reflects staleness as of your last `ym update` / manual fetch.
    if (git.hasOrigin(YM_ROOT)) {
      const behind = git.commitsBehind(YM_ROOT);
      items.push(item(
        "ym version",
        behind && behind > 0 ? `${behind} commit(s) behind origin` : "up to date (since last fetch)",
        !(behind && behind > 0),
        "ym update",
        { warnOnly: true },
      ));
    }

    sections.push({
      title: "Drift",
      items,
      summary: (passed, total) => `${passed}/${total} in sync`,
    });
  }

  // === Ports ===
  {
    const items = [];
    for (const { svc, busy, alive } of portResults) {
      if (!busy) {
        items.push(item(`port ${svc.port} (${svc.name})`, "free / pre-bind", true));
        continue;
      }
      items.push(item(
        `port ${svc.port} (${svc.name})`,
        alive ? "held by our service" : "held by a foreign process",
        alive,
        portConflictFix(svc.port),
      ));
    }

    // nginx gateway port — zombie detection. "Ours" is true if either signal
    // fires: the API answered (tiltUp) OR our PID file points to a live
    // process (tiltPidAlive). Using both avoids a false-zombie verdict when
    // the API probe loses a race against the parallel diagnostics batch.
    if (!nginxBusy) {
      items.push(item(`port ${gatewayPort()} (nginx)`, "free / pre-bind", true));
    } else if (tiltUp || tiltPidAlive) {
      items.push(item(`port ${gatewayPort()} (nginx)`, "held by our Tilt-managed nginx", true));
    } else {
      items.push(item(
        `port ${gatewayPort()} (nginx)`,
        "held by a foreign process (likely a zombie nginx from a previous session)",
        false,
        nginxZombieFix(),
      ));
    }

    sections.push({
      title: "Ports",
      items,
      summary: (passed, total) => `${passed}/${total} healthy`,
    });
  }

  // === System ===
  {
    const items = [];
    let diskSummary = "unknown";
    if (disk == null) {
      items.push(item("Disk space", "unknown", true, null, { warnOnly: true }));
    } else {
      const gb = disk / (1024 ** 3);
      const ok = gb > 2;
      diskSummary = `${gb.toFixed(1)} GB free`;
      items.push(item(
        "Disk space",
        diskSummary,
        ok,
        "Free up at least 2 GB on the project drive",
      ));
    }
    sections.push({
      title: "System",
      items,
      // System has 1 item (disk). Summary shows the value directly instead
      // of "1/1 ok" — more informative at zero extra cost.
      summary: () => diskSummary,
    });
  }

  // === Pre-compute the verdict so it can ride along in the section heading.
  for (const sec of sections) {
    for (const it of sec.items) {
      if (!it.ok && !it.warnOnly) totalIssues++;
      else if (!it.ok && it.warnOnly) totalWarnings++;
    }
  }

  const pl = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  let verdict;
  if (totalIssues === 0 && totalWarnings === 0) {
    verdict = c.green("Healthy");
  } else if (totalIssues === 0) {
    verdict = c.yellow(`${pl(totalWarnings, "warning")}, no failures`);
  } else if (totalWarnings === 0) {
    verdict = c.red(`${pl(totalIssues, "issue")} found`);
  } else {
    verdict = c.red(
      `${pl(totalIssues, "issue")} + ${pl(totalWarnings, "warning")}`,
    );
  }

  // === Render ===
  section("Doctor", verdict);

  // Blank-line rules:
  //   - One blank after the "Doctor — …" heading, before the first section.
  //   - Between sections, a blank ONLY when the previous section was
  //     expanded (had ✗/! items printed below it). Two consecutive
  //     collapsed sections sit on adjacent lines — no empty padding.
  //
  // Result: an all-healthy report is a tight 6-line block; a broken
  // report gets visual breathing room exactly where it's needed.
  let firstSection = true;
  let lastWasExpanded = false;

  for (const sec of sections) {
    const failures = sec.items.filter((it) => !it.ok && !it.warnOnly);
    const warnings = sec.items.filter((it) => !it.ok && it.warnOnly);
    const passed = sec.items.filter((it) => it.ok).length;
    const total = sec.items.length;
    const isExpanded = !(sec.summary && failures.length === 0 && warnings.length === 0);

    if (firstSection || lastWasExpanded) {
      process.stdout.write("\n");
    }
    firstSection = false;

    const headLine = sec.summary
      ? `  ${c.bold(sec.title.padEnd(16))}  ${c.gray(sec.summary(passed, total))}`
      : `  ${c.bold(sec.title)}`;
    process.stdout.write(headLine + "\n");

    if (isExpanded) {
      // Expanded view: only the failing / warning items, never the wall
      // of green. The summary line above already conveyed "passed/total ok."
      for (const it of sec.items.filter((it) => !it.ok)) {
        printItem(it);
      }
    }

    lastWasExpanded = isExpanded;
  }

  // === --fix: auto-resolve the ym-owned issues we can fix safely ===
  // Scope is deliberately narrow: regen stale config, create missing .env
  // files. We do NOT touch foreign
  // processes (port conflicts), clone repos, or overwrite existing .env
  // files (key-drift stays advisory — it'd clobber hand-edits). Anything
  // outside the safe set is left for the user with its printed fix.
  if (wantsFix) {
    process.stdout.write("\n");
    const fixStep = new StepLine("Auto-fix");
    fixStep.start("applying safe fixes");
    const applied = [];

    // 1. Stale generated config → regen.
    try {
      const codegen = await import("./codegen.js");
      const nginxPath = path.join(YM_LOCAL, "nginx.conf");
      const wsPath = path.join(YM_ROOT, "yardmaster.code-workspace");
      const diskNginx = fs.existsSync(nginxPath) ? fs.readFileSync(nginxPath, "utf8") : "";
      const diskWs = fs.existsSync(wsPath) ? fs.readFileSync(wsPath, "utf8") : "";
      const wantWs = JSON.stringify(codegen.generateVSCodeWorkspace(), null, 2) + "\n";
      if (diskNginx !== codegen.generateNginxConf() || diskWs !== wantWs) {
        codegen.writeAll();
        const nginxConfTarget = path.join(YM_LOCAL, "nginx", "conf", "nginx.conf");
        if (fs.existsSync(path.dirname(nginxConfTarget))) {
          fs.copyFileSync(nginxPath, nginxConfTarget);
        }
        applied.push("regenerated nginx.conf + yardmaster.code-workspace");
      }
    } catch (e) { applied.push(`regen skipped (${e.message})`); }

    // 2. Cloned services missing a .env → create them (non-destructive).
    try {
      const { ensureEnvFiles } = await import("./env-compiler.js");
      const created = ensureEnvFiles(state.getEnv()).filter((r) => r.status === "created");
      if (created.length) applied.push(`created ${created.length} missing .env (${created.map((r) => r.name).join(", ")})`);
    } catch (e) { applied.push(`env ensure skipped (${e.message})`); }


    if (applied.length) {
      fixStep.succeed(`${applied.length} fix(es)`);
      for (const a of applied) info(`  ${c.green("✓")} ${a}`);
      nextStep("ym doctor   re-check (remaining issues need manual fixes above)");
      process.exit(0);
    }
    fixStep.succeed("nothing auto-fixable — see the fixes printed above");
  }

  process.exit(totalIssues === 0 ? 0 : 1);
}

// ---- doctor helpers --------------------------------------------------------

function item(label, value, ok, fix, opts = {}) {
  return { label, value, ok, fix, warnOnly: opts.warnOnly === true };
}

function printItem(it) {
  const icon = it.ok
    ? c.green("✓")
    : it.warnOnly ? c.yellow("!") : c.red("✗");
  const labelCol = it.label.padEnd(28);
  process.stdout.write(`    ${icon}  ${labelCol}  ${c.gray(it.value || "")}\n`);
  if (!it.ok && it.fix) {
    process.stdout.write(`       ${c.gray("→ Fix:")}  ${it.fix}\n`);
  }
}

function portConflictFix(port) {
  if (process.platform === "win32") {
    return `Find PID:  netstat -ano | findstr :${port}\n       Then kill: taskkill /F /PID <pid>`;
  }
  return `Find PID:  lsof -i :${port}\n       Then kill: kill -9 <pid>`;
}

// Doctor-only Tilt API probe. The shared tilt.isRunning() uses a 500ms
// timeout — fine for `ym up`'s "is one already running?" precheck but too
// tight when fired alongside 15 TCP probes + a PowerShell disk query in
// Promise.all(). A false negative here cascades into both "Tilt API down"
// AND a bogus "nginx zombie" verdict, so accuracy beats the ~1-3s we trade.
async function tiltApiProbeForDoctor() {
  const snap = await tilt.fetchSnapshot(2500);
  if (snap) return true;
  return (await tilt.fetchSnapshot(2500)) !== null;
}

function nginxZombieFix() {
  const port = gatewayPort();
  if (process.platform === "win32") {
    return `netstat -ano | findstr :${port}   then: taskkill /F /PID <pid>`;
  }
  return `lsof -ti :${port} | xargs kill`;
}

export async function diskFreeBytes(targetDir) {
  try {
    if (process.platform === "win32") {
      const drive = path.parse(targetDir).root.replace(/\\$/, "");  // "C:"
      const r = (await import("./exec.js")).runSync("powershell", [
        "-NoProfile", "-Command",
        `(Get-PSDrive -Name ${drive[0]}).Free`,
      ]);
      const n = parseInt(r.stdout.trim(), 10);
      return Number.isFinite(n) ? n : null;
    }
    // df -k <dir>  (POSIX)
    const r = (await import("./exec.js")).runSync("df", ["-k", targetDir]);
    const lines = r.stdout.split(/\r?\n/);
    const parts = (lines[1] || "").trim().split(/\s+/);
    // Availability is conventionally column 4 (0-indexed 3) in `df -k`.
    const kb = parseInt(parts[3], 10);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// sync <target> — for each cloned repo: stash → switch to <target> → pull
// (ff-only) → switch back to original → restore stash. Designed never to
// lose work (see lib/sync.js for the full safety contract).
// -----------------------------------------------------------------------------
export async function sync(args) {
  let target = args[0];
  if (!target) {
    const picker = await import("./picker.js");
    const currentEnv = state.getEnv();
    target = await picker.pickOneOrType(
      "Sync every cloned repo to which branch?",
      envBranchChoices(),
      {
        // Default to the current env's branch, so `ym sync` is enter-enter.
        default: envBranch(currentEnv),
        otherPrompt: "Branch name:",
        validate: (v) => (v && v.trim().length > 0) || "Branch can't be empty",
        tag: "Sync target",
      },
    );
    target = String(target).trim();
  }

  const { syncAll } = await import("./sync.js");
  const { results } = await syncAll(target);

  if (results.length === 0) {
    info("No cloned repos found. Run `ym setup` first.");
    return;
  }

  // Bucket results for the summary block.
  const synced = results.filter((r) => r.status.startsWith("synced"));
  const conflicts = results.filter((r) => r.status === "conflict");
  const skipped = results.filter((r) => r.status === "skipped");
  const failures = results.filter((r) => r.status === "failed");
  const pullDiverged = results.filter((r) => r.pullWarning);

  // Headline counters
  process.stdout.write("\n");
  const parts = [c.green(`${synced.length} synced`)];
  if (conflicts.length) parts.push(c.red(`${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}`));
  if (failures.length) parts.push(c.red(`${failures.length} failed`));
  if (skipped.length) parts.push(c.gray(`${skipped.length} skipped`));
  process.stdout.write("  " + parts.join("  ·  ") + "\n");

  // Conflicts — these need the user's hands.
  if (conflicts.length) {
    process.stdout.write("\n" + c.bold(c.red("Needs your attention")) + "\n");
    for (const r of conflicts) {
      process.stdout.write(
        `  ${c.red("✗")} ${c.bold(r.repo)}` +
        (r.phase ? c.gray(`  (${r.phase})`) : "") + "\n",
      );
      process.stdout.write(
        `    Stash preserved as ${c.bold(r.stashRef)} ` +
        c.gray(`(message: ${r.stashMessage})`) + "\n",
      );
      process.stdout.write(
        c.gray(
          `    Resolve conflicts in ${r.repo}/, then:  ` +
          `git stash drop ${r.stashRef}\n`,
        ),
      );
    }
  }

  // Failures — repo left in a known but non-success state.
  if (failures.length) {
    process.stdout.write("\n" + c.bold(c.red("Failed")) + "\n");
    for (const r of failures) {
      const reason = String(r.reason || "").split("\n")[0].slice(0, 120);
      process.stdout.write(
        `  ${c.red("✗")} ${r.repo.padEnd(28)} ` +
        c.gray(`${r.phase || "?"}: ${reason}`) + "\n",
      );
      if (r.stashRef) {
        process.stdout.write(
          c.gray(`    Stash preserved as ${r.stashRef} (${r.stashMessage})\n`),
        );
      }
    }
  }

  // Skipped — informational.
  if (skipped.length) {
    process.stdout.write("\n" + c.bold("Skipped") + "\n");
    for (const r of skipped) {
      process.stdout.write(
        `  ${c.yellow("!")} ${r.repo.padEnd(28)} ${c.gray(r.reason)}\n`,
      );
    }
  }

  // Pull-diverged (a repo synced but the target was non-FF-pullable).
  if (pullDiverged.length) {
    process.stdout.write("\n" + c.bold("Pull skipped (local diverged)") + "\n");
    for (const r of pullDiverged) {
      process.stdout.write(`  ${c.yellow("!")} ${r.repo.padEnd(28)} ${c.gray(r.pullWarning)}\n`);
    }
  }

  // Exit non-zero on real failures / conflicts (decision 5).
  if (conflicts.length > 0 || failures.length > 0) {
    process.exit(1);
  }
}

const NODE_MODULE_ERROR_PATTERNS = [
  /MODULE_NOT_FOUND/i,
  /Cannot find module ['"][^'"]+['"]/i,
  /ERR_MODULE_NOT_FOUND/i,
  /ERR_PACKAGE_PATH_NOT_EXPORTED/i,
  /was compiled against a different Node\.js version/i,
  /NODE_MODULE_VERSION/i,
  /The specified module could not be found/i,
  /Could not locate the bindings file/i,
  /Error: \.\.\/build\/(Release|Debug)/i,
];

function hasNodeModuleError(logText) {
  if (!logText) return false;
  return NODE_MODULE_ERROR_PATTERNS.some((pattern) => pattern.test(logText));
}

function computeDepsHash(repoPath) {
  const pkgPath = path.join(repoPath, "package.json");
  const lockPath = path.join(repoPath, "package-lock.json");
  if (!fs.existsSync(pkgPath)) return null;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const depsObj = {
      dependencies: pkg.dependencies || {},
      devDependencies: pkg.devDependencies || {},
      peerDependencies: pkg.peerDependencies || {},
      optionalDependencies: pkg.optionalDependencies || {},
      overrides: pkg.overrides || {},
    };
    const h = crypto.createHash("sha256");
    h.update(JSON.stringify(depsObj));
    if (fs.existsSync(lockPath)) {
      h.update(fs.readFileSync(lockPath));
    }
    return h.digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// deps (alias: install, i) — fast, parallel npm install across active or
// specified microservices.
//
//   ym deps                     Smart check active stack: skips up-to-date
//                               repos in milliseconds, catches Tilt crashes.
//   ym deps <svc> [svc2...]     Install deps in specific service(s)
//   ym deps --all               Run smart check across all cloned repos in services.yaml
//   ym deps --force             Bypass cache and force reinstall across target services
//   ym deps --clean             Run `npm ci` instead of `npm install`
// -----------------------------------------------------------------------------
export async function deps(args = []) {
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(`
${c.bold("ym deps")} [svc...] [--all] [--clean] [--force] [--concurrency=N]

Fast parallel npm install across active or specified services.
Smart caching: checks manifest hashes & Tilt crash logs to skip up-to-date repos.

Options:
  --all, -a        Run smart check across all cloned repos (not just active stack)
  --force, -f      Bypass cache & force install across all target services
  --clean, --ci    Run 'npm ci' instead of 'npm install'
  --concurrency=N  Max concurrent installs (default: 2 on Windows, 3 on POSIX)
  -h, --help       Show this help

Aliases: ym install, ym i
`);
    return;
  }

  const allFlag = args.includes("--all") || args.includes("-a");
  const forceFlag = args.includes("--force") || args.includes("-f");
  const isClean = args.includes("--clean") || args.includes("--ci");

  // Recommendation 3: Default concurrency 2 on Windows to prevent NTFS queue thrashing
  const DEFAULT_CONCURRENCY = process.platform === "win32" ? 2 : 3;
  let concurrency = DEFAULT_CONCURRENCY;
  const concArg = args.find((a) => a.startsWith("--concurrency="));
  if (concArg) {
    const val = parseInt(concArg.split("=")[1], 10);
    if (!isNaN(val) && val > 0) concurrency = val;
  }

  const positionalArgs = args.filter((a) => !a.startsWith("-"));

  let targetSvcs = [];

  if (positionalArgs.length > 0) {
    for (const name of positionalArgs) {
      const svc = byName(name);
      if (!svc) {
        fail(`unknown service: ${name}`);
        process.exit(1);
      }
      const dirName = repoDirOf(svc);
      const repoPath = path.join(YM_ROOT, dirName);
      if (!fs.existsSync(repoPath)) {
        fail(`${name} is not cloned — run \`ym add ${name}\` first.`);
        process.exit(1);
      }
      targetSvcs.push(svc);
    }
  } else if (allFlag) {
    const all = loadServices().services;
    targetSvcs = all.filter((s) => {
      const dirName = repoDirOf(s);
      return fs.existsSync(path.join(YM_ROOT, dirName));
    });
    if (targetSvcs.length === 0) {
      info("No cloned services found. Run `ym setup` first.");
      return;
    }
  } else {
    const active = activeSvcs();
    targetSvcs = active.filter((s) => {
      const dirName = repoDirOf(s);
      return fs.existsSync(path.join(YM_ROOT, dirName));
    });
    if (targetSvcs.length === 0) {
      info("No active cloned services found. Run `ym setup` or `ym add <svc>` first.");
      return;
    }
  }

  // Deduplicate by repository directory to prevent concurrent lock file clashes
  // (e.g. companion workers/mergers sharing a single repo folder)
  const seenPaths = new Set();
  const queue = [];

  for (const svc of targetSvcs) {
    const dirName = repoDirOf(svc);
    const repoPath = path.join(YM_ROOT, dirName);
    const pkgPath = path.join(repoPath, "package.json");

    if (seenPaths.has(repoPath)) continue;
    seenPaths.add(repoPath);

    if (!fs.existsSync(pkgPath)) {
      if (positionalArgs.length > 0) {
        warn(`${svc.name} (${dirName}) has no package.json — skipped.`);
      }
      continue;
    }

    queue.push({
      id: svc.name,
      label: dirName !== svc.name ? `${svc.name} (${dirName})` : svc.name,
      svc,
      repoPath,
      tiltError: false,
      needsInstall: false,
      reason: "",
      currentHash: null,
    });
  }

  if (queue.length === 0) {
    info("No Node.js services with package.json found.");
    return;
  }

  // Tilt diagnostics: check if Tilt is running and if any target service crashed on node modules
  const tiltRunning = await tilt.isRunning();
  const tiltRestartCandidates = new Set();

  if (tiltRunning) {
    const rMap = await tilt.resourceMap();
    for (const item of queue) {
      const tiltName = tilt.toTiltName(item.svc.name);
      const info = rMap[tiltName];
      if (info && (info.runtimeStatus === "error" || info.updateStatus === "error" || Boolean(info.lastBuildError))) {
        const logRes = await run("tilt", ["logs", "--port", String(tilt.TILT_PORT), "--tail", "50", tiltName]);
        const text = (logRes.stdout || "") + "\n" + (logRes.stderr || "");
        if (hasNodeModuleError(text)) {
          item.tiltError = true;
          tiltRestartCandidates.add(item.svc.name);
        }
      }
    }
  }

  // Recommendation 1: Content-hash and cache evaluation
  const repoState = state.getState().repos || {};

  for (const item of queue) {
    const currentHash = computeDepsHash(item.repoPath);
    item.currentHash = currentHash;
    const hasNodeModules = fs.existsSync(path.join(item.repoPath, "node_modules"));
    const recorded = repoState[item.svc.name] || {};
    const recordedHash = recorded.deps_hash;
    const wasInstalled = recorded.installed;

    if (positionalArgs.length > 0) {
      // Explicit positional argument: user explicitly asked to run on this service
      item.needsInstall = true;
      item.reason = "requested";
    } else if (forceFlag) {
      item.needsInstall = true;
      item.reason = "forced";
    } else if (item.tiltError) {
      item.needsInstall = true;
      item.reason = "Tilt crash";
    } else if (!hasNodeModules) {
      item.needsInstall = true;
      item.reason = "missing node_modules";
    } else if (recordedHash && currentHash && recordedHash !== currentHash) {
      item.needsInstall = true;
      item.reason = "dependencies changed";
    } else if (!recordedHash && !wasInstalled) {
      item.needsInstall = true;
      item.reason = "first install";
    } else {
      item.needsInstall = false;
      // Backfill hash if missing so subsequent runs are instant
      if (!recordedHash && currentHash) {
        state.markRepo(item.svc.name, { deps_hash: currentHash, installed: true });
      }
    }
  }

  const toInstall = queue.filter((q) => q.needsInstall);
  const upToDate = queue.filter((q) => !q.needsInstall);

  if (toInstall.length === 0) {
    ok(`All ${queue.length} service(s) are up to date (cached).`);
    info(c.gray("Use 'ym deps --force' to bypass cache and reinstall."));
    return [];
  }

  if (upToDate.length > 0) {
    info(
      `${c.green(upToDate.length)} of ${queue.length} service(s) up to date (cached). ` +
      `Installing ${c.bold(toInstall.length)} service(s)...`,
    );
  }

  // Ensure any required Node majors (e.g. Node 18 via fnm) are installed once up front
  await ensureNodeMajors(toInstall.map((item) => requiredMajor(item.svc)));

  const verb = isClean ? "Clean installing" : "Installing";
  const subcmd = isClean ? "ci" : "install";

  const live = new LiveTable({
    title: `${verb} dependencies for ${toInstall.length} service${toInstall.length === 1 ? "" : "s"} (${subcmd}, concurrency ${concurrency})`,
    items: toInstall.map((q) => ({ id: q.id, label: q.label })),
  });
  live.start();

  const deferredErrors = [];

  const tasks = toInstall.map((item) => async () => {
    const { id, svc, repoPath, currentHash, reason } = item;
    const set = (fields) => live.update(id, fields);

    try {
      set({ state: "running", step: reason ? `queued (${reason})` : "queued" });

      const runner = npmRunnerFor(svc);
      if (runner.error) {
        set({ state: "failed", step: `needs Node ${runner.major} — toolchain unavailable` });
        deferredErrors.push({
          svc: id,
          phase: "node version",
          detail: nodeFixHint(runner.major),
        });
        return { id, ok: false, error: "node-version" };
      }

      const installArgs = [
        ...runner.prefix,
        subcmd,
        "--prefer-offline",
        "--no-audit",
        "--no-fund",
        "--no-progress",
      ];
      if (svc.npm_registry) {
        installArgs.push(`--registry=${svc.npm_registry}`);
      }

      const tags = [];
      if (runner.via) tags.push(`Node ${runner.major} via ${runner.via}`);
      if (svc.npm_registry) tags.push("custom registry");
      set({ step: tags.length ? `${subcmd} (${tags.join(", ")})` : `${subcmd}` });

      let r = await run(runner.cmd, installArgs, { cwd: repoPath });

      // Fallback: if --prefer-offline fails (e.g. ETARGET due to stale cached package metadata),
      // retry once online to fetch fresh packuments/tarballs from the registry.
      if (r.code !== 0 && installArgs.includes("--prefer-offline")) {
        set({ step: `${subcmd} (retrying online)` });
        const onlineArgs = installArgs.filter((a) => a !== "--prefer-offline");
        r = await run(runner.cmd, onlineArgs, { cwd: repoPath });
      }

      if (r.code !== 0) {
        set({ state: "failed", step: `failed (code ${r.code})` });
        deferredErrors.push({
          svc: id,
          phase: `npm ${subcmd}`,
          detail: r.stderr || r.stdout || "(no output)",
        });
        return { id, ok: false, error: "install-failed" };
      }

      state.markRepo(svc.name, { installed: true, deps_hash: currentHash });
      set({ state: "done", step: "installed" });
      return { id, ok: true, svc: svc.name };
    } catch (err) {
      set({ state: "failed", step: err.message || "exception" });
      deferredErrors.push({
        svc: id,
        phase: "exception",
        detail: err.stack || err.message || String(err),
      });
      return { id, ok: false, error: err.message };
    }
  });

  const results = await parallel(tasks, concurrency);
  live.stop();

  const succeeded = results.filter((r) => r.ok && r.value && r.value.ok);
  const failed = results.filter((r) => !r.ok || (r.value && !r.value.ok));

  process.stdout.write("\n");
  const summaryParts = [c.green(`${succeeded.length} installed`)];
  if (upToDate.length) summaryParts.push(c.gray(`${upToDate.length} cached`));
  if (failed.length) summaryParts.push(c.red(`${failed.length} failed`));
  process.stdout.write("  " + summaryParts.join("  ·  ") + "\n");

  if (deferredErrors.length) {
    process.stdout.write("\n");
    for (const e of deferredErrors) {
      fail(`${c.bold(e.svc)} — ${e.phase}`);
      const tail = String(e.detail || "")
        .trim()
        .split("\n")
        .slice(-6)
        .map((l) => `    ${c.gray(l)}`)
        .join("\n");
      if (tail) process.stdout.write(tail + "\n");
    }
  }

  // Auto-restart any revived services in Tilt
  if (tiltRunning && succeeded.length > 0 && tiltRestartCandidates.size > 0) {
    const restartList = succeeded.filter((r) => tiltRestartCandidates.has(r.value?.svc));
    if (restartList.length > 0) {
      process.stdout.write("\n");
      for (const r of restartList) {
        const svcName = r.value.svc;
        const code = await tilt.restart(svcName);
        if (code === 0) {
          ok(`Restarted ${c.bold(svcName)} in Tilt`);
        }
      }
    }
  }

  return results;
}

export const install = deps;

// -----------------------------------------------------------------------------
// add [service...] — clone + install + add one or more services ad hoc.
//
//   ym add foo                Adds foo
//   ym add foo bar baz        Clones foo, bar, baz in parallel; one regen,
//                             one Tilt restart at the end. Way better than
//                             three separate `ym add` invocations.
//   ym add                    Interactive multi-select of un-cloned services.
// -----------------------------------------------------------------------------
export async function add(args) {
  let names = args.filter((a) => !a.startsWith("--"));   // positionals only

  if (names.length === 0) {
    const picker = await import("./picker.js");
    const candidates = loadServices().services.filter(
      (s) => s.repo && !fs.existsSync(path.join(YM_ROOT, s.name)),
    );
    if (candidates.length === 0) {
      info("Every service in services.yaml is already cloned.");
      return;
    }
    names = await picker.pickMany(
      "Pick service(s) to add:",
      candidates.map((s) => ({
        value: s.name,
        label: s.name,
        description: `port ${s.port}`,
      })),
      { tag: "Services to add", pageSize: 20 },
    );
  }

  // Resolve names → service definitions. Fail-fast on any unknown name so
  // the user doesn't sit through 14 successful clones only to discover a
  // typo on the 15th.
  const services = [];
  for (const name of names) {
    const svc = byName(name);
    if (!svc) {
      fail(`unknown service: ${name} — add it to services.yaml first`);
      process.exit(1);
    }
    // Companions (source:) have no repo of their own — that's fine, they just
    // get added to the selection so Tilt registers them. provisionRepos skips
    // them. Only a service that's neither clonable nor a companion is an error.
    if (!svc.repo && !isCompanion(svc)) {
      fail(`${name} has no repo URL in services.yaml`);
      process.exit(1);
    }
    services.push(svc);
  }

  if (services.length === 0) {
    info("No services selected.");
    return;
  }

  // Provision all in parallel via the existing repos helper. provisionRepos
  // already handles bounded concurrency, idempotent re-clones (skips if the
  // folder exists), and parallel npm-install.
  const { provisionRepos } = await import("./repos.js");
  await provisionRepos(services, { concurrency: 4, env: state.getEnv() });

  // Generate a .env for every freshly-cloned service. Tilt can't boot a
  // service without one, and a clone arrives without it — this was the gap
  // that left `ym add`ed services silently unable to start until a manual
  // `ym env`. Create-only: ensureEnvFiles never clobbers an existing or
  // hand-edited .env, so re-adding / adding alongside existing repos is safe.
  {
    const { StepLine } = await import("./live.js");
    const { ensureEnvFiles } = await import("./env-compiler.js");
    const envStep = new StepLine("Environment files");
    envStep.start(`ensuring .env for '${state.getEnv()}'`);
    const envResults = ensureEnvFiles(state.getEnv());
    const created = envResults.filter((r) => r.status === "created").length;
    const present = envResults.filter((r) => r.status === "present").length;
    const parts = [];
    if (created) parts.push(`${created} created`);
    if (present) parts.push(`${present} already present`);
    envStep.succeed(parts.join(", ") || "nothing to do");
  }

  // Plumb each into the active selection so Tilt's --only filter registers
  // them. Without this, the clones land on disk but Tilt never starts them.
  const addedNames = [];
  for (const svc of services) {
    if (presets.addToSelection(svc.name)) addedNames.push(svc.name);
  }
  if (addedNames.length) {
    info(`Added to active selection: ${addedNames.join(", ")}`);
  }

  await regen();
  ok(`${services.length} service(s) ready`);

  // Tilt's --only filter is frozen at startup, so a running Tilt won't
  // see the new services until it's bounced.
  const subj = services.length === 1 ? services[0].name : `${services.length} service(s)`;
  const restart = await restartTiltIfRunning({ suffix: `${subj} now registered` });
  if (!restart.restarted) {
    nextStep("ym up   start them");
  }
}

// -----------------------------------------------------------------------------
// remove [service...] [--purge] — opposite of `ym add`.
//
//   Drops services from the active selection so they're not part of the
//   running stack. The clone stays on disk by default (fast re-add); pass
//   --purge to also delete the clone directory.
//
//   ym remove foo                  Drop foo
//   ym remove foo bar              Drop both
//   ym remove                      Interactive multi-select from active set
//   ym remove foo --purge          Drop AND rm -rf foo/ (with confirmation)
// -----------------------------------------------------------------------------
export async function remove(args) {
  const purge = args.includes("--purge");
  let names = args.filter((a) => !a.startsWith("--"));

  if (names.length === 0) {
    const picker = await import("./picker.js");
    // Universe = anything cloned on disk, not just the active stack.
    // Mirrors pickClonedService(): clones brought in by `ym add` and then
    // left behind when the user switched stacks are legitimate removal
    // targets (they only show up here and in --purge can be cleaned up).
    const cloned = loadServices().services.filter((s) =>
      fs.existsSync(path.join(YM_ROOT, s.name)),
    );
    if (cloned.length === 0) {
      info("No cloned services on disk — nothing to remove.");
      return;
    }
    const activeNames = new Set(presets.activeServiceNames());
    // Active first, orphans below, alphabetical within each group — the
    // visual break makes "stack member vs leftover clone" obvious without
    // needing a separate UI element.
    const sorted = [
      ...cloned.filter((s) => activeNames.has(s.name)).sort((a, b) => a.name.localeCompare(b.name)),
      ...cloned.filter((s) => !activeNames.has(s.name)).sort((a, b) => a.name.localeCompare(b.name)),
    ];
    names = await picker.pickMany(
      "Pick service(s) to remove:",
      sorted.map((s) => ({
        value: s.name,
        label: activeNames.has(s.name)
          ? s.name
          : `${s.name}  ${c.gray("(orphan — not in active stack)")}`,
        description: `port ${s.port}`,
      })),
      { tag: "Services to remove", pageSize: 20 },
    );
  }

  // Validate names: must exist in services.yaml (catches typos before any work).
  const services = [];
  for (const name of names) {
    const svc = byName(name);
    if (!svc) {
      fail(`unknown service: ${name}`);
      process.exit(1);
    }
    services.push(svc);
  }

  if (services.length === 0) {
    info("No services selected.");
    return;
  }

  // Split picks. In-stack picks drop from the active selection; orphan
  // picks only have meaning under --purge (removing them from the stack
  // is a silent no-op since they weren't there to begin with).
  const activeNames = new Set(presets.activeServiceNames());
  const inStack = services.filter((s) => activeNames.has(s.name));
  const orphans = services.filter((s) => !activeNames.has(s.name));

  const droppedNames = [];
  for (const svc of inStack) {
    if (presets.removeFromSelection(svc.name)) droppedNames.push(svc.name);
  }
  if (droppedNames.length) {
    info(`Removed from active stack: ${droppedNames.join(", ")}`);
  }

  if (orphans.length > 0 && !purge) {
    warn(
      `${orphans.length} pick(s) aren't in your active stack — they only exist as a clone on disk: ${orphans.map((s) => s.name).join(", ")}`,
    );
    nextStep(`Re-run with --purge to delete the clone director${orphans.length === 1 ? "y" : "ies"}.`);
  }

  // Optional --purge: delete the clone directories with a single confirmation.
  if (purge) {
    const picker = await import("./picker.js");
    const cloned = services.filter((s) =>
      fs.existsSync(path.join(YM_ROOT, s.name)),
    );
    if (cloned.length === 0) {
      info("--purge: nothing to delete (none of these are cloned).");
    } else {
      const confirm = await picker.askConfirm(
        `--purge: delete ${cloned.length} clone director${cloned.length === 1 ? "y" : "ies"}?\n` +
        `  ${cloned.map((s) => path.join(YM_ROOT, s.name)).join("\n  ")}\n` +
        `This cannot be undone.`,
        { default: false },
      );
      if (confirm) {
        for (const svc of cloned) {
          const repoPath = path.join(YM_ROOT, svc.name);
          fs.rmSync(repoPath, { recursive: true, force: true });
          ok(`Purged ${repoPath}`);
        }
      } else {
        info("Purge canceled — clone directories preserved.");
      }
    }
  }

  // Nothing else to do if the active selection didn't actually change
  // (orphan-only picks, or picks that were already absent). Skip regen
  // and Tilt restart — neither would observe any change.
  if (droppedNames.length === 0) return;

  await regen();

  // Bounce Tilt if running so the dropped services actually disappear.
  const subj = droppedNames.length === 1 ? droppedNames[0] : `${droppedNames.length} service(s)`;
  const restart = await restartTiltIfRunning({ suffix: `${subj} now removed` });
  if (!restart.restarted) {
    nextStep("ym up   restart with the updated selection");
  }
}

// -----------------------------------------------------------------------------
// stack — unified named configurations of the dev environment.
// Replaces the old `ym preset` (built-in service sets) and `ym profile`
// (per-repo branch snapshots). A stack captures BOTH services and branches
// (and optional env), so switching contexts is one command.
//
//   ym stack [show]            Show current state
//   ym stack list              List all stacks (built-in + user-saved)
//   ym stack apply [name]      Switch to a stack (picker if name omitted)
//   ym stack save [name]       Snapshot current state (prompts for name)
//   ym stack delete [name]     Remove a user-saved stack
//
// Apply semantics (β): no prompts. Switching a stack just overwrites
// current state. Dirty repos are skipped (use `ym stack apply <name>`
// after committing/discarding, or extend later with a --stash flag).
// -----------------------------------------------------------------------------
export async function stack(args) {
  const sub = args[0] || "show";

  if (sub === "list" || sub === "ls") {
    return stackList();
  }
  if (sub === "show") {
    return stackShow();
  }
  if (sub === "apply") {
    return stackApply(args[1]);
  }
  if (sub === "create" || sub === "new") {
    return stackCreate(args.slice(1));
  }
  if (sub === "edit") {
    return stackEdit(args.slice(1));
  }
  if (sub === "save") {
    return stackSave(args.slice(1));
  }
  if (sub === "delete" || sub === "rm") {
    return stackDelete(args[1]);
  }

  fail("Usage: ym stack <list|show|apply|create|edit|save|delete> [name]");
  process.exit(1);
}

function stackList() {
  const list = stacks.listStacks();
  const current = presets.activeSelection().stackKey;

  if (list.length === 0) {
    info("No stacks defined.");
    return;
  }

  const rows = list.map((s) => {
    const marker = s.key === current ? c.green("●") : " ";
    const kind = s.kind === "built-in" ? c.gray("built-in") : c.cyan("user");
    const env = s.env ? s.env : "—";
    const saved = s.saved_at ? s.saved_at.slice(0, 10) : "—";
    return [marker, c.bold(s.key), kind, String(s.count), env, saved];
  });
  table(rows, ["", "NAME", "KIND", "SERVICES", "ENV", "SAVED"]);
}

function stackShow() {
  const snap = stacks.currentSnapshot();
  const active = presets.activeSelection();

  let label;
  if (active.stackKey) {
    const p = presets.getPreset(active.stackKey);
    label = `built-in: ${c.bold(p.label)} (${p.key})`;
  } else if (snap.userStackKey) {
    label = `user stack: ${c.bold(snap.userStackKey)}`;
  } else if (active.services && active.services.length) {
    label = c.bold("custom selection");
  } else {
    const def = presets.defaultPresetKey();
    label = `default fallback: ${c.bold(def)}`;
  }
  section("Stack", c.gray(`${label} · env=${snap.env}`));
  process.stdout.write("\n");

  const rows = snap.services.map((svc) => [
    c.bold(svc),
    snap.branches[svc] || c.gray("not cloned"),
  ]);
  table(rows, ["SERVICE", "BRANCH"]);
}

async function stackApply(nameArg) {
  let name = nameArg;
  if (!name) {
    const picker = await import("./picker.js");
    const all = stacks.listStacks();
    if (all.length === 0) {
      fail("No stacks defined.");
      process.exit(1);
    }
    name = await picker.pickOne(
      "Apply which stack?",
      all.map((s) => ({
        value: s.key,
        label: `${s.key}  ` + c.gray(`(${s.kind}, ${s.count} services)`),
        description: s.description || undefined,
      })),
      {
        default: presets.activeSelection().stackKey,
        tag: "Stack",
        pageSize: 20,
      },
    );
  }

  const stk = stacks.getStack(name);
  if (!stk) {
    fail(`unknown stack: ${name}`);
    process.exit(1);
  }

  try {
    const result = await stacks.applyStack(name);
    ok(`Stack "${name}" applied — ${result.services.length} service(s).`);

    // If the stack captured an env, regen env files to match. Do this
    // before the Tilt restart so the new env is in place when Tilt comes
    // back up.
    if (result.envApplied) {
      process.stdout.write("\n");
      await env([result.envApplied]);
    }

    // Regenerate nginx.conf + yardmaster.code-workspace so they reflect the new
    // selection. Must happen even if Tilt isn't running — `ym up` later
    // reads the generated nginx config, and VS Code reads the workspace
    // file right now. Mirrors what `ym add` / `ym remove` do.
    await regen();

    // If any services in the new stack aren't cloned, we can't even attempt
    // to run them yet — surface that and skip the auto-restart.
    const missing = result.services.filter(
      (n) => !fs.existsSync(path.join(YM_ROOT, n)),
    );
    if (missing.length > 0) {
      nextStep(`${missing.length} service(s) need cloning — run \`ym add ${missing.join(" ")}\` or \`ym setup\`.`);
      return;
    }

    // Auto-restart Tilt if it's running so the new selection takes effect.
    const restart = await restartTiltIfRunning({ suffix: `stack "${name}" applied` });
    if (!restart.restarted) {
      nextStep("ym up   start the active stack");
    }
  } catch (err) {
    fail(err.message);
    process.exit(1);
  }
}

async function stackSave(args) {
  const picker = await import("./picker.js");

  const flags = parseStackFlags(args, ["--with-branches", "--with-env"]);
  const withBranches = flags.has("--with-branches");
  const withEnv = flags.has("--with-env");
  let name = args.find((a) => !a.startsWith("--"));

  if (!name) {
    const defaultName = `stack-${new Date().toISOString().slice(0, 10)}`;
    name = await picker.askText("Save current stack as:", {
      default: defaultName,
      validate: (v) => {
        if (!v || !v.trim()) return "Name can't be empty";
        if (stacks.isBuiltIn(v.trim())) {
          return `'${v}' is a built-in stack — pick a different name`;
        }
        return true;
      },
      tag: "Stack name",
    });
    name = name.trim();
  }

  // If a user-saved stack with this name already exists, confirm overwrite.
  // (Re-save is the supported way to flip between template / snapshot
  // flavors, so we don't pre-judge it — just confirm intent.)
  if (stacks.userStackExists(name)) {
    const overwrite = await picker.askConfirm(
      `Stack "${name}" exists. Overwrite?`,
      { default: false },
    );
    if (!overwrite) {
      info("Canceled.");
      return;
    }
  }

  try {
    const saved = stacks.saveStack(name, { withBranches, withEnv });
    const branchCount = saved.branches ? Object.keys(saved.branches).length : 0;
    const parts = [`${saved.services.length} service(s)`];
    if (branchCount) parts.push(`${branchCount} branch(es)`);
    if (saved.env) parts.push(`env=${saved.env}`);
    ok(`Saved stack "${name}" — ${parts.join(", ")}`);
    if (!withBranches && !withEnv) {
      nextStep(`Template-only. Add --with-branches and/or --with-env to capture more.`);
    }
  } catch (err) {
    fail(err.message);
    process.exit(1);
  }
}

// ---- create / edit (decoupled from active state) --------------------------

async function stackCreate(args) {
  const picker = await import("./picker.js");

  const fromIdx = args.indexOf("--from");
  const fromName = fromIdx !== -1 ? args[fromIdx + 1] : null;
  // Positional name = first non-flag arg that ISN'T the value of --from.
  // (When --from is absent, fromIdx is -1, so we must skip the exclusion.)
  let name = args.find(
    (a, i) => !a.startsWith("--") && (fromIdx === -1 || i !== fromIdx + 1),
  );

  if (!name) {
    name = await picker.askText("Name for the new stack:", {
      validate: (v) => {
        if (!v || !v.trim()) return "Name can't be empty";
        const n = v.trim();
        if (stacks.isBuiltIn(n)) return `'${n}' is a built-in stack — pick a different name`;
        if (stacks.userStackExists(n)) return `Stack "${n}" exists — use \`ym stack edit ${n}\` to modify`;
        return true;
      },
      tag: "Stack name",
    });
    name = name.trim();
  }

  if (stacks.isBuiltIn(name)) {
    fail(`'${name}' is a built-in stack — pick a different name`);
    process.exit(1);
  }
  if (stacks.userStackExists(name)) {
    fail(`Stack "${name}" already exists. Use \`ym stack edit ${name}\` to modify, or \`ym stack delete ${name}\` first.`);
    process.exit(1);
  }

  // Pre-check resolution:
  //   --from <stack>     : explicit, skip the prompt
  //   interactive        : pickStartingPoint prompt (user stacks included
  //                        so you can fork your own snapshots too)
  //
  // Forks at creation either way — no live link to the source stack.
  let preChecked = new Set();
  let sourceLabel = null;
  if (fromName) {
    const src = stacks.getStack(fromName);
    if (!src) {
      fail(`unknown stack: ${fromName}`);
      process.exit(1);
    }
    preChecked = new Set(src.services);
    sourceLabel = fromName;
  } else {
    preChecked = await pickStartingPoint({ includeUserStacks: true });
    // pickStartingPoint returns an empty set for the "Blank" option; we
    // don't track which non-blank option was chosen here, so the multi-
    // select prompt's "starting from X" label is reserved for --from.
  }

  const all = loadServices().services;
  const picked = await picker.pickMany(
    sourceLabel
      ? `Pick services for "${name}" (starting from ${sourceLabel}):`
      : `Pick services for "${name}":`,
    all.map((s) => ({
      value: s.name,
      label: s.name,
      description: s.port ? `port ${s.port}` : undefined,
      checked: preChecked.has(s.name),
    })),
    { pageSize: 20, tag: "Services" },
  );

  if (!picked.length) {
    fail("No services selected — stack not created");
    process.exit(1);
  }

  try {
    stacks.createStack(name, picked);
    ok(`Created stack "${name}" — ${picked.length} service(s) (template).`);
    nextStep(`Apply with \`ym stack apply ${name}\`.`);
  } catch (err) {
    fail(err.message);
    process.exit(1);
  }
}

async function stackEdit(args) {
  const picker = await import("./picker.js");

  let name = args.find((a) => !a.startsWith("--"));

  if (!name) {
    const userStacks = stacks.listStacks().filter((s) => s.kind === "user");
    if (userStacks.length === 0) {
      info("No user-saved stacks to edit. Create one with `ym stack create <name>`.");
      return;
    }
    name = await picker.pickOne(
      "Edit which stack?",
      userStacks.map((s) => ({
        value: s.key,
        label: s.key,
        description: `${s.count} service(s)`,
      })),
      { tag: "Stack to edit" },
    );
  }

  if (stacks.isBuiltIn(name)) {
    fail(
      `'${name}' is a built-in stack — built-ins live in services.yaml.\n` +
      `Copy first: \`ym stack create <new-name> --from ${name}\``,
    );
    process.exit(1);
  }
  if (!stacks.userStackExists(name)) {
    fail(`no such user-saved stack: ${name}`);
    process.exit(1);
  }

  const existing = stacks.getStack(name);
  const preChecked = new Set(existing.services);

  const all = loadServices().services;
  const picked = await picker.pickMany(
    `Edit "${name}" — toggle services:`,
    all.map((s) => ({
      value: s.name,
      label: s.name,
      description: s.port ? `port ${s.port}` : undefined,
      checked: preChecked.has(s.name),
    })),
    { pageSize: 20, tag: "Services" },
  );

  if (!picked.length) {
    fail("No services selected — stack not updated");
    process.exit(1);
  }

  try {
    const updated = stacks.editStack(name, picked);
    const branchCount = updated.branches ? Object.keys(updated.branches).length : 0;
    const parts = [`${updated.services.length} service(s)`];
    if (branchCount) parts.push(`${branchCount} branch(es) preserved`);
    ok(`Updated stack "${name}" — ${parts.join(", ")}.`);

    // Lineage feedback: tell the user whether their running selection moved.
    if (updated.activeRefreshed) {
      info(`Active selection refreshed (you're currently on this stack).`);
      // Selection changed → regenerate nginx.conf + yardmaster.code-workspace so
      // they don't drift. Same ordering as `ym add` / `ym remove`.
      await regen();
      const restart = await restartTiltIfRunning({ suffix: `stack "${name}" refreshed` });
      if (!restart.restarted) {
        nextStep(`ym up   start the active stack`);
      }
    } else if (updated.divergedFromActive) {
      warn(
        `You're currently on "${name}", but your selection has drifted from\n` +
        `  the stack's previous contents (likely from \`ym add\` or \`ym remove\`).\n` +
        `  Did NOT auto-refresh — your running selection is unchanged.`,
      );
      nextStep(`ym stack apply ${name}   discard drift and reset selection to the edited stack`);
    }
  } catch (err) {
    fail(err.message);
    process.exit(1);
  }
}

// Helper for parsing recognized boolean flags out of an args array. Returns
// a Set of the flags that were present. Unrecognized --flags are ignored
// (positional consumers handle them).
function parseStackFlags(args, known) {
  const found = new Set();
  for (const a of args) {
    if (known.includes(a)) found.add(a);
  }
  return found;
}

async function stackDelete(nameArg) {
  const picker = await import("./picker.js");

  let name = nameArg;
  if (!name) {
    const all = stacks.listStacks().filter((s) => s.kind === "user");
    if (all.length === 0) {
      info("No user-saved stacks to delete.");
      return;
    }
    name = await picker.pickOne(
      "Delete which stack?",
      all.map((s) => ({
        value: s.key,
        label: s.key,
        description: s.saved_at ? `saved ${s.saved_at.slice(0, 19)}` : undefined,
      })),
      { tag: "Stack to delete" },
    );
  }

  if (stacks.isBuiltIn(name)) {
    fail(`'${name}' is a built-in stack — cannot delete`);
    process.exit(1);
  }

  const confirm = await picker.askConfirm(
    `Delete stack "${name}"?`,
    { default: false },
  );
  if (!confirm) {
    info("Canceled.");
    return;
  }

  try {
    stacks.deleteStack(name);
    ok(`Deleted stack "${name}".`);
  } catch (err) {
    fail(err.message);
    process.exit(1);
  }
}

// -----------------------------------------------------------------------------
// init — interactive preset/custom picker. Not a public CLI command — only
// called internally by setup.js on first run (when .ym/state.json has no
// saved selection yet). For later tier changes, use `ym stack apply`.
// -----------------------------------------------------------------------------
export async function init() {
  section("First-run setup", c.gray("pick a stack"));

  const list = presets.listPresets();
  const defaultKey = presets.defaultPresetKey();

  if (list.length === 0) {
    fail("No stacks defined in services.yaml");
    process.exit(1);
  }

  const picker = await import("./picker.js");

  // Stage 1: pick a preset or Custom
  const CUSTOM = "__custom__";
  const tierChoices = list.map((p) => ({
    value: p.key,
    label:
      `${p.label}  ` +
      c.gray(`${p.count} services · ${presets.formatDuration(presets.estimateBootstrapSeconds(p.count))}`),
    description: p.description.replace(/\s+/g, " "),
  }));
  tierChoices.push({
    value: CUSTOM,
    label: c.bold("Custom") + c.gray("  pick individual services by name"),
    description: "Multi-select all services. Optionally start from a built-in stack.",
  });

  const tierChoice = await picker.pickOne("Pick a stack:", tierChoices, {
    default: defaultKey,
    pageSize: tierChoices.length,
    tag: "Stack selection",
  });

  if (tierChoice !== CUSTOM) {
    const stk = list.find((p) => p.key === tierChoice);
    presets.applyPreset(stk.key);
    ok(`Stack "${stk.label}" applied — ${stk.count} service(s).`);
    nextStep(`Run \`ym setup\` to provision them, or \`ym stack apply <name>\` to switch later.`);
    return;
  }

  await pickCustom();
}

async function pickCustom() {
  const picker = await import("./picker.js");
  const all = loadServices().services;     // all services, including disabled

  // Stage 2a: pick a starting point so the common "essentials + a few extras"
  // workflow is two keystrokes (enter → space → enter). User stacks aren't
  // listed here because pickCustom runs during first-run setup, before any
  // exist.
  const startingSet = await pickStartingPoint({ includeUserStacks: false });

  // Stage 2b: multi-select with the starting point pre-checked.
  const picked = await picker.pickMany(
    "Toggle services with <space>, confirm with <enter>:",
    all.map((s) => ({
      value: s.name,
      label: s.name,
      description: s.port ? `port ${s.port}` : undefined,
      checked: startingSet.has(s.name),
    })),
    {
      pageSize: 20,
      tag: "Custom selection",
    },
  );

  if (picked.length === 0) {
    fail("No services selected");
    process.exit(1);
  }

  presets.applyCustomSelection(picked);
  ok(`Custom selection saved — ${picked.length} service(s).`);
  info(`Run \`ym setup\` to provision them.`);
}

// Prompt the user for a starting point for a service-multi-select, and
// return a Set<service-name> to pre-check.
//
// Options shown:
//   - every built-in stack (essentials / everything / ...)
//   - every user-saved stack, if includeUserStacks
//   - "Blank" — returns an empty Set
//
// Used by pickCustom (first-run setup, built-ins only) and by stackCreate
// (when --from wasn't passed on the CLI; user stacks included so you can
// fork from your own snapshots too).
async function pickStartingPoint({ includeUserStacks = false, tag = "Starting point" } = {}) {
  const picker = await import("./picker.js");

  const builtIns = presets.listPresets().map((p) => ({
    value: p.key,
    label: `${p.label}  ` + c.gray(`(${p.count} pre-checked)`),
  }));

  const userOptions = includeUserStacks
    ? stacks.listStacks()
        .filter((s) => s.kind === "user")
        .map((s) => ({
          value: s.key,
          label: `${s.key}  ` + c.gray(`(${s.count} pre-checked · user)`),
        }))
    : [];

  const choices = [
    ...builtIns,
    ...userOptions,
    { value: "__blank__", label: c.gray("Blank  (start with nothing checked)") },
  ];

  const key = await picker.pickOne("Start your selection from:", choices, { tag });
  if (key === "__blank__") return new Set();

  const src = stacks.getStack(key);
  return new Set(src?.services ?? []);
}

// (the old `preset` and `profile` commands moved to `stack` — see above)

function prompt(message) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, (ans) => {
      rl.close();
      resolve(ans);
    });
  });
}

// -----------------------------------------------------------------------------
// completion — install or emit a shell-completion script.
//
//   ym completion                  Auto-detect your shell and show how to install
//   ym completion install [shell]  Write the script + add a source line to your
//                                  shell's rc file. Detected if not specified.
//                                  Idempotent — safe to re-run.
//   ym completion <shell>          Print the raw script to stdout (legacy form,
//                                  for users who want full control).
// -----------------------------------------------------------------------------
const COMPLETION_SCRIPTS = {
  bash:       "ym-complete.bash",
  zsh:        "ym-complete.zsh",
  pwsh:       "ym-complete.ps1",
  powershell: "ym-complete.ps1",
};

export async function completion(args) {
  const sub = args[0];

  if (sub === "install") {
    return completionInstall(args[1] || null);
  }

  // Explicit shell → output script to stdout (back-compat for power users).
  if (sub && COMPLETION_SCRIPTS[sub]) {
    const file = path.join(TOOL_ROOT, "scripts", COMPLETION_SCRIPTS[sub]);
    process.stdout.write(fs.readFileSync(file, "utf8"));
    return;
  }

  // No args (or unknown) → auto-detect shell + suggest the install command.
  completionHelp();
}

// Detect the user's shell from env-var heuristics. Returns "bash" / "zsh" /
// "pwsh" / null. Not perfect but good enough on every supported platform.
//
// Order matters: $SHELL is checked first because PSModulePath is set on
// Windows in general (inherited by Git Bash from the Windows session), so
// checking PSModulePath first would mis-detect Git Bash as PowerShell.
//
// Exported so setup.js can use the same detection to offer the optional
// tab-completion install at the end of `ym setup`.
export function detectShell() {
  // POSIX-ish: $SHELL is the user's login shell. On Git Bash for Windows
  // it's "/usr/bin/bash" or similar — distinguishable from pwsh, which
  // doesn't set $SHELL at all.
  if (process.env.SHELL) {
    const sh = process.env.SHELL.toLowerCase();
    if (sh.includes("zsh")) return "zsh";
    if (sh.includes("bash")) return "bash";
  }

  // PowerShell: PSModulePath is the canonical marker. Reaching this means
  // $SHELL was either unset or unrecognized, so we trust PSModulePath as
  // the "definitely pwsh" signal.
  if (process.env.PSModulePath) return "pwsh";

  return null;
}

function completionHelp() {
  const detected = detectShell();

  process.stdout.write("\n");
  if (detected) {
    info(`Detected shell: ${c.bold(detected)}`);
    process.stdout.write("\n");
    info("Install with one command:");
    process.stdout.write(`  ${c.bold("ym completion install")}\n`);
    process.stdout.write("\n");
    info(c.gray("Or output the raw script and install it yourself:"));
    process.stdout.write(c.gray(`  ym completion ${detected} > <somewhere>\n`));
    return;
  }

  info("Couldn't auto-detect your shell.");
  process.stdout.write("\n");
  info("Install for a specific shell:");
  process.stdout.write(`  ${c.bold("ym completion install bash")}\n`);
  process.stdout.write(`  ${c.bold("ym completion install zsh")}\n`);
  process.stdout.write(`  ${c.bold("ym completion install pwsh")}\n`);
  process.stdout.write("\n");
  info(c.gray("CMD on Windows isn't supported — its completion API can't handle this."));
}

// ym completion install [shell] — auto-write the script + append a source
// line to the user's rc/profile. Asks for confirmation. Idempotent.
async function completionInstall(shellOverride) {
  const picker = await import("./picker.js");

  const shell = resolveShellOrExit(shellOverride);
  const plan = computeInstallTargets(shell);

  // Show the user exactly what we're about to do.
  process.stdout.write("\n");
  info(c.bold("ym completion install"));
  info(`  shell:    ${shell}`);
  info(`  script:   ${plan.scriptPath}`);
  info(`  profile:  ${plan.profilePath}`);
  process.stdout.write("\n");

  const proceed = await picker.askConfirm("Proceed?", { default: true });
  if (!proceed) {
    info("Canceled.");
    return;
  }

  const result = performInstall(plan);
  ok(`Wrote ${plan.scriptPath}`);
  if (result.sourceAlreadyPresent) {
    info(`Source line already present in ${plan.profilePath}`);
  } else {
    ok(`Appended source line to ${plan.profilePath}`);
  }

  process.stdout.write("\n");
  ok("Completion installed.");
  info(`To activate now, run:  ${c.bold(plan.activateCmd)}`);
  info(`Or just restart your terminal.`);
}

// Shared: validate + resolve a shell name, exiting with a clear error
// rather than throwing if invalid.
function resolveShellOrExit(shellOverride) {
  let shell = shellOverride || detectShell();
  if (!shell) {
    fail("Couldn't detect your shell.");
    info("Pass it explicitly:  ym completion install <bash|zsh|pwsh>");
    process.exit(1);
  }
  shell = shell === "powershell" ? "pwsh" : shell;
  if (!["bash", "zsh", "pwsh"].includes(shell)) {
    fail(`Unsupported shell: ${shell}. Use bash, zsh, or pwsh.`);
    process.exit(1);
  }
  return shell;
}

// Read-only check: is the completion source line already in the user's rc
// file? Used by setup.js to skip the install prompt on re-runs. Returns
// null if the shell is unsupported / the profile file doesn't exist.
export function isCompletionAlreadyInstalled(shell) {
  if (!shell || !["bash", "zsh", "pwsh", "powershell"].includes(shell)) return null;
  const normalized = shell === "powershell" ? "pwsh" : shell;
  let plan;
  try {
    plan = computeInstallTargets(normalized);
  } catch {
    return null;
  }
  if (!fs.existsSync(plan.profilePath)) return false;
  const rc = fs.readFileSync(plan.profilePath, "utf8");
  return rc.includes(plan.sourceLine);
}

// Run the actual install (no prompt, no logging). Used by setup.js after
// its outer "Install tab-completion?" prompt, and by completionInstall
// after its own confirm. Returns { scriptWritten, sourceAlreadyPresent,
// sourceAppended, plan }.
export function performCompletionInstall(shell) {
  const normalized = shell === "powershell" ? "pwsh" : shell;
  if (!["bash", "zsh", "pwsh"].includes(normalized)) {
    throw new Error(`Unsupported shell: ${shell}`);
  }
  const plan = computeInstallTargets(normalized);
  const result = performInstall(plan);
  return { plan, ...result };
}

// Lower-level: given a fully-resolved plan, do the filesystem writes.
function performInstall(plan) {
  // Write the script (overwrite so re-running picks up upstream changes).
  fs.mkdirSync(path.dirname(plan.scriptPath), { recursive: true });
  fs.writeFileSync(plan.scriptPath, plan.scriptContent, "utf8");

  // Append the source line if not already present (idempotent).
  let rcContent = "";
  if (fs.existsSync(plan.profilePath)) {
    rcContent = fs.readFileSync(plan.profilePath, "utf8");
  } else {
    fs.mkdirSync(path.dirname(plan.profilePath), { recursive: true });
  }

  const sourceAlreadyPresent = rcContent.includes(plan.sourceLine);
  if (!sourceAlreadyPresent) {
    const sep = rcContent && !rcContent.endsWith("\n") ? "\n" : "";
    const block =
      sep +
      "\n# Added by `ym completion install` — loads tab-completion for the ym CLI.\n" +
      plan.sourceLine +
      "\n";
    fs.appendFileSync(plan.profilePath, block, "utf8");
  }

  return {
    scriptWritten: true,
    sourceAlreadyPresent,
    sourceAppended: !sourceAlreadyPresent,
  };
}

function computeInstallTargets(shell) {
  const home = homeDir();
  const scriptFileName = {
    bash: ".ym-complete.bash",
    zsh:  ".ym-complete.zsh",
    pwsh: ".ym-complete.ps1",
  }[shell];
  const scriptPath = path.join(home, scriptFileName);
  const scriptContent = fs.readFileSync(
    path.join(TOOL_ROOT, "scripts", COMPLETION_SCRIPTS[shell]),
    "utf8",
  );

  if (shell === "bash") {
    return {
      scriptPath,
      scriptContent,
      profilePath: path.join(home, ".bashrc"),
      sourceLine: `source "$HOME/.ym-complete.bash"`,
      activateCmd: `source ~/.ym-complete.bash`,
    };
  }
  if (shell === "zsh") {
    return {
      scriptPath,
      scriptContent,
      profilePath: path.join(home, ".zshrc"),
      sourceLine: `source "$HOME/.ym-complete.zsh"`,
      activateCmd: `source ~/.ym-complete.zsh`,
    };
  }
  // pwsh: ask PowerShell for its $PROFILE path so we hit the right one for
  // whichever pwsh edition the user has (Windows PowerShell 5.1 vs pwsh 7+;
  // OneDrive-redirected Documents vs not).
  const profilePath = resolvePowerShellProfile() ||
    path.join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
  return {
    scriptPath,
    scriptContent,
    profilePath,
    sourceLine: `. "$HOME/.ym-complete.ps1"`,
    activateCmd: `. ~/.ym-complete.ps1`,
  };
}

function resolvePowerShellProfile() {
  try {
    // On Windows prefer `powershell` (always present); on POSIX try `pwsh`.
    // -NoProfile so we get the path without running the user's own profile.
    const ps = process.platform === "win32" ? "powershell" : "pwsh";
    const r = runSync(ps, ["-NoProfile", "-Command", "Write-Output $PROFILE"]);
    if (r.code === 0) {
      const out = r.stdout.trim();
      if (out) return out;
    }
  } catch { /* ignore — caller has a sane fallback */ }
  return null;
}

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || "";
}

// -----------------------------------------------------------------------------
// _complete — internal helper for shell completion scripts
// -----------------------------------------------------------------------------
export async function _complete(args) {
  const what = args[0];
  if (what === "commands") {
    process.stdout.write(
      [
        "setup", "deps", "install", "up", "down", "switch", "env", "checkout", "status",
        "logs", "restart", "shell", "open", "code", "doctor", "regen",
        "sync", "add", "remove", "stack", "completion", "help", "init",
      ].join("\n") + "\n",
    );
    return;
  }
  if (what === "stacks") {
    process.stdout.write(stacks.listStacks().map((s) => s.key).join("\n") + "\n");
    return;
  }
  if (what === "services") {
    // Optional `--active` filter: only return services in the current
    // selection (preset/stack + ad-hoc adds). Without the flag, returns
    // every service in services.yaml. Used by shell completion for
    // commands like `ym shell` where you typically want the active set.
    const onlyActive = args.includes("--active") || args.includes("--enabled");
    const list = (onlyActive ? activeSvcs() : loadServices().services).map((s) => s.name);
    process.stdout.write(list.join("\n") + "\n");
    return;
  }
  if (what === "envs") {
    process.stdout.write(envNames().join("\n") + "\n");
    return;
  }
  if (what === "branches") {
    // Hints for `ym switch <TAB>` / `ym sync <TAB>`; free-text branches still work.
    process.stdout.write(envBranchChoices().map((b) => b.value).join("\n") + "\n");
    return;
  }
  if (what === "shells") {
    process.stdout.write("bash\nzsh\npwsh\n");
    return;
  }
  if (what === "open-targets") {
    const list = ["tilt", "nginx", ...activeSvcs().map((s) => s.name)];
    process.stdout.write(list.join("\n") + "\n");
    return;
  }
}

// -----------------------------------------------------------------------------
// help
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// workspace — manage which folders the generated yardmaster.code-workspace contains.
//
//   Every cloned service repo is included automatically. This command manages
//   the EXTRA folders on top of that — other repos or unrelated
//   projects, anywhere on disk. The list lives in .ym/state.json (per-machine,
//   never hand-edited); each change regenerates the workspace file.
//
//   ym workspace                 Show the workspace's folders
//   ym workspace add [path...]   Add external folder(s) — picker if no path
//   ym workspace remove [path]   Remove an extra folder — picker if no path
// -----------------------------------------------------------------------------
function clonedRepoNames() {
  return loadServices().services
    .filter((s) => fs.existsSync(path.join(YM_ROOT, s.name)))
    .map((s) => s.name)
    .sort((a, b) => a.localeCompare(b));
}

// Git repos inside the workspace that aren't services (those are
// auto-included) and aren't already added — the natural candidates when a dev
// keeps extra repos under the workspace folder. Repos elsewhere can still be
// added by explicit path: `ym workspace add <path>`.
function extraReposInRoot() {
  const serviceNames = new Set(loadServices().services.map((s) => s.name));
  const already = new Set(state.getWorkspaceExtra().map((p) => path.resolve(p)));
  const SKIP = new Set(["node_modules", ".ym", ".git"]);
  let entries = [];
  try { entries = fs.readdirSync(YM_ROOT, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && !SKIP.has(e.name) && !serviceNames.has(e.name))
    .map((e) => path.join(YM_ROOT, e.name))
    .filter((p) => fs.existsSync(path.join(p, ".git")) && !already.has(path.resolve(p)));
}

function expandHome(p) {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return home ? p.replace(/^~(?=$|[\\/])/, home) : p;
}

export async function workspace(args) {
  const sub = args[0];
  if (!sub || sub === "show" || sub === "list") return workspaceShow();
  if (sub === "add") return workspaceAdd(args.slice(1));
  if (sub === "remove" || sub === "rm") return workspaceRemove(args.slice(1));
  fail("Usage: ym workspace <show|add|remove> [path...]");
  process.exit(1);
}

function workspaceShow() {
  const cloned = clonedRepoNames();
  const extras = state.getWorkspaceExtra();
  section("Workspace", c.gray(`${cloned.length + extras.length} folder(s) → yardmaster.code-workspace`));
  process.stdout.write("\n  " + c.bold("service repos") + c.gray("  (auto — every cloned service)") + "\n");
  for (const n of cloned) process.stdout.write(`    ${c.gray("·")} ${n}\n`);
  process.stdout.write("\n  " + c.bold("extra folders") + c.gray("  (ym workspace add)") + "\n");
  if (extras.length === 0) {
    process.stdout.write(c.gray("    none — `ym workspace add <path>` to include another repo\n"));
  } else {
    for (const p of extras) process.stdout.write(`    ${c.cyan("+")} ${p}\n`);
  }
  process.stdout.write("\n");
  nextStep("ym workspace add <path>   include another repo");
  nextStep("ym code                   open the workspace in VS Code");
}

async function workspaceAdd(paths) {
  let toAdd = paths.filter(Boolean);

  if (toAdd.length === 0) {
    const picker = await import("./picker.js");
    const candidates = extraReposInRoot();
    if (candidates.length) {
      toAdd = await picker.pickMany(
        "Pick folder(s) to add to the workspace:",
        candidates.map((p) => ({ value: p, label: path.basename(p), description: p })),
        { tag: "Folders", pageSize: 20 },
      ) || [];
    } else {
      const typed = await picker.askText("Path of the folder to add:", {
        validate: (v) => (v && v.trim().length > 0) || "Path can't be empty",
        tag: "Folder path",
      });
      toAdd = typed ? [typed.trim()] : [];
    }
  }

  const existing = new Set(state.getWorkspaceExtra().map((p) => path.resolve(p)));
  const added = [];
  for (const raw of toAdd) {
    const abs = path.resolve(expandHome(raw));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) { warn(`skipped (not a folder): ${raw}`); continue; }
    if (path.resolve(abs) === path.resolve(YM_ROOT) ||
        clonedRepoNames().some((n) => path.resolve(path.join(YM_ROOT, n)) === abs)) {
      info(`already part of the workspace (auto-included): ${abs}`); continue;
    }
    if (existing.has(abs)) { info(`already added: ${abs}`); continue; }
    if (!fs.existsSync(path.join(abs, ".git"))) warn(`note: ${abs} isn't a git repo — added anyway`);
    existing.add(abs); added.push(abs);
  }

  if (added.length === 0) { info("Nothing added."); return; }
  state.setWorkspaceExtra([...existing]);
  await regen();
  ok(`Added ${added.length} folder(s):`);
  for (const p of added) process.stdout.write(`  ${c.cyan("+")} ${p}\n`);
  nextStep("ym code   open the updated workspace");
}

async function workspaceRemove(paths) {
  const extras = state.getWorkspaceExtra();
  if (extras.length === 0) { info("No extra folders to remove (cloned repos are always included)."); return; }

  let toRemove = paths.filter(Boolean).map((p) => path.resolve(expandHome(p)));
  if (toRemove.length === 0) {
    const picker = await import("./picker.js");
    toRemove = await picker.pickMany(
      "Remove which folder(s) from the workspace?",
      extras.map((p) => ({ value: p, label: path.basename(p), description: p })),
      { tag: "Folders", pageSize: 20 },
    ) || [];
  }

  const removeSet = new Set(toRemove.map((p) => path.resolve(p)));
  const next = extras.filter((p) => !removeSet.has(path.resolve(p)));
  if (next.length === extras.length) { info("Nothing matched."); return; }

  state.setWorkspaceExtra(next);
  await regen();
  ok(`Removed ${extras.length - next.length} folder(s) from the workspace.`);
}

// -----------------------------------------------------------------------------
// update — pull the workspace repo (ff-only), regen, clone any newly-declared
// active service, and report selection entries that no longer exist.
// Refuses when the workspace repo is dirty, so local edits are never clobbered.
// -----------------------------------------------------------------------------
export async function update() {
  const { StepLine } = await import("./live.js");

  if (!git.hasOrigin(YM_ROOT)) {
    fail("The workspace has no 'origin' remote — nothing to pull. Run `ym regen` instead.");
    process.exit(1);
  }

  const branch = git.currentBranch(YM_ROOT) || "main";
  const before = git.headSha(YM_ROOT);

  const pullStep = new StepLine("Workspace");
  pullStep.start(`fetching origin/${branch}`);
  await git.fetch(YM_ROOT);

  if (git.isDirty(YM_ROOT)) {
    pullStep.fail("workspace has uncommitted changes — commit/stash them, then re-run `ym update`");
    process.exit(1);
  }

  const behind = git.commitsBehind(YM_ROOT) || 0;
  if (behind === 0) {
    pullStep.succeed(`already up to date (${branch})`);
  } else {
    pullStep.update(`pulling ${behind} commit(s)`);
    const r = await git.pull(YM_ROOT, branch);
    if (r.code !== 0) {
      pullStep.fail(`pull failed: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-1)[0]}`);
      process.exit(1);
    }
    pullStep.succeed(`pulled ${behind} commit(s) onto ${branch}`);
  }

  // Regen from the (possibly updated) services.yaml.
  await regen();

  // Reconcile: clone any active-selection service now declared but missing on
  // disk (a teammate added it), and flag selection entries whose service was
  // removed from services.yaml.
  const allNames = new Set(loadServices().services.map((s) => s.name));
  const activeNames = presets.activeServiceNames();
  const missingActive = loadServices().services.filter(
    (s) => activeNames.includes(s.name) && !fs.existsSync(path.join(YM_ROOT, s.name)),
  );
  const staleSelections = activeNames.filter((n) => !allNames.has(n));

  if (missingActive.length) {
    process.stdout.write("\n");
    info(`Reconciling — ${missingActive.length} active service(s) not yet cloned:`);
    const { provisionRepos } = await import("./repos.js");
    await provisionRepos(missingActive, { concurrency: 4, env: state.getEnv() });
    const { ensureEnvFiles } = await import("./env-compiler.js");
    ensureEnvFiles(state.getEnv());
    await regen();
  }

  if (staleSelections.length) {
    warn(`Your selection references ${staleSelections.length} service(s) no longer in services.yaml: ${staleSelections.join(", ")}`);
    nextStep(`ym remove ${staleSelections.join(" ")}   drop them from the active stack`);
  }

  process.stdout.write("\n");
  const parts = [behind === 0 ? "workspace already current" : `workspace +${behind} commit(s)`];
  if (missingActive.length) parts.push(`${missingActive.length} service(s) cloned`);
  ok(parts.join(" · "));

  if ((behind > 0 || missingActive.length) && await tilt.isRunning()) {
    nextStep("Tilt is running — `ym down && ym up` to pick up the changes");
  }
}

// -----------------------------------------------------------------------------
// overview — the bare `ym` landing screen. A compact "where am I + what next",
// distinct from `ym help` (the full command list). Kept fast: one cheap Tilt
// probe, no per-service git.
// -----------------------------------------------------------------------------
export async function overview() {
  const env = state.getEnv();
  const sel = presets.activeSelection();
  let stackLabel;
  if (sel.stackKey) {
    const p = presets.getPreset(sel.stackKey);
    stackLabel = p ? `${p.key} (${p.label})` : sel.stackKey;
  } else if (sel.services && sel.services.length) {
    stackLabel = `custom (${sel.services.length} services)`;
  } else {
    stackLabel = `${presets.defaultPresetKey()} (default)`;
  }
  const active = activeSvcs();
  const cloned = active.filter((s) => fs.existsSync(path.join(YM_ROOT, s.name))).length;
  const running = await tilt.isRunning();

  process.stdout.write(
    `\n${c.bold("ym")} — yardmaster local-dev orchestrator\n\n` +
    `  ${c.gray("env")}    ${env}\n` +
    `  ${c.gray("stack")}  ${stackLabel} ${c.gray("—")} ${cloned}/${active.length} cloned\n` +
    `  ${c.gray("tilt")}   ${running ? c.green("running") : c.gray("stopped")}\n\n`,
  );
  nextStep(running ? "ym status     see service health" : "ym up         start the active stack");
  nextStep("ym doctor     diagnostics with fixes");
  nextStep("ym help       all commands");
  process.stdout.write("\n");
}

export function help() {
  process.stdout.write(`
${c.bold("ym")} — yardmaster local-dev orchestrator

${c.bold("Setup")}
  ym init [dir]                 Scaffold a workspace (services.yaml, .env.example).
  ym init --example bookshop    Create a runnable five-service example fleet.
  ym setup                      Install Tilt+Nginx, clone+install repos, gen envs.
                                On first run, prompts for a stack and an
                                environment.
  ym deps [svc...] [--all]      Fast parallel npm install across active services
                                (or a specific microservice). When Tilt is up,
                                --all scans logs and fixes failing services.
                                (aliases: install, i)
  ym add [svc...]               Clone + install one or more services and add
                                them to your active stack. Multi-arg parallel.
  ym remove [svc...] [--purge]  Drop services from the active stack. Clone
                                stays on disk for fast re-add; --purge to
                                delete the clone directory too (asks first).
  ym sync [branch]              For each cloned repo: stash, switch to <branch>,
                                pull (ff-only), switch back, restore stash.
                                Safe — uncommitted work is never lost.
  ym regen                      Re-emit nginx.conf from services.yaml
  ym update                     Pull the workspace repo, regen, and clone any
                                newly-declared services. Refuses if the
                                workspace has uncommitted changes.

${c.bold("Run")}
  ym up [svc...] [-a|--attach]  Start via Tilt. Detached by default — terminal
                                stays free. --attach keeps Tilt in foreground.
  ym down                       Stop everything
  ym restart [svc...] [--all]   Re-trigger one, several, or every active
                                service in Tilt.
  ym logs [service] [-f]        Stream a service's logs
  ym logs --tilt [-f]           Tail the detached Tilt launcher log

${c.bold("Inspect")}
  ym status [-r|--routes]       One-screen summary. --routes adds an
                                extra column with each service's nginx
                                route prefixes.
  ym doctor [--fix]             Diagnostic checks with fixes. --fix auto-applies
                                the safe ones (regen, missing .env).
  ym open [service|tilt|nginx]  Open in browser
  ym shell [service]            Open a subshell with that service's .env loaded
  ym code [service...]          Open in VS Code. No arg = open the
                                multi-root yardmaster.code-workspace. Multiple
                                args = each opens in its own window.
  ym workspace [add|remove]     Manage the VS Code workspace folders. Every
                                cloned repo is auto-included; add/remove
                                external repos.

${c.bold("Environments / branches")}
  ym switch [branch] [--stash]  Switch every repo to <branch>. Skips repos
                                with uncommitted changes (pass --stash to
                                park their work instead). When <branch>
                                is an environment's branch, also
                                regenerates .env files.
  ym env [name]                 Regenerate .env files only — no git.
  ym checkout [svc=branch]...   Per-service branch override

${c.bold("Stacks")}
  ym stack [show]               Show current selection + branches + env
  ym stack list                 List built-in + user-saved stacks
  ym stack apply [name]         Switch to a stack (and apply any captured
                                branches / env if it's a snapshot)
  ym stack create <name>        Design a new stack via a picker. Does not
    [--from <stack>]            touch your running env. --from pre-checks
                                services from another stack.
  ym stack edit [name]          Modify a saved stack's service list
                                via a picker. Does not touch your running env.
  ym stack save [name]          Bookmark current state. Default = services
    [--with-branches]           only (template). Flags add layers, turning
    [--with-env]                it into a snapshot.
  ym stack delete [name]        Remove a user-saved stack
                                Built-in stacks live in services.yaml
                                and are immutable.
                                Copy first: ym stack create <new> --from <built-in>.

${c.gray("Arguments shown in [brackets] are optional — omit them for an interactive picker.")}

${c.bold("Misc")}
  ym                            (no args) status overview + suggested next steps
  ym completion install         Install tab-completion for your current shell
                                (bash, zsh, or pwsh — auto-detected)
  ym help                       This message
`);
}
