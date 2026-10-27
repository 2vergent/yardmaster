// OS-native notifications. Best-effort — silently no-ops on unsupported setups.
// No external deps: uses each platform's built-in notification mechanism.

import { spawn } from "child_process";

const PLATFORM = process.platform;

export function notify(title, body, { urgency = "normal" } = {}) {
  if (process.env.YM_NO_NOTIFY) return;

  try {
    if (PLATFORM === "darwin") {
      const script = `display notification ${q(body)} with title ${q(title)}`;
      spawn("osascript", ["-e", script], { stdio: "ignore", detached: true }).unref();
      return;
    }

    if (PLATFORM === "linux") {
      const args = ["-u", urgency, title, body];
      spawn("notify-send", args, { stdio: "ignore", detached: true }).unref();
      return;
    }

    if (PLATFORM === "win32") {
      // Use Windows Runtime toast via PowerShell. Works on Win10+.
      const escTitle = winEscape(title);
      const escBody = winEscape(body);
      const ps = `
$ErrorActionPreference = 'SilentlyContinue'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastText02"><text id="1">${escTitle}</text><text id="2">${escBody}</text></binding></visual></toast>')
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('ym').Show($toast)
`.trim();
      spawn("powershell", ["-NoProfile", "-Command", ps], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      }).unref();
      return;
    }
  } catch {
    // best-effort
  }
}

function q(s) {
  return `"${String(s).replace(/"/g, '\\"')}"`;
}

function winEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&apos;");
}
