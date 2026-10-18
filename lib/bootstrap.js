// Shared paths: TOOL_ROOT is the installed yardmaster package (Tiltfile,
// scripts); YM_ROOT is the user's workspace (services.yaml, clones, .ym/).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Nearest ancestor of `start` holding services.yaml, or null.
function findWorkspace(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, "services.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const found = process.env.YM_ROOT
  ? path.resolve(process.env.YM_ROOT)
  : findWorkspace(process.cwd());

export const HAS_WORKSPACE = !!found;
export const YM_ROOT = found || process.cwd();

// Child processes (Tilt reads it in the Tiltfile) see the same workspace.
if (found) process.env.YM_ROOT = found;

// Per-machine state, vendored binaries, and runtime launchers live under .ym/.
export const YM_LOCAL = path.join(YM_ROOT, ".ym");
if (HAS_WORKSPACE) fs.mkdirSync(YM_LOCAL, { recursive: true });
