#!/usr/bin/env node
// =============================================================================
// env-compiler.js — generate per-service .env files from a template plus
// services.yaml.
//
// Template: <workspace>/.env.example, or a service's own `env_template`.
// Lines are `KEY=value` or `KEY: "value"`; comments and blanks pass through.
//
// Per environment, `<PREFIX>_KEY` lines override `KEY`, where PREFIX is the
// environment's `prefix:` (default: its name upper-cased). `extends:` chains
// apply parent overrides first. An untracked <workspace>/.env.local overrides
// anything, so secrets never need to be committed.
//
// Special keys:
//   APP_PORT        → the service's own port
//   SVC_<X>_URL     → http://localhost:<port> of the service with env_prefix X
//
// Output format follows the service's `env_format`: dotenv | yaml-colon.
//
// CLI: `node lib/env-compiler.js [env]` prints per-service results.
// =============================================================================

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { YM_ROOT } from "./bootstrap.js";
import { loadServices, isCompanion, defaultEnv } from "./services.js";
import { activeServiceNames } from "./presets.js";
import { ok, fail, info } from "./term.js";

const ROOT_TEMPLATE = ".env.example";
const LOCAL_OVERRIDES = path.join(YM_ROOT, ".env.local");

function parseLine(line) {
  const colon = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*"(.*)"\s*$/);
  if (colon) return { key: colon[1], value: colon[2] };
  const eq = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (eq) return { key: eq[1], value: eq[2].replace(/^"(.*)"$/, "$1") };
  return null;
}

function readPairs(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const p = parseLine(line);
    if (p) out[p.key] = p.value;
  }
  return out;
}

function envPrefix(name, spec) {
  return (spec?.prefix ?? name.toUpperCase().replace(/[^A-Z0-9]/g, "_")) + "_";
}

// Root-first chain of environment names: [grandparent, parent, env].
function envChain(env, environments) {
  const chain = [];
  const seen = new Set();
  for (let e = env; e && !seen.has(e); e = environments[e]?.extends) {
    seen.add(e);
    chain.unshift(e);
  }
  return chain;
}

function buildContext(env) {
  const { services, environments } = loadServices();
  if (!environments[env]) {
    throw new Error(`unknown environment '${env}' — declared: ${Object.keys(environments).join(", ")}`);
  }
  const prefixes = Object.entries(environments).map(([n, s]) => envPrefix(n, s));
  const chainPrefixes = envChain(env, environments).map((n) => envPrefix(n, environments[n]));
  const svcPorts = {};
  for (const svc of services) {
    if (svc.env_prefix && svc.port) svcPorts[svc.env_prefix] = svc.port;
  }
  return { env, prefixes, chainPrefixes, svcPorts, localOverrides: readPairs(LOCAL_OVERRIDES) };
}

function resolveValue(key, pairs, ctx) {
  let value = pairs[key];
  for (const prefix of ctx.chainPrefixes) {
    if (pairs[prefix + key] !== undefined) value = pairs[prefix + key];
  }
  for (const prefix of ctx.chainPrefixes) {
    if (ctx.localOverrides[prefix + key] !== undefined) value = ctx.localOverrides[prefix + key];
  }
  if (ctx.localOverrides[key] !== undefined) value = ctx.localOverrides[key];
  return value;
}

function templatePath(svc) {
  return path.join(YM_ROOT, svc.env_template || ROOT_TEMPLATE);
}

function buildEnv(svc, ctx) {
  const file = templatePath(svc);
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const pairs = readPairs(file);
  const fmt = (k, v) => (svc.env_format === "yaml-colon" ? `${k}: "${v}"` : `${k}=${v}`);

  return lines
    .map((line) => {
      const parsed = parseLine(line);
      if (!parsed) return line;
      const { key } = parsed;
      if (ctx.prefixes.some((p) => key.startsWith(p))) return null;
      if (key === "APP_PORT" && svc.port) return fmt(key, svc.port);
      const svcMatch = key.match(/^SVC_(.+)_URL$/);
      if (svcMatch && ctx.svcPorts[svcMatch[1]]) {
        return fmt(key, `http://localhost:${ctx.svcPorts[svcMatch[1]]}`);
      }
      return fmt(key, resolveValue(key, pairs, ctx) ?? "");
    })
    .filter((l) => l !== null)
    .join("\n");
}

/**
 * Generate per-service .env files for the given environment.
 * Silent — returns [{ name, kind, port, status, reason }]; never writes stdout.
 */
export function generateEnvFiles(env = defaultEnv(), opts = {}) {
  const onlyIfMissing = opts.onlyIfMissing === true;
  const ctx = buildContext(env);

  // Active services plus anything cloned on disk; companions share their
  // source service's .env, so they never get a file of their own.
  const activeNames = new Set(activeServiceNames());
  const targetSvcs = loadServices().services.filter(
    (s) => !isCompanion(s) && (activeNames.has(s.name) || fs.existsSync(path.join(YM_ROOT, s.name))),
  );

  const results = [];
  for (const svc of targetSvcs) {
    const repoDir = path.join(YM_ROOT, svc.name);
    if (!fs.existsSync(repoDir)) {
      results.push({ name: svc.name, kind: svc.kind, status: "skipped", reason: "directory not cloned" });
      continue;
    }

    const envPath = path.join(repoDir, ".env");
    const envExists = fs.existsSync(envPath);

    // ensure-exists mode never touches an existing .env (keeps hand-edits).
    if (onlyIfMissing && envExists) {
      results.push({ name: svc.name, kind: svc.kind, port: svc.port, status: "present" });
      continue;
    }

    const content = buildEnv(svc, ctx);
    if (content === null) {
      results.push({ name: svc.name, kind: svc.kind, status: "skipped", reason: "no env template" });
      continue;
    }

    // Skip identical writes so Tilt doesn't see a touched file and rebuild.
    let unchanged = false;
    if (envExists) {
      try { unchanged = fs.readFileSync(envPath, "utf8") === content; } catch { /* rewrite */ }
    }
    if (!unchanged) fs.writeFileSync(envPath, content, "utf8");

    results.push({
      name: svc.name,
      kind: svc.kind,
      port: svc.port,
      status: onlyIfMissing ? "created" : unchanged ? "unchanged" : "written",
    });
  }
  return results;
}

// Create missing .env files only; used by add/switch/checkout so hand-edits survive.
export function ensureEnvFiles(env = defaultEnv()) {
  return generateEnvFiles(env, { onlyIfMissing: true });
}

// Keys the compiler would emit but a cloned service's .env lacks: [{ name, missing }].
export function envKeyDrift(env = defaultEnv()) {
  const ctx = buildContext(env);
  const out = [];
  for (const svc of loadServices().services) {
    if (isCompanion(svc)) continue;
    const envPath = path.join(YM_ROOT, svc.name, ".env");
    if (!fs.existsSync(envPath)) continue;
    const expectedContent = buildEnv(svc, ctx);
    if (expectedContent === null) continue;
    const expected = keysOf(expectedContent);
    let actual;
    try { actual = keysOf(fs.readFileSync(envPath, "utf8")); } catch { continue; }
    const missing = [...expected].filter((k) => !actual.has(k));
    if (missing.length) out.push({ name: svc.name, missing });
  }
  return out;
}

function keysOf(content) {
  const keys = new Set();
  for (const line of content.split(/\r?\n/)) {
    const p = parseLine(line);
    if (p) keys.add(p.key);
  }
  return keys;
}

const invokedAsScript =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedAsScript) {
  const env = process.argv[2] || defaultEnv();
  let results;
  try {
    results = generateEnvFiles(env);
  } catch (e) {
    fail(e.message);
    process.exit(1);
  }
  let wrote = 0;
  let skipped = 0;
  for (const r of results) {
    if (r.status === "skipped") {
      info(`${r.name}: ${r.reason}, skipping`);
      skipped++;
    } else {
      ok(`${r.name} → ${r.port ? `APP_PORT=${r.port}` : "written"} (${env})`);
      wrote++;
    }
  }
  ok(`.env generation complete: ${wrote} written, ${skipped} skipped (${env})`);
}
