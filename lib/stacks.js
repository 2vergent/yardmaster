// =============================================================================
// Stacks — the unified concept replacing both presets and profiles.
//
// A stack is a named configuration of the dev environment:
//   - services:  which services should be active (required)
//   - branches:  per-service git branch (optional)
//   - env:       an environment from services.yaml (optional)
//
// A stack with branches/env is "snapshot-flavored" — apply restores them.
// A stack without them is "template-flavored" — apply only switches the
// active service set; git state and env are left alone.
//
// Two origins:
//   built-in   - defined in services.yaml's `stacks:` block. Always
//                template-flavored (service list only).
//   user-saved - stored under .ym/state.json's `stacks` key. Either flavor,
//                depending on how it was created.
//
// Authoring vs. snapshotting (decoupled):
//   create  - design a new stack via a picker. Does not touch active state.
//             Always produces a template (no branches/env).
//   edit    - modify an existing stack's service list via a picker. Does
//             not touch active state. Branches/env of services that remain
//             are preserved; entries for removed services are pruned.
//   save    - bookmark the *current* active state. Default = services only
//             (template). --with-branches / --with-env upgrade to snapshot.
//
// Loading a stack OVERWRITES the active selection. Saving promotes current
// state into a named slot. The model mirrors `git switch` — no auto-commit,
// no auto-save. To preserve current state before switching stacks, the user
// explicitly `ym stack save`s.
// =============================================================================

import fs from "fs";
import path from "path";
import { YM_ROOT } from "./bootstrap.js";
import { loadServices, envNames } from "./services.js";
import * as presets from "./presets.js";
import * as state from "./state.js";
import * as git from "./git.js";

// Combined list of all available stacks: built-ins from yaml + user-saved
// from state, in that order. Each entry has a `kind` so callers can format
// them differently.
export function listStacks() {
  const builtIns = presets.listPresets().map((p) => ({
    kind: "built-in",
    key: p.key,
    label: p.label,
    description: p.description,
    services: p.services,
    count: p.count,
  }));

  const saved = state.getState().stacks || {};
  const userStacks = Object.entries(saved).map(([name, def]) => ({
    kind: "user",
    key: name,
    label: name,
    description: "",
    services: def.services || [],
    branches: def.branches || {},
    env: def.env || null,
    saved_at: def.saved_at || null,
    count: (def.services || []).length,
  }));

  return [...builtIns, ...userStacks];
}

export function getStack(name) {
  return listStacks().find((s) => s.key === name) || null;
}

export function isBuiltIn(name) {
  return presets.getPreset(name) !== null;
}

export function userStackExists(name) {
  const saved = state.getState().stacks || {};
  return Boolean(saved[name]);
}

// Apply a stack. Returns a result describing what happened so the caller
// can print a useful summary.
//
//   - Built-in: just set selected_services. Branches and env are untouched.
//   - User-saved: set selected_services AND (if captured) switch repos to
//                 their saved branches AND (if captured) regen env files.
//
// No prompts (option β — match git switch). Dirty repos are SKIPPED by the
// underlying syncAll call; the user can pass { dirtyMode: "stash" } via
// applyOpts if they want.
export async function applyStack(name, applyOpts = {}) {
  const stack = getStack(name);
  if (!stack) throw new Error(`unknown stack: ${name}`);

  if (stack.kind === "built-in") {
    presets.applyPreset(name);
    return { kind: "built-in", services: stack.services };
  }

  // User-saved: services + (optional) branches + (optional) env.
  // Record `user_stack_key` so a later `ym stack edit <same>` can detect
  // that this user is currently running the stack and auto-refresh the
  // active selection if the two haven't diverged.
  const s = state.getState();
  s.stack_key = null;
  s.user_stack_key = name;
  s.selected_services = [...stack.services];
  state.saveState(s);

  let branchResults = null;
  if (stack.branches && Object.keys(stack.branches).length > 0) {
    branchResults = await switchPerRepoBranches(
      stack.branches,
      applyOpts.dirtyMode ?? "skip",
    );
  }

  let envApplied = null;
  if (stack.env && envNames().includes(stack.env)) {
    // Defer the actual env regen to commands.js — keeps the import graph
    // simple (stacks.js doesn't need to know about env-compiler.js).
    envApplied = stack.env;
  }

  return {
    kind: "user",
    services: stack.services,
    branches: stack.branches || {},
    env: stack.env,
    branchResults,
    envApplied,
  };
}

// Internal: switch each repo in `branchMap` ({svc: branch}) to its target
// branch using the same safety machinery as `ym switch` (skip dirty by
// default, stash with --stash, no force/rebase/reset).
//
// Groups by target branch so that syncAll's LiveTable renders one section
// per unique target. For the common case (all repos on the same branch),
// this is just one call.
async function switchPerRepoBranches(branchMap, dirtyMode) {
  const { syncAll } = await import("./sync.js");

  // Group repos by their target branch.
  const byBranch = new Map();
  for (const [svc, branch] of Object.entries(branchMap)) {
    if (!byBranch.has(branch)) byBranch.set(branch, []);
    byBranch.get(branch).push(svc);
  }

  const allResults = [];
  for (const [branch, services] of byBranch) {
    const { results } = await syncAll(branch, {
      stayOnTarget: true,
      dirtyMode,
      commandTag: "ym-stack",
      services,
    });
    allResults.push(...results);
  }
  return allResults;
}

// Snapshot the current active state as a stack. Default = services-only
// template. Flags opt-in to the snapshot layers.
//
//   opts.withBranches  capture each cloned repo's current branch
//   opts.withEnv       capture the current environment
//
// Re-saving with different flags is the supported way to flip a stack
// between template and snapshot flavor (e.g. `ym stack save my-stack` with
// no flags strips an existing branches/env layer).
export function saveStack(name, opts = {}) {
  validateUserName(name);

  const services = presets.activeServiceNames();
  if (!services.length) {
    throw new Error("no active selection to save");
  }

  const stackData = {
    saved_at: new Date().toISOString(),
    services: [...services],
  };
  if (opts.withBranches) {
    stackData.branches = captureBranches(services);
  }
  if (opts.withEnv) {
    const env = state.getEnv();
    if (env) stackData.env = env;
  }

  writeUserStack(name, stackData);
  return { name, ...stackData };
}

// Create a new user stack from an explicit service list. Authoring is
// decoupled from active state — this only writes to .ym/state.json's
// stacks slot. Always template-flavored.
export function createStack(name, services) {
  validateUserName(name);
  if (userStackExists(name)) {
    throw new Error(`stack "${name}" already exists — \`ym stack edit ${name}\` to modify, or \`ym stack delete ${name}\` first`);
  }
  if (!Array.isArray(services) || services.length === 0) {
    throw new Error("createStack: services list is required and must be non-empty");
  }

  const stackData = {
    saved_at: new Date().toISOString(),
    services: [...services],
  };
  writeUserStack(name, stackData);
  return { name, ...stackData };
}

// Replace an existing user stack's service list. Preserves any captured
// branches for services that remain in the list; entries for removed
// services are dropped. env is preserved as-is (edit doesn't snapshot).
//
// If this is the currently-active user stack (s.user_stack_key === name)
// AND the active selection hasn't drifted from the stack's pre-edit
// definition, also refresh selected_services so `ym up` picks up the
// change naturally. If the selection has drifted (e.g. ad-hoc `ym add`
// since apply), leave it alone and signal back to the caller so it can
// print a divergence hint.
//
// Return shape adds two booleans:
//   activeRefreshed     — we updated selected_services
//   divergedFromActive  — this is the active stack, but selection drifted
//                         so we did NOT auto-refresh
// Exactly one (or neither) is true; both true is impossible by construction.
export function editStack(name, services) {
  if (isBuiltIn(name)) {
    throw new Error(`'${name}' is a built-in stack — copy first: ym stack create <new-name> --from ${name}`);
  }
  if (!userStackExists(name)) {
    throw new Error(`no such user-saved stack: ${name}`);
  }
  if (!Array.isArray(services) || services.length === 0) {
    throw new Error("editStack: services list is required and must be non-empty");
  }

  const s = state.getState();
  const existing = s.stacks[name];
  const updated = {
    ...existing,
    services: [...services],
    saved_at: new Date().toISOString(),
  };
  if (existing.branches) {
    const keep = {};
    for (const svc of services) {
      if (existing.branches[svc]) keep[svc] = existing.branches[svc];
    }
    if (Object.keys(keep).length > 0) {
      updated.branches = keep;
    } else {
      delete updated.branches;
    }
  }
  s.stacks[name] = updated;

  // Auto-refresh active selection if (a) this is the active user stack
  // and (b) selection still matches the stack's pre-edit definition.
  let activeRefreshed = false;
  let divergedFromActive = false;
  if (s.user_stack_key === name) {
    if (selectionMatches(s.selected_services, existing.services)) {
      s.selected_services = [...services];
      activeRefreshed = true;
    } else {
      divergedFromActive = true;
    }
  }

  state.saveState(s);
  return { name, ...updated, activeRefreshed, divergedFromActive };
}

// Set-equality on two service-name arrays. Order-insensitive, ignores
// nullish on either side.
function selectionMatches(a, b) {
  const sa = new Set(a || []);
  const sb = new Set(b || []);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

// ---- helpers --------------------------------------------------------------

function validateUserName(name) {
  if (!name || typeof name !== "string") {
    throw new Error("stack name is required");
  }
  if (isBuiltIn(name)) {
    throw new Error(`'${name}' is a built-in stack — pick a different name`);
  }
}

function captureBranches(services) {
  const branches = {};
  for (const svc of services) {
    const repoPath = path.join(YM_ROOT, svc);
    if (fs.existsSync(repoPath) && git.isRepo(repoPath)) {
      const br = git.currentBranch(repoPath);
      if (br && br !== "HEAD") branches[svc] = br;
    }
  }
  return branches;
}

function writeUserStack(name, stackData) {
  const s = state.getState();
  s.stacks = s.stacks || {};
  s.stacks[name] = stackData;
  state.saveState(s);
}

export function deleteStack(name) {
  if (isBuiltIn(name)) {
    throw new Error(`'${name}' is a built-in stack — cannot delete`);
  }
  const s = state.getState();
  if (!s.stacks || !s.stacks[name]) {
    throw new Error(`no such user-saved stack: ${name}`);
  }
  delete s.stacks[name];
  if (s.user_stack_key === name) s.user_stack_key = null;
  state.saveState(s);
}

// Snapshot of "what's currently active" — for `ym stack show`. Composes
// data from across services.yaml + state + git.
export function currentSnapshot() {
  const services = presets.activeServiceNames();
  const active = presets.activeSelection();
  const s = state.getState();

  const branches = {};
  for (const svcName of services) {
    const repoPath = path.join(YM_ROOT, svcName);
    if (fs.existsSync(repoPath) && git.isRepo(repoPath)) {
      const br = git.currentBranch(repoPath);
      if (br) branches[svcName] = br;
    }
  }

  return {
    currentKey: active.stackKey || null,
    userStackKey: s.user_stack_key || null,
    services,
    branches,
    env: state.getEnv(),
  };
}
