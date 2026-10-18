#!/usr/bin/env node
// =============================================================================
// ym — yardmaster CLI dispatcher  (file: cli.js)
// =============================================================================
// All work happens in lib/commands.js; this file just routes.
//
// Why this file is `cli.js` and not `ym.js`: on Windows CMD, `ym.js` in the
// project directory would shadow the global `ym.cmd` shim because `.JS` is in
// PATHEXT and the current directory is searched first. Naming the source
// `cli.js` avoids that — the global command stays `ym` (via package.json's
// `bin: { ym: "./cli.js" }`).

import { HAS_WORKSPACE } from "./lib/bootstrap.js";
import { fail, nextStep } from "./lib/term.js";

const [, , command, ...args] = process.argv;

// Commands that make sense before a workspace (services.yaml) exists.
const WORKSPACE_FREE = new Set(["init", "help", "-h", "--help", "-v", "--version", "completion", "_complete"]);

async function main() {
  if (command === "init") {
    const { initWorkspace } = await import("./lib/init.js");
    return initWorkspace(args);
  }
  if (command === "-v" || command === "--version") {
    const { version } = await import("./lib/init.js");
    process.stdout.write(version() + "\n");
    return;
  }
  if (!HAS_WORKSPACE && !WORKSPACE_FREE.has(command)) {
    if (command === "_complete") return;
    fail("No services.yaml found in this folder or any parent.");
    nextStep("ym init      scaffold a new workspace here");
    nextStep("cd <workspace>   or run from inside an existing one");
    process.exit(1);
  }

  const cmd = await import("./lib/commands.js");
  switch (command) {
    case undefined:
      await cmd.overview();
      return;

    case "help":
    case "-h":
    case "--help":
      cmd.help();
      return;

    case "setup":
      await import("./lib/setup-impl.js");
      return;

    case "deps":
    case "install":
    case "i":            return cmd.deps(args);
    case "up":           return cmd.up(args);
    case "down":         return cmd.down();
    case "switch":       return cmd.switchBranch(args);
    case "env":          return cmd.env(args);
    case "checkout":     return cmd.checkout(args);
    case "status":       return cmd.status(args);
    case "logs":         return cmd.logs(args);
    case "restart":      return cmd.restart(args);
    case "shell":        return cmd.shell(args);
    case "open":         return cmd.open(args);
    case "code":         return cmd.code(args);
    case "workspace":    return cmd.workspace(args);
    case "doctor":       return cmd.doctor(args);
    case "regen":        return cmd.regen();
    case "update":       return cmd.update(args);
    case "sync":         return cmd.sync(args);
    case "add":          return cmd.add(args);
    case "remove":       return cmd.remove(args);
    case "stack":        return cmd.stack(args);
    case "completion":   return cmd.completion(args);
    case "_complete":    return cmd._complete(args);

    default:
      fail(`Unknown command: ${command}`);
      cmd.help();
      process.exit(1);
  }
}

main().catch((err) => {
  fail(err.message || String(err));
  if (process.env.YM_DEBUG) process.stderr.write((err.stack || "") + "\n");
  process.exit(1);
});
