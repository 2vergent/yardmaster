// Terminal helpers: ANSI colors (auto-disabled on dumb terminals or NO_COLOR),
// spinner, sections, table printing. Cross-shell safe.

import process from "process";

const supportsColor =
  process.stdout.isTTY &&
  process.env.TERM !== "dumb" &&
  !process.env.NO_COLOR;

function wrap(open, close) {
  if (!supportsColor) return (s) => String(s);
  return (s) => `\x1b[${open}m${s}\x1b[${close}m`;
}

export const c = {
  reset: wrap(0, 0),
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
  bgRed: wrap(41, 49),
  bgGreen: wrap(42, 49),
};

// Section heading. Bold label, optional subtitle separated by a gray
// em-dash. NO horizontal bars (they dominate the eye and arbitrary-fill
// to terminal width is ugly).
//
// Contract:
//   - One blank line ABOVE the heading, NO blank line below.
//     Caller manages spacing between heading and body.
//   - Only the em-dash is auto-styled (gray). The subtitle itself is
//     printed verbatim — caller passes the desired styling. This lets
//     section() show:
//        Status  — env=staging · stack: <bold>essentials</bold>    (caller wraps in gray)
//        Doctor  — <green>Healthy</green>                       (caller picks color)
//
// Examples:
//   section("Doctor", c.green("Healthy"))
//   section("Status", c.gray("env=staging · stack: essentials"))
export function section(title, subtitle = "") {
  const sub = subtitle ? `  ${c.gray("—")} ${subtitle}` : "";
  process.stdout.write(`\n${c.bold(title)}${sub}\n`);
}

export function ok(msg) {
  process.stdout.write(`${c.green("✓")} ${msg}\n`);
}

export function warn(msg) {
  process.stdout.write(`${c.yellow("!")} ${msg}\n`);
}

export function fail(msg) {
  process.stdout.write(`${c.red("✖")} ${msg}\n`);
}

export function info(msg) {
  process.stdout.write(`${c.gray("·")} ${msg}\n`);
}

// Next-step hint. Distinct glyph (↳) from info (·) so trailing
// "what-to-do-next" suggestions are visually separable from state notes.
// Always gray — these are advisory, never urgent.
export function nextStep(msg) {
  process.stdout.write(`${c.gray("↳")} ${c.gray(msg)}\n`);
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinner(message) {
  // Returns { update(msg), stop(symbol, finalMsg) }.
  // On non-TTY just logs once and noops the rest.
  if (!process.stdout.isTTY) {
    process.stdout.write(`${message}\n`);
    return { update() {}, stop() {} };
  }

  let i = 0;
  let current = message;
  const interval = setInterval(() => {
    process.stdout.write(
      `\r${c.cyan(SPINNER_FRAMES[i++ % SPINNER_FRAMES.length])} ${current}`,
    );
  }, 80);

  return {
    update(msg) {
      current = msg;
    },
    stop(symbol = c.green("✓"), finalMsg = current) {
      clearInterval(interval);
      process.stdout.write(`\r${symbol} ${finalMsg}${" ".repeat(20)}\n`);
    },
  };
}

export function table(rows, headers) {
  if (rows.length === 0) {
    process.stdout.write(c.gray("(empty)\n"));
    return;
  }
  const cols = headers.length;
  const widths = headers.map((h, i) =>
    Math.max(
      stripAnsi(h).length,
      ...rows.map((r) => stripAnsi(String(r[i] ?? "")).length),
    ),
  );
  const fmt = (cells) =>
    cells
      .map((cell, i) => {
        const s = String(cell ?? "");
        const padBy = widths[i] - stripAnsi(s).length;
        return s + " ".repeat(Math.max(0, padBy));
      })
      .join("  ");
  process.stdout.write(c.bold(fmt(headers)) + "\n");
  process.stdout.write(c.gray(widths.map((w) => "─".repeat(w)).join("  ")) + "\n");
  for (const row of rows) {
    process.stdout.write(fmt(row.slice(0, cols)) + "\n");
  }
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}
