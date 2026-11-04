// Reusable interactive prompts for the ym CLI. Every command that takes a
// named argument (service, preset, profile, env, branch) calls one of these
// helpers when the user omits the positional — falling back to a real
// keyboard-driven picker instead of erroring out.
//
// Each helper:
//   - guards against non-TTY contexts (CI, pipes) with a clean error
//   - wraps inquirer's Ctrl+C handling so canceled prompts exit cleanly
//   - bails fast if the list is empty, with a meaningful message
//
// Library: @inquirer/prompts. Auto-installed via lib/bootstrap.js the
// same way `yaml` is.

import {
  select,
  checkbox,
  search,
  input,
  confirm,
} from "@inquirer/prompts";
import { c, fail } from "./term.js";

// ---- TTY guardrail --------------------------------------------------------

function requireTTY(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail(
      `${label} needs an interactive terminal.\n` +
      `Pass the argument explicitly (e.g. \`ym shell web\`) when running in pipes or CI.`,
    );
    process.exit(1);
  }
}

// Ctrl+C surfaces as ExitPromptError from inquirer. Treat as a clean cancel,
// no stack trace. Exit code 130 is the conventional "killed by SIGINT" value.
//
// `onAbort` (optional) handles the case where a passed-in AbortSignal fires
// — used for timeouts. Returning a value from the handler lets the caller
// substitute a default.
//
// Gotcha: empirically, inquirer raises an ExitPromptError when an
// AbortSignal aborts (same name it uses for Ctrl+C). We disambiguate by
// checking opts.signal.aborted — if the signal is in aborted state when we
// catch the error, this was our timeout, not the user hitting Ctrl+C.
async function guarded(fn, opts = {}) {
  try {
    return await fn();
  } catch (err) {
    // Our timeout fired → fall back to the default.
    if (opts.onAbort && opts.signal?.aborted) {
      return opts.onAbort();
    }
    // Real Ctrl+C → clean cancel.
    if (err && err.name === "ExitPromptError") {
      process.stdout.write("\n" + c.gray("Canceled.\n"));
      process.exit(130);
    }
    throw err;
  }
}

// ---- Single-select --------------------------------------------------------
// items: [{ value, label, description?, disabled? }]
//
// opts.timeoutMs (optional): if the user doesn't make a selection within
// this many milliseconds, resolves to opts.default instead. Requires
// opts.default to be set, otherwise the timeout has nothing to fall back
// to and is ignored. Hard ceiling — keystrokes don't reset the timer.
export async function pickOne(message, items, opts = {}) {
  requireTTY(opts.tag || "Selection");
  if (items.length === 0) {
    fail(opts.emptyMessage || "Nothing to pick from");
    process.exit(1);
  }

  let abortController = null;
  let timeoutId = null;
  if (opts.timeoutMs && opts.default !== undefined) {
    abortController = new AbortController();
    timeoutId = setTimeout(() => abortController.abort(), opts.timeoutMs);
  }

  try {
    return await guarded(
      () =>
        select({
          message,
          choices: items.map((it) => ({
            name: it.label ?? String(it.value),
            value: it.value,
            description: it.description,
            disabled: it.disabled,
          })),
          default: opts.default,
          pageSize: opts.pageSize ?? 15,
          loop: false,
          signal: abortController?.signal,
        }),
      {
        onAbort: () => opts.default,
        signal: abortController?.signal,
      },
    );
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// ---- Search (large lists, type-to-filter) ---------------------------------
// items: same shape as pickOne. Use when list is >20 items.
export async function searchOne(message, items, opts = {}) {
  requireTTY(opts.tag || "Selection");
  if (items.length === 0) {
    fail(opts.emptyMessage || "Nothing to pick from");
    process.exit(1);
  }
  return guarded(() =>
    search({
      message,
      source: async (term) => {
        const t = (term || "").toLowerCase();
        return items
          .filter((it) => {
            if (!t) return true;
            const hay = (it.label ?? String(it.value)).toLowerCase();
            return hay.includes(t);
          })
          .map((it) => ({
            name: it.label ?? String(it.value),
            value: it.value,
            description: it.description,
          }));
      },
      pageSize: opts.pageSize ?? 15,
    }),
  );
}

// ---- Multi-select with pre-checked items ---------------------------------
// items: [{ value, label, checked?, description?, disabled? }]
export async function pickMany(message, items, opts = {}) {
  requireTTY(opts.tag || "Selection");
  if (items.length === 0) {
    fail(opts.emptyMessage || "Nothing to pick from");
    process.exit(1);
  }
  return guarded(() =>
    checkbox({
      message,
      choices: items.map((it) => ({
        name: it.label ?? String(it.value),
        value: it.value,
        checked: it.checked === true,
        description: it.description,
        disabled: it.disabled,
      })),
      pageSize: opts.pageSize ?? 20,
      loop: false,
      instructions: opts.instructions ??
        c.gray(" (<space> toggle, <a> all, <i> invert, <enter> confirm)"),
      required: opts.required !== false,
    }),
  );
}

// ---- Free text input ------------------------------------------------------
export async function askText(message, opts = {}) {
  requireTTY(opts.tag || "Text input");
  return guarded(() =>
    input({
      message,
      default: opts.default,
      validate: opts.validate,
    }),
  );
}

// ---- Yes/no confirmation --------------------------------------------------
export async function askConfirm(message, opts = {}) {
  requireTTY(opts.tag || "Confirmation");
  return guarded(() =>
    confirm({
      message,
      default: opts.default ?? true,
    }),
  );
}

// ---- Pick from a fixed list OR type something else ------------------------
// Common case for `ym sync` where there are 2-3 well-known branches but the
// user might be on something custom. Renders as a select with an "Other…"
// sentinel; if chosen, prompts for free text.
const OTHER = Symbol("other");

export async function pickOneOrType(message, items, opts = {}) {
  requireTTY(opts.tag || "Selection");
  const choices = [
    ...items,
    { value: OTHER, label: c.gray("Other (type a value)…") },
  ];
  const picked = await pickOne(message, choices, opts);
  if (picked !== OTHER) return picked;
  return askText(opts.otherPrompt ?? "Type a value:", {
    default: opts.otherDefault,
    validate: opts.validate,
  });
}
