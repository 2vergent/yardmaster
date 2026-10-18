// Live multi-row progress table — Bun/pnpm/Tilt-style in-place rendering.
//
// Each row is a fixed slot for a unit of work. Rows update in place via ANSI
// cursor movement; on non-TTY (CI, redirects), falls back to one log line per
// state transition.

import { c } from "./term.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STATES = ["queued", "running", "done", "failed", "skipped"];

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\x1b[2K";

// ANSI Synchronized Output (CSI ? 2026 h/l) — modern terminals buffer
// everything between BEGIN_SYNC and END_SYNC and commit atomically, so the
// erase-then-rewrite cycle never appears as an intermediate blank state.
// Terminals without support ignore the sequence. Supported by Windows
// Terminal, iTerm2, Kitty, Alacritty, WezTerm, recent VTE (GNOME), Konsole.
const BEGIN_SYNC = "\x1b[?2026h";
const END_SYNC = "\x1b[?2026l";

// Refresh cadence. 100ms (10 fps) is plenty for spinner motion and
// per-second elapsed-time updates, and noticeably calmer than 80ms.
const REFRESH_MS = 100;

const TTY =
  process.stdout.isTTY &&
  process.env.TERM !== "dumb" &&
  !process.env.CI &&
  !process.env.NO_COLOR;

export class LiveTable {
  /**
   * @param {object}  opts
   * @param {string}  opts.title           Section title shown above the table.
   * @param {Array<{id:string,label:string}>} opts.items
   */
  constructor({ title, items }) {
    this.title = title;
    this.items = items.map((i) => ({
      id: i.id,
      label: i.label,
      state: "queued",
      step: "",
      detail: "",
      startedAt: null,
      endedAt: null,
    }));
    this.labelWidth = Math.min(
      40,
      Math.max(8, ...this.items.map((i) => i.label.length)),
    );
    this.startedAt = null;
    this.frame = 0;
    this.timer = null;
    this.printedLines = 0;
    this.byId = new Map(this.items.map((i) => [i.id, i]));
    this.stopped = false;
    this._sigintHandler = null;
  }

  start() {
    this.startedAt = Date.now();
    if (TTY) {
      process.stdout.write(HIDE_CURSOR);
      this._sigintHandler = () => {
        process.stdout.write(SHOW_CURSOR);
      };
      process.once("SIGINT", this._sigintHandler);
      process.once("exit", this._sigintHandler);
      this._render(false);
      this.timer = setInterval(() => {
        if (this.stopped) return;
        // Skip the frame entirely when nothing is actively running — there's
        // no spinner to animate and no elapsed counter to advance.
        const anyRunning = this.items.some((i) => i.state === "running");
        if (!anyRunning) return;
        this._render(false);
      }, REFRESH_MS);
    } else {
      // Non-TTY: just print the title; transitions log as single lines.
      if (this.title) process.stdout.write(`${this.title}\n`);
    }
  }

  /** Update a row. fields: { state?, step?, detail? } */
  update(id, fields) {
    const item = this.byId.get(id);
    if (!item) return;

    if (fields.state) {
      if (fields.state === "running" && item.state !== "running") {
        item.startedAt = Date.now();
      }
      if (
        (fields.state === "done" ||
          fields.state === "failed" ||
          fields.state === "skipped") &&
        !item.endedAt
      ) {
        item.endedAt = Date.now();
      }
      if (!STATES.includes(fields.state)) {
        throw new Error(`bad state: ${fields.state}`);
      }
      item.state = fields.state;
    }
    if (fields.step !== undefined) item.step = fields.step;
    if (fields.detail !== undefined) item.detail = fields.detail;

    if (!TTY) {
      // Non-TTY fallback: single-line transition log.
      const icon = this._iconChar(item, true);
      const time = item.endedAt && item.startedAt ? ` (${this._dur(item)})` : "";
      const step = item.step ? ` · ${item.step}` : "";
      const detail = item.detail ? c.gray(` · ${item.detail}`) : "";
      process.stdout.write(
        `  ${icon} ${item.label}${step}${time}${detail}\n`,
      );
    }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (TTY) {
      this._render(true);
      process.stdout.write(SHOW_CURSOR);
      if (this._sigintHandler) {
        process.removeListener("SIGINT", this._sigintHandler);
        process.removeListener("exit", this._sigintHandler);
      }
    }
  }

  // ---- summary --------------------------------------------------------------

  summary() {
    const total = this.items.length;
    const done = this.items.filter((i) => i.state === "done").length;
    const failed = this.items.filter((i) => i.state === "failed").length;
    const skipped = this.items.filter((i) => i.state === "skipped").length;
    const elapsed = this.startedAt ? Date.now() - this.startedAt : 0;
    return { total, done, failed, skipped, elapsed };
  }

  // ---- internal -------------------------------------------------------------

  _buildLines(final) {
    const lines = [];
    if (this.title) lines.push(c.bold(this.title));

    // Cap the visible row count to the viewport so the cursor-up erase loop
    // never tries to clear lines that scrolled into history (cursor-up
    // clamps at the viewport top; uncleared rows pile up as scrollback
    // pollution on every refresh). Final frame is exempt — by then we want
    // the complete result committed to scrollback in one shot.
    const viewport = process.stdout.rows || 24;
    const chrome = (this.title ? 1 : 0) + 1 + 1; // title + footer + breathing
    const slots = Math.max(3, viewport - chrome);

    if (final || this.items.length <= slots) {
      for (const item of this.items) lines.push(this._row(item, final));
    } else {
      // Overflow mode — prioritize active work, then recently finished, then
      // a roll-up counter. Total visible rows stay <= slots.
      const running = this.items.filter((i) => i.state === "running");
      const finished = this.items.filter(
        (i) => i.state === "done" || i.state === "failed" || i.state === "skipped",
      );
      const queued = this.items.filter((i) => i.state === "queued");

      const counterSlot = 1;
      const itemSlots = slots - counterSlot;
      const runningShown = running.slice(0, itemSlots);
      const finishedShown = finished.slice(
        -Math.max(0, itemSlots - runningShown.length),
      );

      for (const item of finishedShown) lines.push(this._row(item, false));
      for (const item of runningShown) lines.push(this._row(item, false));
      const hiddenFinished = finished.length - finishedShown.length;
      const parts = [];
      if (queued.length) parts.push(`${queued.length} queued`);
      if (hiddenFinished) parts.push(`${hiddenFinished} earlier done`);
      lines.push(c.gray(`  … ${parts.join(" · ")}`));
    }

    lines.push(this._footer(final));
    return lines;
  }

  _render(final) {
    const lines = this._buildLines(final);
    let buf = BEGIN_SYNC;
    for (let i = 0; i < this.printedLines; i++) {
      buf += `\x1b[1A${CLEAR_LINE}\r`;
    }
    buf += lines.join("\n") + "\n";
    buf += END_SYNC;
    process.stdout.write(buf);
    this.printedLines = lines.length;
    if (!final) this.frame++;
  }

  _row(item, final) {
    const icon = this._iconChar(item, final);
    const label = this._pad(item.label, this.labelWidth);
    const stepText = this._stepText(item);
    const time = this._timeText(item);
    return `  ${icon}  ${c.bold(label)}${stepText}${time}`;
  }

  _iconChar(item, final) {
    switch (item.state) {
      case "queued":
        return c.gray("○");
      case "running":
        return final
          ? c.yellow("◐")
          : c.cyan(FRAMES[this.frame % FRAMES.length]);
      case "done":
        return c.green("✓");
      case "failed":
        return c.red("✗");
      case "skipped":
        return c.gray("·");
      default:
        return " ";
    }
  }

  _stepText(item) {
    if (!item.step) return "";
    const color = item.state === "failed" ? c.red : c.gray;
    return "  " + color(item.step);
  }

  _timeText(item) {
    if (item.state === "running" && item.startedAt) {
      return c.gray(`  ${this._dur(item)}`);
    }
    if (item.endedAt && item.startedAt) {
      return c.gray(`  ${this._dur(item)}`);
    }
    return "";
  }

  _dur(item) {
    const ms = (item.endedAt ?? Date.now()) - item.startedAt;
    if (ms < 1000) return `${ms}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    const r = Math.round(s - m * 60);
    return `${m}m${r.toString().padStart(2, "0")}s`;
  }

  _pad(s, n) {
    if (s.length >= n) return s.slice(0, n);
    return s + " ".repeat(n - s.length);
  }

  _footer(final) {
    const { total, done, failed, skipped, elapsed } = this.summary();
    const running = this.items.filter((i) => i.state === "running").length;
    const queued = this.items.filter((i) => i.state === "queued").length;

    const parts = [];
    parts.push(c.green(`${done}/${total} ready`));
    if (failed) parts.push(c.red(`${failed} failed`));
    if (skipped) parts.push(c.gray(`${skipped} skipped`));
    if (!final && running) parts.push(c.cyan(`${running} running`));
    if (!final && queued) parts.push(c.gray(`${queued} queued`));
    parts.push(c.gray(`${this._fmtElapsed(elapsed)} elapsed`));

    return "  " + parts.join(c.gray("  ·  "));
  }

  _fmtElapsed(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const r = s - m * 60;
    return `${m}m${r.toString().padStart(2, "0")}s`;
  }
}

// ---- Single-task step renderer (sequential helper) -------------------------
// For sequential phases like the toolchain installer where each item runs
// one at a time. Same look as LiveTable rows but updates one slot.

export class StepLine {
  constructor(label) {
    this.label = label;
    this.state = "queued";
    this.detail = "";
    this.startedAt = null;
    this.endedAt = null;
    this.frame = 0;
    this.timer = null;
    this.dirty = true;
    this.printed = false;
  }

  start(detail = "") {
    this.state = "running";
    this.detail = detail;
    this.startedAt = Date.now();
    if (TTY) {
      process.stdout.write(this._line() + "\n");
      this.printed = true;
      this.timer = setInterval(() => this._redraw(), REFRESH_MS);
    } else {
      process.stdout.write(this._line(true) + "\n");
    }
  }

  update(detail) {
    this.detail = detail;
  }

  succeed(detail) {
    this.state = "done";
    this.endedAt = Date.now();
    if (detail !== undefined) this.detail = detail;
    this._finalize();
  }

  fail(detail) {
    this.state = "failed";
    this.endedAt = Date.now();
    if (detail !== undefined) this.detail = detail;
    this._finalize();
  }

  skip(detail) {
    this.state = "skipped";
    this.endedAt = Date.now();
    if (detail !== undefined) this.detail = detail;
    this._finalize();
  }

  _finalize() {
    if (this.timer) clearInterval(this.timer);
    if (TTY && this.printed) {
      // Sync-wrap the final swap so the line never blinks blank between
      // erase and rewrite.
      process.stdout.write(
        `${BEGIN_SYNC}\x1b[1A${CLEAR_LINE}\r${this._line(true)}\n${END_SYNC}`,
      );
    } else {
      process.stdout.write(this._line(true) + "\n");
    }
  }

  _redraw() {
    if (!TTY || !this.printed) return;
    this.frame++;
    process.stdout.write(
      `${BEGIN_SYNC}\x1b[1A${CLEAR_LINE}\r${this._line()}\n${END_SYNC}`,
    );
  }

  _line(final = false) {
    const icon = this._icon(final);
    const detail = this.detail ? c.gray("  " + this.detail) : "";
    let time = "";
    if (this.startedAt) {
      const ms = (this.endedAt ?? Date.now()) - this.startedAt;
      if (ms >= 200) {
        const s = (ms / 1000).toFixed(1);
        time = c.gray(`  ${s}s`);
      }
    }
    return `  ${icon}  ${c.bold(this.label)}${detail}${time}`;
  }

  _icon(final) {
    switch (this.state) {
      case "queued":
        return c.gray("○");
      case "running":
        return final
          ? c.yellow("◐")
          : c.cyan(FRAMES[this.frame % FRAMES.length]);
      case "done":
        return c.green("✓");
      case "failed":
        return c.red("✗");
      case "skipped":
        return c.gray("·");
      default:
        return " ";
    }
  }
}
