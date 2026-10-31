// =============================================================================
// Multi-repo branch operations. Two consumers:
//
//   ym sync <target>   stash → switch → pull → switch BACK → restore stash.
//                      Preserves the user's branch + uncommitted work.
//                      Side effect: local <target> is now up to date.
//
//   ym switch <target> stash (if --stash) → switch → pull → STAY.
//                      Moves the user to <target> across every repo.
//                      Dirty repos are skipped unless --stash is given,
//                      and even then the stash is NOT auto-reapplied
//                      (avoids the cross-branch leakage footgun).
//
// Toggled via syncAll's opts:
//   stayOnTarget: bool  — true for `ym switch`, false for `ym sync`
//   dirtyMode:    "skip" | "stash"  — only meaningful with stayOnTarget=true.
//                                     ym sync ignores this (always stashes).
//
// Safety contract (same for both):
//   - Stashes are tagged with command + target + iso timestamp.
//   - Stashes are only dropped after a successful reapply (sync mode); in
//     switch+stash mode they're left in place for the user to recover.
//   - `git pull --ff-only` only — no merge commits, no rebase, no reset.
//   - Repos already in a mid-op state (merge/rebase/cherry-pick) skipped.
//   - Every per-repo outcome is reported with enough detail to recover.
// =============================================================================

import fs from "fs";
import path from "path";
import { YM_ROOT } from "./bootstrap.js";
import { loadServices } from "./services.js";
import { parallel } from "./exec.js";
import { LiveTable } from "./live.js";
import * as git from "./git.js";

/**
 * Run a multi-repo branch op against `target`. Returns { results } where each
 * result looks like:
 *   { repo, status, phase?, reason?, stashRef?, stashMessage?, pullWarning? }
 *
 * opts:
 *   concurrency:   number             default 4
 *   stayOnTarget:  bool               default false (sync mode). true = `ym switch` semantics.
 *   dirtyMode:     "skip" | "stash"   only used when stayOnTarget=true.
 *                                     "skip" — leave dirty repos untouched, list them in the result
 *                                     "stash" — stash work (preserved, NOT reapplied)
 *   commandTag:    string             stash-message prefix, e.g. "ym-sync" or "ym-switch"
 *   services:      string[]           optional filter — only operate on these
 *                                     services (if cloned). Used by `ym stack apply`
 *                                     to switch a subset of repos to a per-stack branch.
 */
export async function syncAll(target, opts = {}) {
  const concurrency = opts.concurrency ?? 4;
  const stayOnTarget = opts.stayOnTarget === true;
  const dirtyMode = stayOnTarget ? (opts.dirtyMode ?? "skip") : "stash";
  const commandTag = opts.commandTag ?? (stayOnTarget ? "ym-switch" : "ym-sync");
  const svcFilter = Array.isArray(opts.services) && opts.services.length > 0
    ? new Set(opts.services)
    : null;

  // Every cloned repo, optionally filtered down to the caller's service set.
  const all = loadServices().services;
  let cloned = all.filter((s) =>
    fs.existsSync(path.join(YM_ROOT, s.name)) &&
    fs.existsSync(path.join(YM_ROOT, s.name, ".git")),
  );
  if (svcFilter) cloned = cloned.filter((s) => svcFilter.has(s.name));

  if (cloned.length === 0) {
    return { results: [] };
  }

  const verb = stayOnTarget ? "Switching" : "Syncing";
  const live = new LiveTable({
    title: `${verb} ${cloned.length} repo(s) to '${target}'`,
    items: cloned.map((s) => ({ id: s.name, label: s.name })),
  });
  live.start();

  const tasks = cloned.map((svc) => async () => {
    const repoPath = path.join(YM_ROOT, svc.name);
    const setStep = (msg) => live.update(svc.name, { state: "running", step: msg });
    setStep("queued");
    try {
      const result = await syncRepo(svc.name, repoPath, target, setStep, {
        stayOnTarget, dirtyMode, commandTag,
      });
      live.update(svc.name, mapToLiveState(result));
      return result;
    } catch (err) {
      live.update(svc.name, { state: "failed", step: err.message || "exception" });
      return {
        repo: svc.name,
        status: "failed",
        phase: "exception",
        reason: err.message || String(err),
      };
    }
  });

  const wrapped = await parallel(tasks, concurrency);
  live.stop();
  const results = wrapped.map((w) => (w.ok ? w.value : {
    repo: "?",
    status: "failed",
    phase: "parallel",
    reason: w.error?.message || "unknown",
  }));
  return { results };
}

// ---- per-repo --------------------------------------------------------------

async function syncRepo(repoName, repoPath, target, setStep, opts) {
  const { stayOnTarget, dirtyMode, commandTag } = opts;
  setStep("pre-flight");

  if (!git.isRepo(repoPath)) {
    return { repo: repoName, status: "skipped", reason: "not a git repo" };
  }

  const midState = git.inMidState(repoPath);
  if (midState) {
    return {
      repo: repoName,
      status: "skipped",
      reason: `mid-${midState} — finish or abort first`,
    };
  }

  const originalBranch = git.currentBranch(repoPath);
  const originalSha = git.headSha(repoPath);
  const detached = originalBranch === "HEAD" || !originalBranch;

  // ---- Dirty handling -----------------------------------------------------
  //
  // Mode matrix:
  //   sync mode (!stayOnTarget): always stash + reapply on return. dirtyMode
  //                              is ignored ("stash" effectively).
  //   switch + skip:             refuse to touch dirty repos. User must
  //                              commit/discard or re-run with --stash.
  //   switch + stash:            stash, do the switch, leave stash parked
  //                              on the new branch (NOT reapplied).
  //
  // Skipping in switch+skip mode happens BEFORE fetch — we don't want to
  // do any work if we're not going to switch.
  const dirty = git.isDirty(repoPath);
  if (dirty && stayOnTarget && dirtyMode === "skip") {
    return {
      repo: repoName,
      status: "skipped",
      reason: "uncommitted changes — commit them, discard, or use --stash",
    };
  }

  // ---- Stash (if needed) -------------------------------------------------
  let stashRef = null;
  let stashMessage = null;
  if (dirty) {
    setStep("stashing");
    const isoTime = new Date().toISOString().replace(/[:.]/g, "-");
    stashMessage = `${commandTag}@${target}@${isoTime}`;
    const stashed = await git.stashSave(repoPath, stashMessage);
    if (!stashed.ok) {
      return {
        repo: repoName,
        status: "failed",
        phase: "stash",
        reason: stashed.error,
      };
    }
    stashRef = stashed.ref;
  }

  // From here on, if something fails we'll try to restore the user's
  // original state via this helper.
  async function restorePartial(reason, phase) {
    // Best-effort: switch back to original, reapply stash.
    if (!detached) {
      const cur = git.currentBranch(repoPath);
      if (cur !== originalBranch && originalBranch) {
        await git.checkout(repoPath, originalBranch);
      }
    } else if (originalSha) {
      await git.checkout(repoPath, originalSha);
    }
    if (stashRef) {
      const apply = await git.applyStash(repoPath, stashRef);
      if (apply.ok) {
        await git.stashDrop(repoPath, stashRef);
        return { repo: repoName, status: "failed", phase, reason };
      }
      // Couldn't re-apply during cleanup — surface as conflict.
      return {
        repo: repoName,
        status: "conflict",
        phase,
        reason,
        stashRef,
        stashMessage,
      };
    }
    return { repo: repoName, status: "failed", phase, reason };
  }

  // ---- Fetch -------------------------------------------------------------
  setStep("fetching");
  const fetchResult = await git.fetch(repoPath);
  if (fetchResult.code !== 0) {
    return restorePartial(fetchResult.stderr || "fetch failed", "fetch");
  }

  // ---- Verify target exists on remote ------------------------------------
  if (!(await git.remoteHasBranch(repoPath, target))) {
    // Unstash so the user is back to where they were.
    if (stashRef) {
      const apply = await git.applyStash(repoPath, stashRef);
      if (apply.ok) await git.stashDrop(repoPath, stashRef);
      // If we couldn't reapply, leave the stash and report.
      if (!apply.ok) {
        return {
          repo: repoName,
          status: "conflict",
          phase: "restore-after-skip",
          reason: `target '${target}' not on remote, and stash didn't reapply cleanly`,
          stashRef,
          stashMessage,
        };
      }
    }
    return {
      repo: repoName,
      status: "skipped",
      reason: `target '${target}' not on remote`,
    };
  }

  // ---- Switch to target (if not already) ---------------------------------
  // checkoutResilient transparently sets aside a blocking untracked .env
  // (ym-owned, regenerable) so a switch onto a branch that commits .env —
  // e.g. a frontend's staging branch — no longer hard-errors.
  let envSupplanted = null;
  const alreadyOnTarget = !detached && originalBranch === target;
  if (!alreadyOnTarget) {
    setStep(`switching → ${target}`);
    const sw = await git.checkoutResilient(repoPath, target);
    if (sw.code !== 0) {
      return restorePartial(sw.stderr || "switch failed", "switch");
    }
    if (sw.setAside && sw.setAside.length) envSupplanted = sw.setAside.join(", ");
  }

  // ---- Pull --ff-only ----------------------------------------------------
  setStep(`pulling ${target}`);
  const pulled = await git.pullFFOnly(repoPath, target);
  let pullWarning = null;
  if (!pulled.ok) {
    pullWarning = `non-fast-forward — local '${target}' has diverged; pull skipped`;
  }

  // ---- Switch back (sync mode only) --------------------------------------
  // In stayOnTarget mode we deliberately stop here — the user wanted to
  // BE on the target.
  if (!stayOnTarget && !alreadyOnTarget) {
    setStep(`switching ← ${detached ? originalSha.slice(0, 7) : originalBranch}`);
    const backTo = detached ? originalSha : originalBranch;
    const back = await git.checkoutResilient(repoPath, backTo);
    if (back.code !== 0) {
      // We're stuck on target. Stash still exists. Surface clearly.
      return {
        repo: repoName,
        status: "failed",
        phase: "switch-back",
        reason: back.stderr || "couldn't return to original branch",
        stashRef,
        stashMessage,
        pullWarning,
      };
    }
  }

  // ---- Apply the stash (sync mode only) ----------------------------------
  // In stayOnTarget mode we leave the stash in place — it represents the
  // user's work in the original branch's context; reapplying it on the
  // target branch would bleed work across branches (footgun).
  if (!stayOnTarget && stashRef) {
    setStep("restoring stash");
    const apply = await git.applyStash(repoPath, stashRef);
    if (!apply.ok) {
      // Conflict — leave the stash in place, don't drop.
      return {
        repo: repoName,
        status: "conflict",
        stashRef,
        stashMessage,
        pullWarning,
      };
    }
    await git.stashDrop(repoPath, stashRef);
  }

  // ---- Success -----------------------------------------------------------
  let statusLabel;
  if (stayOnTarget) {
    statusLabel = alreadyOnTarget
      ? "switched (already on target)"
      : stashRef
        ? "switched (work stashed)"
        : "switched";
  } else {
    statusLabel = alreadyOnTarget
      ? "synced (already on target)"
      : stashRef
        ? "synced"
        : "synced (no changes)";
  }
  return {
    repo: repoName,
    status: statusLabel,
    pullWarning,
    // In switch+stash mode, expose stash info so the caller can print
    // recovery instructions. Sync mode drops the stash before reaching here.
    ...(stayOnTarget && stashRef ? { stashRef, stashMessage } : {}),
    ...(envSupplanted ? { envSupplanted } : {}),
  };
}

// Map our result to a LiveTable row state + step for final rendering.
function mapToLiveState(result) {
  const s = result.status;
  if (s.startsWith("synced")) {
    const note = s === "synced (no changes)" ? "no local changes"
               : s === "synced (already on target)" ? "was already on target"
               : "stash restored cleanly";
    return { state: "done", step: result.pullWarning ? `${note} · pull diverged` : note };
  }
  if (s.startsWith("switched")) {
    let note = s === "switched (already on target)" ? "was already on target"
             : s === "switched (work stashed)" ? `stash kept at ${result.stashRef}`
             : "on target";
    if (result.envSupplanted) note += ` · using branch's ${result.envSupplanted}`;
    return { state: "done", step: result.pullWarning ? `${note} · pull diverged` : note };
  }
  if (s === "conflict") {
    return { state: "failed", step: `conflict — stash kept at ${result.stashRef}` };
  }
  if (s === "skipped") {
    return { state: "skipped", step: result.reason };
  }
  // failed
  return {
    state: "failed",
    step: `${result.phase || "?"}: ${(result.reason || "").split("\n")[0].slice(0, 80)}`,
  };
}
