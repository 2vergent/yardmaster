// Local-only state for the ym CLI. Stored at .ym/state.json — resumable-
// setup checkpoints, active selection, and saved stacks.

import fs from "fs";
import path from "path";
import { YM_LOCAL } from "./bootstrap.js";
import { defaultEnv } from "./services.js";

const STATE_PATH = path.join(YM_LOCAL, "state.json");

function readJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8");
}

// --- setup state (resumability) ----------------------------------------------

export function getState() {
  return readJson(STATE_PATH, {
    setup_completed_at: null,
    steps: {},          // step_name -> { status: ok|fail, at: ISO }
    repos: {},          // service_name -> { cloned: bool, installed: bool, branch }
    selected_services: null,  // null = fall back to default stack; or string[]
    stacks: {},         // name -> { services, branches, env, saved_at } (ym stack save)
    env: null,          // active environment name from services.yaml
  });
}

export function saveState(state) {
  writeJson(STATE_PATH, state);
}

// --- active environment ------------------------------------------------------
// Falls back to services.yaml's default_environment until one is chosen.
export function getEnv() {
  return getState().env || defaultEnv();
}

export function setEnv(env) {
  const s = getState();
  s.env = env;
  saveState(s);
}

export function markStep(stepName, status = "ok") {
  const s = getState();
  s.steps[stepName] = { status, at: new Date().toISOString() };
  saveState(s);
}

export function isStepComplete(stepName) {
  const s = getState();
  return s.steps[stepName]?.status === "ok";
}

export function markRepo(serviceName, fields) {
  const s = getState();
  s.repos[serviceName] = { ...(s.repos[serviceName] || {}), ...fields };
  saveState(s);
}

export function resetState() {
  if (fs.existsSync(STATE_PATH)) fs.unlinkSync(STATE_PATH);
}

// --- workspace extra folders (ym workspace) ---------------------------------
// Absolute paths of non-service folders the dev wants folded into the
// generated yardmaster.code-workspace (other repos, or unrelated projects).
// Managed entirely via `ym workspace add|remove` — never hand-edited.
export function getWorkspaceExtra() {
  const s = getState();
  return Array.isArray(s.workspace_extra) ? s.workspace_extra : [];
}

export function setWorkspaceExtra(paths) {
  const s = getState();
  s.workspace_extra = [...paths];
  saveState(s);
}
