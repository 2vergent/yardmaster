#!/usr/bin/env node
// =============================================================================
// lib/setup-impl.js — `ym setup`: toolchain, clones, env files, codegen.
//
// Reads selection from .ym/state.json (set on first run); if no selection,
// falls back to services.yaml's default stack.
//
// Resumable: re-running after a partial failure picks up where it stopped.
// =============================================================================

import { YM_ROOT } from "./bootstrap.js";
import { c, warn, fail, nextStep } from "./term.js";
import { commandExists } from "./exec.js";
import { StepLine } from "./live.js";
import { loadServices, envNames, defaultEnv, envBranch } from "./services.js";
import { activeServiceNames, applyPreset, defaultPresetKey } from "./presets.js";
import { ensureTilt, ensureNginx } from "./installers.js";
import { provisionRepos } from "./repos.js";
import { writeAll } from "./codegen.js";
import * as state from "./state.js";
import {
  init as runInit,
  regen,
  detectShell,
  isCompletionAlreadyInstalled,
  performCompletionInstall,
  diskFreeBytes,
} from "./commands.js";

function header(title, subtitle = "") {
  // Aligns with lib/term.js#section but doesn't add the trailing blank
  // line — setup's body is dense, no need for extra vertical space.
  const sub = subtitle ? `  ${c.gray("—")} ${c.gray(subtitle)}` : "";
  process.stdout.write(`\n${c.bold(title)}${sub}\n`);
}

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}m${r.toString().padStart(2, "0")}s`;
}

function checkNode() {
  const step = new StepLine("Node");
  step.start("checking version");
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major < 20) {
    step.fail(`${process.version} (need 20+) — try nvm/fnm/nvs`);
    process.exit(1);
  }
  step.succeed(process.version);
}

// Hard prerequisite: git must be on PATH or nothing downstream can clone.
function checkGit() {
  const step = new StepLine("git");
  step.start("checking PATH");
  if (!commandExists("git")) {
    step.fail("not found — install Git, then re-run `ym setup`");
    process.exit(1);
  }
  step.succeed("on PATH");
}

// Soft prerequisite: warn (don't block) on low disk. A full clone needs
// ~5 GB; the estimate can be off, so we never hard-fail on it.
async function checkDisk() {
  const step = new StepLine("Disk");
  step.start("checking free space");
  const bytes = await diskFreeBytes(YM_ROOT);
  if (bytes == null) { step.succeed("unknown"); return; }
  const gb = bytes / (1024 ** 3);
  step.succeed(`${gb.toFixed(1)} GB free`);
  if (gb < 5) {
    warn(`Low disk: ${gb.toFixed(1)} GB free — a full clone needs ~5 GB. Continuing anyway.`);
  }
}

async function promptEnv() {
  // Idempotent across re-runs — state remembers the choice.
  const recorded = state.getState().env;
  if (recorded) return recorded;

  const names = envNames();
  const fallback = defaultEnv();
  if (names.length === 1 || !process.stdin.isTTY || !process.stdout.isTTY) return fallback;

  // Auto-picks the default after 10s so an Enter-masher still gets a sane choice.
  process.stdout.write("\n");
  const { pickOne } = await import("./picker.js");
  const { environments } = loadServices();
  return pickOne(
    `Which environment should every repo be cloned for?  ${c.gray(`(auto-${fallback} in 10s)`)}`,
    names.map((n) => ({
      value: n,
      label: n,
      description: environments[n]?.description || `branch ${envBranch(n)}`,
    })),
    { default: fallback, timeoutMs: 10_000, tag: "Environment" },
  );
}

async function main() {
  const t0 = Date.now();

  process.stdout.write(
    `\n${c.bold(c.cyan("yardmaster Local Development Setup"))}` +
    c.gray(`  ${process.platform} · node ${process.version.slice(1)}\n`),
  );

  header("Toolchain");
  checkNode();
  checkGit();
  await checkDisk();
  await ensureTilt();

  // Baseline codegen — we need a nginx.conf on disk before ensureNginx so
  // it has something to mirror into the install dir. On a true fresh
  // install this writes the default-essentials set; the SECOND pass after
  // tier selection + provisioning (below) corrects it to reflect what the
  // user actually picked / cloned.
  writeAll();
  await ensureNginx();


  // Tier selection — if no selection exists yet, prompt for one now so the
  // user always gets the picker on first run. Subsequent setup runs reuse
  // the saved selection. (Later tier changes go through `ym stack apply`.)
  //
  // `[]` counts as "no selection" too — a truthy-but-empty array means the
  // user ended up with nothing selected (e.g. removed every service one by
  // one), and the natural recovery is to re-prompt rather than silently
  // fall through to the default stack.
  const sel = state.getState().selected_services;
  if (!sel || sel.length === 0) {
    header("Stack selection");
    if (process.stdin.isTTY && process.stdout.isTTY) {
      await runInit();
    } else {
      applyPreset(defaultPresetKey());
      nextStep(`non-interactive — using default stack '${defaultPresetKey()}'`);
    }
  }

  header("Repositories");
  const env = await promptEnv();
  state.setEnv(env);

  // Resolve the active set: state.selected_services if set, else fall back
  // to the default preset. activeServiceNames() is the single source of
  // truth — the same resolver used by codegen, env-compiler, Tilt, etc.
  const activeNames = new Set(activeServiceNames());
  const services = loadServices().services.filter((s) => activeNames.has(s.name));

  const results = await provisionRepos(services, { concurrency: 4, env });

  const failed = results.filter((r) => !r.ok || (r.value && !r.value.ok));
  if (failed.length) {
    process.stdout.write("\n");
    fail(`${failed.length} of ${services.length} service(s) failed — re-run \`ym setup\` to resume.`);
    process.exit(1);
  }

  // Surface any repos that had uncommitted changes — we skipped switching
  // their branches to avoid silently leaking work across branches (or
  // hitting a refused checkout). Re-runs on existing clones are the
  // typical trigger.
  const dirtySkipped = results
    .map((r) => r.value)
    .filter((v) => v && v.dirtySkip);
  if (dirtySkipped.length) {
    process.stdout.write("\n");
    warn(
      `${dirtySkipped.length} repo(s) kept on their current branch — they had uncommitted changes:`,
    );
    for (const v of dirtySkipped) {
      const target = v.targetBranch && v.targetBranch !== v.branch
        ? c.gray(` (target was ${v.targetBranch})`)
        : "";
      process.stdout.write(`  ${c.yellow("!")} ${v.svc.padEnd(28)} on ${v.branch}${target}\n`);
    }
    process.stdout.write(
      c.gray(
        `\n  Commit or discard those changes and re-run \`ym setup\`,\n` +
        `  or use \`ym switch ${envBranch(env)} --stash\` to park them.\n`,
      ),
    );
  }

  header("Configuration");

  // Regenerate codegen now that the selection is finalized AND the clones
  // exist on disk. The baseline pass before ensureNginx couldn't see the
  // user's pick (runInit runs later); this pass corrects nginx.conf +
  // yardmaster.code-workspace to reflect reality, and re-mirrors nginx.conf into
  // the nginx runtime dir so Tilt's nginx picks up the right routes.
  await regen();

  const envStep = new StepLine("Environment files");
  envStep.start(`generating for '${env}'`);
  try {
    const { generateEnvFiles } = await import("./env-compiler.js");
    const results = generateEnvFiles(env);
    const wrote = results.filter((r) => r.status === "written").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    const parts = [`${wrote} written`];
    if (skipped) parts.push(`${skipped} skipped`);
    envStep.succeed(parts.join(", "));
  } catch (err) {
    envStep.fail(`env-compiler failed: ${err.message}`);
    process.exit(1);
  }


  // ----- optional: install tab-completion ----------------------------------
  // Only ask on the FIRST setup where it isn't already in place. Re-runs
  // skip silently. Non-TTY / undetected shell / declined → we fall through
  // and the final banner will hint at `ym completion install`.
  const completionState = await maybeInstallCompletion();

  state.markStep("setup", "ok");
  state.saveState({ ...state.getState(), setup_completed_at: new Date().toISOString() });

  // ----- final banner -----
  const elapsed = Date.now() - t0;
  process.stdout.write(
    `\n${c.green("✓")} ${c.bold("Setup complete")}` +
    c.gray(`  ${services.length} services · ${fmtElapsed(elapsed)}`) +
    "\n",
  );

  // Only mention `ym completion install` when it wasn't already done.
  const completionHint = completionState === "ready"
    ? ""
    : `  ${c.green("ym completion install")}  Tab-completion for your shell\n`;


  process.stdout.write(`
${c.bold("Next:")}
  ${c.green("ym up")}                Start the active stack
  ${c.green("ym status")}            One-screen overview
  ${c.green("ym doctor")}            Diagnostics with concrete fixes
${completionHint}
${c.gray("Tip: open yardmaster.code-workspace in VS Code for a multi-root view of every repo.")}
`);
}

// Returns one of:
//   "ready"     — already installed (silent skip) OR installed during this run
//   "deferred"  — user declined / non-TTY / shell undetected. Banner will hint.
async function maybeInstallCompletion() {
  const shell = detectShell();
  if (!shell) return "deferred";

  // Idempotent: never re-prompt if the source line is already in the rc file.
  const already = isCompletionAlreadyInstalled(shell);
  if (already) return "ready";

  // Non-TTY (CI, piped input) → can't ask. Fall back to the banner hint.
  if (!process.stdin.isTTY || !process.stdout.isTTY) return "deferred";

  // Ask once. Default Y so a user hitting Enter through prompts gets it.
  const { askConfirm } = await import("./picker.js");
  const yes = await askConfirm(
    `Install tab-completion for ${shell}?`,
    { default: true, tag: "Tab-completion" },
  );
  if (!yes) return "deferred";

  const step = new StepLine("Tab-completion");
  step.start(`installing for ${shell}`);
  try {
    const result = performCompletionInstall(shell);
    step.succeed(result.sourceAppended ? "added to profile" : "already in profile");
    nextStep(`Activate now: ${result.plan.activateCmd}  (or restart your terminal)`);
    return "ready";
  } catch (err) {
    step.fail(err.message || String(err));
    return "deferred";
  }
}

main().catch((err) => {
  fail(err.message || String(err));
  process.exit(1);
});
