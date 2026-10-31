// Per-service git provisioning. Parallel-safe with bounded concurrency.
// Renders progress via lib/live.js (in-place multi-row table on TTY,
// one log line per transition on non-TTY).

import fs from "fs";
import path from "path";
import { c, fail } from "./term.js";
import { run, parallel } from "./exec.js";
import * as git from "./git.js";
import * as state from "./state.js";
import { LiveTable } from "./live.js";
import { YM_ROOT } from "./bootstrap.js";
import { envBranch, defaultEnv } from "./services.js";
import { npmRunnerFor, requiredMajor, ensureNodeMajors, nodeFixHint } from "./node-runner.js";

export async function provisionRepos(services, opts = {}) {
  const concurrency = opts.concurrency ?? 4;
  const baseBranch = envBranch(opts.env ?? defaultEnv());
  const branchOverrides = opts.branches ?? {};

  // If any service pins a Node major we're not running (services.yaml
  // `node_version`), make that toolchain available ONCE up front — doing it
  // here avoids N concurrent `fnm install` races inside the parallel loop.
  await ensureNodeMajors(services.map(requiredMajor));

  const live = new LiveTable({
    title: `Provisioning ${services.length} service(s) on branch '${baseBranch}'`,
    items: services.map((s) => ({ id: s.name, label: s.name })),
  });
  live.start();

  // Failure details collected here; printed AFTER live.stop() so the
  // in-place rendering layout stays intact while work is happening.
  const deferredErrors = [];

  const tasks = services.map((svc) => async () => {
    const repoPath = path.join(YM_ROOT, svc.name);
    const branch = branchOverrides[svc.name] ?? baseBranch;
    const set = (fields) => live.update(svc.name, fields);

    try {
      set({ state: "running", step: "queued" });

      // ----- companions (no own repo) -----
      // A `source:` companion (worker/merger) shares another service's clone —
      // there's nothing to fetch or install. Skip it as a no-op so setup/add
      // don't try to `git clone undefined`.
      if (!svc.repo) {
        set({ state: "skipped", step: svc.source ? `shares ${svc.source}` : "no repo — skipped" });
        return { svc: svc.name, ok: true, companion: true, branch: null };
      }

      // ----- clone -----
      if (!fs.existsSync(repoPath)) {
        set({ step: "cloning" });
        const r = await git.clone(svc.repo, repoPath);
        if (r.code !== 0) {
          set({ state: "failed", step: "clone failed" });
          deferredErrors.push({ svc: svc.name, phase: "clone", detail: r.stderr || r.stdout });
          return { svc: svc.name, ok: false, error: "clone" };
        }
        state.markRepo(svc.name, { cloned: true });
      }

      // ----- fetch + switch branch -----
      set({ step: "fetching" });
      await git.fetch(repoPath);

      // Safety: don't run `git checkout` on a dirty tree. Plain checkout
      // either refuses (when the dirty files conflict with the target
      // branch) or silently carries the changes across (when they don't),
      // either failing visibly or leaking the dev's uncommitted work onto
      // the wrong branch. Skip the switch entirely and surface a clear
      // "skipped" status so the caller (setup.js) can warn at the end.
      //
      // Fresh clones aren't dirty, so this only affects re-runs.
      let dirtySkip = false;
      if (git.isDirty(repoPath)) {
        const curBranch = git.currentBranch(repoPath);
        set({
          state: "skipped",
          step: `dirty — kept on ${curBranch || "current branch"}`,
        });
        dirtySkip = true;
      } else if (await git.hasBranch(repoPath, branch)) {
        set({ step: `switching → ${branch}` });
        // Resilient: a re-provision of an existing clone may have a ym-owned
        // untracked .env that blocks switching onto a branch that commits one.
        const r = await git.checkoutResilient(repoPath, branch);
        if (r.code === 0) {
          set({ step: "pulling" });
          await git.pull(repoPath, branch);
        }
      }

      // ----- npm install -----
      const pkg = path.join(repoPath, "package.json");
      const nm = path.join(repoPath, "node_modules");
      if (fs.existsSync(pkg) && !fs.existsSync(nm)) {
        // Resolve which npm/Node to use. A service can pin a Node major via
        // services.yaml `node_version` (e.g. a native dep that only builds on Node 18);
        // npmRunnerFor returns the right launcher (current npm, fnm exec, or
        // a YM_NPM_NODE<major> override), or an error if it can't be reached.
        const runner = npmRunnerFor(svc);
        if (runner.error) {
          set({ state: "failed", step: `needs Node ${runner.major} — toolchain unavailable` });
          deferredErrors.push({
            svc: svc.name,
            phase: "node version",
            detail: nodeFixHint(runner.major),
          });
          return { svc: svc.name, ok: false, error: "node-version" };
        }

        // Per-service npm registry (services.yaml `npm_registry`): scopes a
        // private registry to just this install without touching global config.
        const installArgs = [...runner.prefix, "install", "--silent", "--no-audit", "--no-fund"];
        if (svc.npm_registry) installArgs.push(`--registry=${svc.npm_registry}`);

        const tags = [];
        if (runner.via) tags.push(`Node ${runner.major} via ${runner.via}`);
        if (svc.npm_registry) tags.push("custom registry");
        set({ step: tags.length ? `installing deps (${tags.join(", ")})` : "installing deps" });

        const r = await run(runner.cmd, installArgs, { cwd: repoPath });
        if (r.code !== 0) {
          set({ state: "failed", step: `install failed (code ${r.code})` });
          deferredErrors.push({
            svc: svc.name,
            phase: "npm install",
            detail: r.stderr || r.stdout || "(no output)",
          });
          return { svc: svc.name, ok: false, error: "install" };
        }
        state.markRepo(svc.name, { installed: true });
      }

      // ----- finalize -----
      const sha = git.headSha(repoPath);
      const curBranch = git.currentBranch(repoPath);
      state.markRepo(svc.name, { branch: curBranch });

      // Already set state=skipped above for dirty repos; don't overwrite.
      if (!dirtySkip) {
        set({
          state: "done",
          step: `${curBranch} @ ${sha?.slice(0, 7)}`,
        });
      }
      return {
        svc: svc.name,
        ok: true,
        dirtySkip,
        branch: curBranch,
        targetBranch: branch,
      };
    } catch (err) {
      set({ state: "failed", step: err.message || "exception" });
      deferredErrors.push({
        svc: svc.name,
        phase: "exception",
        detail: err.stack || err.message || String(err),
      });
      return { svc: svc.name, ok: false, error: err.message || "exception" };
    }
  });

  const results = await parallel(tasks, concurrency);
  live.stop();

  // Now print any captured errors below the table.
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

  return results;
}
