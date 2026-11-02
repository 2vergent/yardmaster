// Preset operations: list, expand, estimate bootstrap time, persist active
// preset to state. Sits on top of services.js (read-only) and state.js (RW).

import { loadServices } from "./services.js";
import * as state from "./state.js";

// Returns [{ key, label, description, services: string[], count }, ...]
// in declaration order from services.yaml.
export function listPresets() {
  const { stacks } = loadServices();
  return Object.entries(stacks).map(([key, def]) => ({
    key,
    label: def.label || key,
    description: (def.description || "").trim(),
    services: expandPresetMembers(def.services || []),
    count: expandPresetMembers(def.services || []).length,
  }));
}

export function getPreset(key) {
  const all = listPresets();
  return all.find((p) => p.key === key) ?? null;
}

export function defaultPresetKey() {
  return loadServices().defaultStack || (listPresets()[0]?.key ?? null);
}

// Expand "*" sentinel to every service in services.yaml (in declaration order),
// excluding services marked `opt_in: true` — those need host-side prerequisites
// and must be pulled in by explicit name via a stack entry or `ym add`.
function expandPresetMembers(members) {
  const { services } = loadServices();
  const out = [];
  const seen = new Set();
  for (const ref of members) {
    if (ref === "*") {
      for (const s of services) {
        if (s.opt_in) continue;
        if (!seen.has(s.name)) {
          seen.add(s.name);
          out.push(s.name);
        }
      }
    } else if (!seen.has(ref)) {
      seen.add(ref);
      out.push(ref);
    }
  }
  return out;
}

// Rough estimate: ceil(count * 60s / concurrency) + 60s baseline.
// Surfaced in the UI so devs aren't surprised by a 25-min bootstrap.
export function estimateBootstrapSeconds(serviceCount, concurrency = 4) {
  return Math.ceil((serviceCount * 60) / concurrency) + 60;
}

export function formatDuration(seconds) {
  if (seconds < 90) return `~${seconds}s`;
  const m = Math.round(seconds / 60);
  return `~${m} min`;
}

// ---- Active preset (per-user, persisted in state) --------------------------

export function applyPreset(key) {
  const preset = getPreset(key);
  if (!preset) throw new Error(`unknown stack: ${key}`);
  const s = state.getState();
  s.stack_key = key;
  s.user_stack_key = null;  // moved off any user stack
  s.selected_services = preset.services;
  state.saveState(s);
  return preset;
}

export function applyCustomSelection(serviceNames) {
  const s = state.getState();
  s.stack_key = null;       // a custom selection isn't a named stack
  s.user_stack_key = null;  // ...nor a user stack
  s.selected_services = [...serviceNames];
  state.saveState(s);
}

// Append a single service to the active selection. Used by `ym add` so that
// the freshly-cloned service actually gets plumbed into the Tilt --only
// filter on the next `ym up` (otherwise it'd be cloned but never registered).
//
// If no selection is active yet (no preset, no custom), seed it from the
// default preset so we don't accidentally narrow the user's stack to just
// this one service.
//
// Returns true if the name was newly added, false if already present.
export function addToSelection(name) {
  const s = state.getState();
  if (!s.selected_services) {
    s.selected_services = [...defaultPresetServices()];
  }
  if (s.selected_services.includes(name)) return false;
  s.selected_services.push(name);
  state.saveState(s);
  return true;
}

// Remove a single service from the active selection. Used by `ym remove`.
// Seeds from the default preset if no selection is active yet (otherwise
// "remove" would be a no-op when the user expects the implicit default
// set to have something removed).
//
// Returns true if the name was actually removed, false if it wasn't there.
export function removeFromSelection(name) {
  const s = state.getState();
  if (!s.selected_services) {
    s.selected_services = [...defaultPresetServices()];
  }
  const idx = s.selected_services.indexOf(name);
  if (idx === -1) return false;
  s.selected_services.splice(idx, 1);
  state.saveState(s);
  return true;
}

export function activeSelection() {
  // Returns { stackKey, services } where services is the explicit selection
  // (stack-expanded or custom). null services means "no override applied;
  // falls back to the default stack" — see resolveActive() for the resolution.
  const s = state.getState();
  return {
    stackKey: s.stack_key ?? null,
    services: s.selected_services ?? null,
  };
}

// Resolve the active set of service NAMES that should be considered "running"
// for codegen / Tilt / status / etc.
//
// Three cases:
//   null  → no decision ever made (fresh install): fall back to default stack.
//   []    → user actively cleared the stack (e.g. `ym remove --purge` of
//           everything): return [] verbatim. Falling back here would silently
//           re-introduce the default stack into codegen / status / etc. and
//           confuse the user with services they thought they'd removed.
//   [..]  → explicit selection: use it as-is.
//
// This is the single source of truth for "what's active right now." Replaces
// the old `enabled: true` flag in services.yaml.
export function activeServiceNames() {
  const sel = activeSelection();
  if (sel.services !== null) return sel.services;
  return defaultPresetServices();
}

function defaultPresetServices() {
  const key = defaultPresetKey();
  if (!key) return [];
  const p = getPreset(key);
  return p ? p.services : [];
}

export function clearSelection() {
  const s = state.getState();
  s.stack_key = null;
  s.user_stack_key = null;
  s.selected_services = null;
  state.saveState(s);
}
