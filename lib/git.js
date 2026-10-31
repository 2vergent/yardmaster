// Per-repo git helpers used by status, sync, checkout.

import fs from "fs";
import path from "path";
import { run, runSync } from "./exec.js";

export function isRepo(repoPath) {
  return fs.existsSync(path.join(repoPath, ".git"));
}

export function currentBranch(repoPath) {
  if (!isRepo(repoPath)) return null;
  const r = runSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoPath,
  });
  return r.code === 0 ? r.stdout.trim() : null;
}

export function headSha(repoPath) {
  if (!isRepo(repoPath)) return null;
  const r = runSync("git", ["rev-parse", "HEAD"], { cwd: repoPath });
  return r.code === 0 ? r.stdout.trim() : null;
}

// Files ym manages itself that should never count as "dirty" when untracked.
// `.env` is generated per-environment by env-compiler.js and is either
// git-ignored (backends) or untracked-but-not-ignored (some frontends). In such a frontend
// case an untracked `.env` would otherwise mark the repo permanently dirty,
// which silently makes `ym switch` skip it and shows a bogus dirty dot in
// `ym status`. We ignore it ONLY when untracked — a tracked, modified file is
// still real work and stays dirty.
const DIRTY_IGNORE = new Set([".env"]);

// True if this porcelain line is an untracked entry for a ym-managed file.
//   v1 untracked: "?? <path>"      v2 untracked: "? <path>"
function isIgnorableUntracked(line) {
  let p = null;
  if (line.startsWith("?? ")) p = line.slice(3);       // porcelain v1
  else if (line.startsWith("? ")) p = line.slice(2);   // porcelain v2
  if (p === null) return false;
  return DIRTY_IGNORE.has(p.trim());
}

export function isDirty(repoPath) {
  if (!isRepo(repoPath)) return false;
  const r = runSync("git", ["status", "--porcelain"], { cwd: repoPath });
  if (r.code !== 0) return false;
  return r.stdout
    .split(/\r?\n/)
    .some((line) => line.trim().length > 0 && !isIgnorableUntracked(line));
}

// Commits behind upstream (HEAD..@{u}). null if no upstream set.
export function commitsBehind(repoPath) {
  if (!isRepo(repoPath)) return null;
  const r = runSync(
    "git",
    ["rev-list", "--count", "HEAD..@{u}"],
    { cwd: repoPath },
  );
  if (r.code !== 0) return null;
  const n = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

export function commitsAhead(repoPath) {
  if (!isRepo(repoPath)) return null;
  const r = runSync("git", ["rev-list", "--count", "@{u}..HEAD"], {
    cwd: repoPath,
  });
  if (r.code !== 0) return null;
  const n = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

// Files changed between two commits (name-only). Empty on error or when the
// two SHAs are equal. Used by `ym update` to decide whether a pull touched
// package-lock.json (→ npm install) or services.yaml (→ reconcile).
export function filesChangedBetween(repoPath, a, b) {
  if (!isRepo(repoPath) || !a || !b || a === b) return [];
  const r = runSync("git", ["diff", "--name-only", `${a}..${b}`], { cwd: repoPath });
  if (r.code !== 0) return [];
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

// Does this repo have an 'origin' remote? `ym update` needs one to pull.
export function hasOrigin(repoPath) {
  if (!isRepo(repoPath)) return false;
  const r = runSync("git", ["remote"], { cwd: repoPath });
  return r.code === 0 && r.stdout.split(/\r?\n/).map((s) => s.trim()).includes("origin");
}

export async function clone(repoUrl, dest) {
  return run("git", ["clone", "--quiet", repoUrl, dest]);
}

export async function fetch(repoPath) {
  return run("git", ["fetch", "--all", "--quiet"], { cwd: repoPath });
}

export async function checkout(repoPath, branch) {
  // Use `git switch` if available (Git 2.23+); fall back to checkout.
  let r = await run("git", ["switch", branch], { cwd: repoPath });
  if (r.code !== 0) {
    r = await run("git", ["checkout", branch], { cwd: repoPath });
  }
  return r;
}

export async function pull(repoPath, branch) {
  return run("git", ["pull", "--ff-only", "origin", branch], { cwd: repoPath });
}

// Tool-owned, regenerable files ym may move aside to unblock a checkout that
// would otherwise abort with "untracked working tree files would be
// overwritten by checkout" — e.g. a repo commits .env on some branches, so
// ym's generated *untracked* .env blocks switching onto them.
const TOOL_OWNED_REGENERABLE = [".env"];

// Is exactly this path an untracked file? (Guards against deleting a tracked
// modification — that's real work, not a regenerable artifact.)
function pathIsUntracked(repoPath, rel) {
  const r = runSync("git", ["status", "--porcelain", "--", rel], { cwd: repoPath });
  return r.code === 0 && r.stdout.trim().startsWith("??");
}

// checkout(), but resilient to a blocking untracked .env. If the plain
// checkout aborts on "untracked … would be overwritten", set the ym-owned
// untracked file(s) aside (backed up in memory), retry once, then:
//   - on success: put each file back UNLESS the branch we landed on supplied
//     its own copy (then the committed copy legitimately wins — same outcome
//     as a manual move-aside). The restored copy is the user's regenerable
//     ym .env: same env, just a different branch, so it's still correct.
//   - on failure: restore everything exactly and report the error.
//
// Returns the git result plus { setAside: [relpaths] } listing files the
// branch supplanted (i.e. we did NOT restore). Empty when nothing was moved
// or our copy was restored — the transparent, common case.
export async function checkoutResilient(repoPath, branch) {
  let r = await checkout(repoPath, branch);
  if (r.code === 0) return { ...r, setAside: [] };
  if (!/untracked working tree files would be overwritten/i.test(r.stderr || "")) {
    return { ...r, setAside: [] };
  }

  const backups = [];
  for (const rel of TOOL_OWNED_REGENERABLE) {
    const abs = path.join(repoPath, rel);
    if (fs.existsSync(abs) && pathIsUntracked(repoPath, rel)) {
      backups.push({ rel, abs, content: fs.readFileSync(abs) });
      fs.rmSync(abs);
    }
  }
  if (backups.length === 0) return { ...r, setAside: [] };

  const r2 = await checkout(repoPath, branch);
  if (r2.code !== 0) {
    for (const b of backups) fs.writeFileSync(b.abs, b.content);   // restore exactly
    return { ...r2, setAside: [] };
  }

  const supplanted = [];
  for (const b of backups) {
    if (fs.existsSync(b.abs)) supplanted.push(b.rel);   // branch provided its own
    else fs.writeFileSync(b.abs, b.content);            // nothing there → restore ours
  }
  return { ...r2, setAside: supplanted };
}

export async function listRemoteBranches(repoPath) {
  const r = await run("git", ["branch", "-r"], { cwd: repoPath });
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function hasBranch(repoPath, branch) {
  const branches = await listRemoteBranches(repoPath);
  return branches.some((b) => b === `origin/${branch}` || b.endsWith(`/${branch}`));
}

// ---- sync helpers ---------------------------------------------------------
// Used by `ym sync <branch>` for the stash-switch-pull-switch-restore dance.
// All operations are safe: no force, no rebase, no reset. Failures leave the
// repo in a known state and surface a reason string.

// Returns the name of the in-progress operation (merge, rebase, etc.) if
// the repo is mid-operation, or null if it's idle.
export function inMidState(repoPath) {
  if (!isRepo(repoPath)) return null;
  const gitDir = path.join(repoPath, ".git");
  const indicators = [
    ["MERGE_HEAD", "merge"],
    ["REBASE_HEAD", "rebase"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["BISECT_LOG", "bisect"],
  ];
  for (const [file, label] of indicators) {
    if (fs.existsSync(path.join(gitDir, file))) return label;
  }
  return null;
}

// True if the user is on a detached HEAD (no current branch name).
export function isDetached(repoPath) {
  return currentBranch(repoPath) === "HEAD";
}

// Looks up `refs/remotes/origin/<branch>` directly — assumes a `fetch` ran
// just before. Returns true if origin has that branch.
export async function remoteHasBranch(repoPath, branch) {
  const r = await run(
    "git",
    ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
    { cwd: repoPath },
  );
  return r.code === 0;
}

// Stash everything (tracked + untracked) under a tagged message. Returns
// { ok, ref, message } on success or { ok: false, error } on failure.
// Caller MUST call this only when there's something to stash (we check
// `isDirty` separately) — `git stash push` on a clean tree succeeds but
// creates nothing, which would mislead callers.
export async function stashSave(repoPath, message) {
  const r = await run(
    "git",
    ["stash", "push", "--include-untracked", "-m", message],
    { cwd: repoPath },
  );
  if (r.code !== 0) {
    return { ok: false, error: r.stderr || r.stdout || "stash push failed" };
  }
  // Brand-new stash is always stash@{0}.
  return { ok: true, ref: "stash@{0}", message };
}

// Apply a stash, preferring to restore the index too. Returns
// { ok, conflict, stderr }. Never drops the stash — caller decides.
export async function applyStash(repoPath, ref) {
  // Try with --index first (restores staging state).
  let r = await run("git", ["stash", "apply", "--index", ref], { cwd: repoPath });
  if (r.code === 0) return { ok: true, conflict: false };

  // --index can fail purely because the saved index can't be reapplied
  // (rare, but git docs note it). Plain apply doesn't restore staging but
  // still gets the working-tree changes back. Try that.
  r = await run("git", ["stash", "apply", ref], { cwd: repoPath });
  if (r.code === 0) return { ok: true, conflict: false };

  // Both failed → real conflict. Check porcelain for unmerged paths.
  const status = await run("git", ["status", "--porcelain"], { cwd: repoPath });
  const hasUnmerged = /^(UU|AA|DD|AU|UA|DU|UD) /m.test(status.stdout);
  return { ok: false, conflict: hasUnmerged, stderr: r.stderr };
}

export async function stashDrop(repoPath, ref) {
  return run("git", ["stash", "drop", ref], { cwd: repoPath });
}

// Pull, refusing anything that isn't a fast-forward. Never auto-merges or
// rebases — if origin/<branch> has diverged from the local branch, this
// fails non-fatally and the caller treats it as a warning.
export async function pullFFOnly(repoPath, branch) {
  const r = await run("git", ["pull", "--ff-only", "origin", branch], { cwd: repoPath });
  return { ok: r.code === 0, stderr: r.stderr, stdout: r.stdout };
}

// ---- status snapshot ------------------------------------------------------
// Single-shot async snapshot used by `ym status`. Combines branch, sha,
// dirty, and behind-count into ONE `git status --branch --porcelain=v2`
// call per repo so we can Promise.all across all repos. Replaces the
// previous pattern of three sequential runSync calls per repo, which on
// Windows added up to ~5s for a 15-service stack.
//
// Returns null if not a repo, or { branch, sha, dirty, behind, ahead } on
// success. `behind` is null when no upstream is tracked.
export async function gatherStatusSnapshot(repoPath) {
  if (!isRepo(repoPath)) return null;
  const r = await run(
    "git",
    ["status", "--branch", "--porcelain=v2"],
    { cwd: repoPath },
  );
  if (r.code !== 0) {
    return { branch: null, sha: null, dirty: false, behind: null, ahead: null };
  }

  let branch = null;
  let sha = null;
  let ahead = null;
  let behind = null;
  let dirty = false;

  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      branch = line.slice("# branch.head ".length).trim();
      // Match the legacy `currentBranch()` return value of "HEAD" when
      // detached. git emits the literal "(detached)" in porcelain=v2.
      if (branch === "(detached)") branch = "HEAD";
    } else if (line.startsWith("# branch.oid ")) {
      sha = line.slice("# branch.oid ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) {
        ahead = parseInt(m[1], 10);
        behind = parseInt(m[2], 10);
      }
    } else if (/^[12u?!] /.test(line)) {
      // Any line starting with 1/2/u/?/! (changed, renamed, unmerged,
      // untracked, ignored) means the worktree isn't clean — except an
      // untracked ym-managed file like `.env` (see isIgnorableUntracked).
      if (!isIgnorableUntracked(line)) dirty = true;
    }
  }
  return { branch, sha, dirty, behind, ahead };
}
