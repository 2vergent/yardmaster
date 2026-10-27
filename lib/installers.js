// Binary installers for Tilt + Nginx, by platform.

import fs from "fs";
import path from "path";
import os from "os";
import https from "https";
import { runInherit, commandExists, runSync } from "./exec.js";
import { warn } from "./term.js";
import { StepLine } from "./live.js";
import { YM_ROOT, YM_LOCAL, TOOL_ROOT } from "./bootstrap.js";

// Vendored binaries live under .ym/ so the workspace root stays clean.
const TILT_EXE = path.join(YM_LOCAL, "bin", "tilt.exe");   // Windows only
const NGINX_DIR = path.join(YM_LOCAL, "nginx");

// -------- Tilt ---------------------------------------------------------------

export async function ensureTilt() {
  const platform = os.platform();
  const step = new StepLine("Tilt");

  const hasTilt =
    (platform === "win32" && fs.existsSync(TILT_EXE)) ||
    commandExists("tilt");

  if (hasTilt) {
    step.start("checking");
    step.succeed("already installed");
    if (platform === "win32") copyTiltExeToYmBin();
    return;
  }

  step.start("installing");

  if (platform === "win32") {
    const r = await runInherit(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-Command",
        "iex ((New-Object Net.WebClient).DownloadString('https://raw.githubusercontent.com/tilt-dev/tilt/master/scripts/install.ps1'))",
      ],
      { stdio: "ignore" },
    );
    if (r !== 0) {
      step.fail("install failed");
      throw new Error("Tilt install failed");
    }
    copyTiltExeToYmBin();
    step.succeed("installed");
    return;
  }

  if (platform === "darwin") {
    const r = await runInherit("brew", ["install", "tilt-dev/tap/tilt"], {
      stdio: "ignore",
    });
    if (r !== 0) {
      step.fail("brew install failed");
      throw new Error("brew install tilt failed");
    }
    step.succeed("installed via brew");
    return;
  }

  if (platform === "linux") {
    const r = await runInherit(
      "bash",
      [
        "-c",
        "curl -fsSL https://raw.githubusercontent.com/tilt-dev/tilt/master/scripts/install.sh | bash",
      ],
      { stdio: "ignore" },
    );
    if (r !== 0) {
      step.fail("installer failed");
      throw new Error("Tilt installer failed");
    }
    step.succeed("installed");
    return;
  }

  step.fail(`unsupported platform: ${platform}`);
  throw new Error(`Unsupported platform: ${platform}`);
}

function copyTiltExeToYmBin() {
  if (fs.existsSync(TILT_EXE)) return;   // already mirrored

  fs.mkdirSync(path.dirname(TILT_EXE), { recursive: true });

  const home = os.homedir();
  const candidates = [
    path.join(home, "bin", "tilt.exe"),
    path.join(home, ".local", "bin", "tilt.exe"),
  ];
  for (const cand of candidates) {
    if (fs.existsSync(cand)) {
      fs.copyFileSync(cand, TILT_EXE);
      return;
    }
  }
  warn("Could not locate tilt.exe to mirror into .ym/bin/");
}

// -------- Nginx --------------------------------------------------------------

export async function ensureNginx() {
  const platform = os.platform();
  const step = new StepLine("Nginx");

  if (platform === "win32") {
    if (fs.existsSync(path.join(NGINX_DIR, "nginx.exe"))) {
      step.start("checking");
      injectNginxAssets(platform);
      step.succeed("already installed");
      return;
    }

    const templateDir = path.join(os.homedir(), ".ym", "nginx-template");
    if (fs.existsSync(path.join(templateDir, "nginx.exe"))) {
      step.start("checking");
      fs.mkdirSync(YM_LOCAL, { recursive: true });
      fs.cpSync(templateDir, NGINX_DIR, { recursive: true });
      injectNginxAssets(platform);
      step.succeed("already installed");
      return;
    }

    step.start("downloading 1.27.4");
    const url = "https://nginx.org/download/nginx-1.27.4.zip";
    const archive = path.join(YM_LOCAL, "nginx.zip");

    await download(url, archive, (msg) => step.update(msg));

    step.update("extracting");
    const r = await runInherit("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -Path '${archive}' -DestinationPath '${YM_LOCAL}' -Force`,
    ], { stdio: "ignore" });
    if (r !== 0) {
      step.fail("extraction failed");
      throw new Error("nginx zip extraction failed");
    }

    const extracted = fs
      .readdirSync(YM_LOCAL)
      .find((f) => f.startsWith("nginx-"));
    if (!extracted) {
      step.fail("extraction artifact missing");
      throw new Error("nginx folder missing after extraction");
    }
    fs.renameSync(path.join(YM_LOCAL, extracted), NGINX_DIR);
    fs.unlinkSync(archive);

    injectNginxAssets(platform);
    step.succeed("installed (1.27.4)");
    return;
  }

  if (platform === "darwin") {
    const present = runSync("which", ["nginx"]).code === 0;
    if (present) {
      step.start("checking");
      injectNginxAssets(platform);
      step.succeed("already installed");
      return;
    }

    step.start("brew install nginx");
    const r = await runInherit("brew", ["install", "nginx"], { stdio: "ignore" });
    if (r !== 0) {
      step.fail("brew install failed");
      throw new Error("brew install nginx failed");
    }
    injectNginxAssets(platform);
    step.succeed("installed via brew");
    return;
  }

  if (platform === "linux") {
    const present = runSync("which", ["nginx"]).code === 0;
    if (present) {
      step.start("checking");
      injectNginxAssets(platform);
      step.succeed("already installed");
      return;
    }

    const apt = runSync("which", ["apt-get"]).code === 0;
    if (!apt) {
      step.fail("apt-get not found — install nginx manually");
      throw new Error(
        "nginx not installed and no apt-get detected — please install nginx manually",
      );
    }
    step.start("sudo apt install nginx");
    const r = await runInherit(
      "sudo",
      ["apt-get", "install", "-y", "nginx"],
      { stdio: "ignore" },
    );
    if (r !== 0) {
      step.fail("apt install failed");
      throw new Error("apt install nginx failed (try installing manually)");
    }
    injectNginxAssets(platform);
    step.succeed("installed");
    return;
  }
}

function injectNginxAssets(platform) {
  const confDir = path.join(NGINX_DIR, "conf");
  if (!fs.existsSync(confDir)) fs.mkdirSync(confDir, { recursive: true });
  for (const d of ["logs", "temp"]) {
    const p = path.join(NGINX_DIR, d);
    if (!fs.existsSync(p)) fs.mkdirSync(p);
  }

  fs.copyFileSync(
    path.join(YM_LOCAL, "nginx.conf"),
    path.join(confDir, "nginx.conf"),
  );

  if (platform === "win32") {
    fs.copyFileSync(
      path.join(TOOL_ROOT, "scripts", "start-nginx.ps1"),
      path.join(NGINX_DIR, "start-nginx.ps1"),
    );
  } else {
    const target = path.join(NGINX_DIR, "start-nginx.sh");
    fs.copyFileSync(path.join(TOOL_ROOT, "scripts", "start-nginx.sh"), target);
    fs.chmodSync(target, 0o755);
  }
}

// -------- Download helper ----------------------------------------------------
//
// onProgress(msg) — called with a short status string (e.g. "downloading 42%")
// so callers can route progress into their own StepLine / LiveTable row.

function download(url, dest, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const total = parseInt(res.headers["content-length"] || "0", 10);
        let downloaded = 0;
        res.on("data", (chunk) => {
          downloaded += chunk.length;
          if (total) {
            const pct = Math.floor((downloaded / total) * 100);
            onProgress(`downloading ${pct}%`);
          } else {
            onProgress(`downloading ${Math.floor(downloaded / 1024)}KB`);
          }
        });
        res.pipe(file);
        file.on("finish", () => {
          onProgress("download complete");
          resolve();
        });
      })
      .on("error", (e) => reject(e));
  });
}
