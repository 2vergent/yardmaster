// Resolve how to run `npm install` for services that pin a specific Node
// major (services.yaml `node_version`) different from the Node running ym.
//
// Strategy (cross-platform, in priority order):
//   1. Already on the required major  → use npm directly.
//   2. YM_NPM_NODE<major> env var set → use that npm verbatim (escape hatch
//                                       for users who don't want a version mgr).
//   3. fnm on PATH                    → `fnm exec --using <major> -- npm`,
//                                       after a one-time `fnm install <major>`.
//   4. none                           → actionable error; the service's install
//                                       fails with a fix hint instead of an
//                                       inscrutable node-gyp/sharp build error.
//
// fnm is the recommended path: one static binary that installs cleanly on
// Windows (winget/scoop), macOS (brew), and Linux (curl), and whose
// per-process `exec` model is safe with ym's parallel installs (unlike
// nvm/nvm-windows, whose `use` mutates global/shell state).

import { commandExists, run } from "./exec.js";
import { c } from "./term.js";

const IS_WIN = process.platform === "win32";
const NPM = IS_WIN ? "npm.cmd" : "npm";
const CURRENT_MAJOR = process.versions.node.split(".")[0];

// The pinned major for a service, or null if it doesn't pin one (or pins the
// version we're already running).
export function requiredMajor(svc) {
  return svc && svc.node_version ? String(svc.node_version).split(".")[0] : null;
}

// Decide how to invoke npm for one service. Pure + synchronous (no installs
// happen here — see ensureNodeMajors for that).
//   { cmd, prefix, via, major }  → run(cmd, [...prefix, "install", ...])
//   { error: true, major }       → pinned but unreachable; caller fails the svc
export function npmRunnerFor(svc) {
  const major = requiredMajor(svc);
  if (!major || major === CURRENT_MAJOR) {
    return { cmd: NPM, prefix: [], via: null, major: null };
  }

  const envNpm = process.env[`YM_NPM_NODE${major}`];
  if (envNpm) {
    return { cmd: envNpm, prefix: [], via: `YM_NPM_NODE${major}`, major };
  }

  if (commandExists("fnm")) {
    // `fnm exec` spawns without a shell, so Windows needs the explicit npm.cmd.
    return { cmd: "fnm", prefix: ["exec", "--using", major, "--", NPM], via: "fnm", major };
  }

  return { error: true, major };
}

// Pre-install every distinct pinned Node major ONCE, before the parallel
// provisioning loop — calling `fnm install` concurrently from each task would
// race. No-op when fnm is absent (the per-service runner then surfaces the
// actionable failure) or when YM_NPM_NODE<major> is the resolution path.
export async function ensureNodeMajors(majors) {
  const uniq = [...new Set((majors || []).filter((m) => m && m !== CURRENT_MAJOR))];
  if (uniq.length === 0) return;
  if (!commandExists("fnm")) return;

  for (const major of uniq) {
    if (process.env[`YM_NPM_NODE${major}`]) continue;   // explicit npm; skip fnm
    process.stdout.write(c.gray(`  Ensuring Node ${major} via fnm …\n`));
    const r = await run("fnm", ["install", major]);     // idempotent
    if (r.code !== 0) {
      process.stdout.write(
        c.yellow(`  ! fnm install ${major} reported an issue; will try an existing copy\n`),
      );
    }
  }
}

// Multi-line, copy-pasteable fix for the deferred-error block in repos.js.
export function nodeFixHint(major) {
  return (
    `Needs Node ${major}, but ym is running on Node ${CURRENT_MAJOR}.\n` +
    `    Install fnm (one-time, cross-platform) and ym handles the rest:\n` +
    `      Windows:  winget install Schniz.fnm     # or: scoop install fnm\n` +
    `      macOS:    brew install fnm\n` +
    `      Linux:    curl -fsSL https://fnm.vercel.app/install | bash\n` +
    `    Or set YM_NPM_NODE${major} to a Node ${major} npm executable.`
  );
}

// For doctor: is the toolchain for `major` reachable without any install?
export function nodeMajorReachable(major) {
  return major === CURRENT_MAJOR
    || !!process.env[`YM_NPM_NODE${major}`]
    || commandExists("fnm");
}

export { CURRENT_MAJOR };
