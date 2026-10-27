// Cross-platform "open this URL/path in default app".

import { spawn } from "child_process";

export function openExternal(target) {
  const platform = process.platform;
  let cmd;
  let args = [];

  if (platform === "win32") {
    // `start` is a CMD builtin; using cmd /c is the most reliable invocation
    // and works from any parent shell (CMD, PowerShell, Git Bash).
    // The empty "" is the window title — `start` consumes the first quoted
    // arg as the title, so we pass an explicit empty title.
    cmd = "cmd";
    args = ["/c", "start", "", target];
  } else if (platform === "darwin") {
    cmd = "open";
    args = [target];
  } else {
    cmd = "xdg-open";
    args = [target];
  }

  try {
    const child = spawn(cmd, args, {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
