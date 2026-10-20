// Load + validate services.yaml. Single source of truth for the service
// inventory (name, repo, port, env_prefix, routes, watch) and environments. No behavior bits
// — what's "active" is decided by presets/stacks, not by a per-service flag.

import fs from "fs";
import path from "path";
import YAML from "yaml";
import { YM_ROOT } from "./bootstrap.js";

const SERVICES_YAML = path.join(YM_ROOT, "services.yaml");

let _cache = null;

export function loadServices() {
  if (_cache) return _cache;

  if (!fs.existsSync(SERVICES_YAML)) {
    throw new Error(`services.yaml not found in ${YM_ROOT} or any parent — run \`ym init\` first`);
  }

  const raw = fs.readFileSync(SERVICES_YAML, "utf8");
  const data = YAML.parse(raw);

  const defaults = data.defaults || {};
  const services = (data.services || []).map((s) => ({
    kind: defaults.kind ?? "backend",
    serve_cmd: defaults.serve_cmd ?? "node .",
    log_level: defaults.log_level ?? "debug",
    health_path: defaults.health_path ?? "/",
    env_format: defaults.env_format ?? "dotenv",
    watch: undefined,
    routes: [],
    depends_on: [],
    ...s,
  }));

  const stacks = data.stacks || {};
  const defaultStack = data.default_stack || null;
  // Without an `environments:` block, everything tracks a single `main` branch.
  const environments = data.environments || { main: {} };
  const defaultEnvironment = data.default_environment || Object.keys(environments)[0];

  validate(services, stacks, defaultStack, environments, defaultEnvironment);

  _cache = {
    version: data.version,
    defaults,
    services,
    stacks,
    defaultStack,
    environments,
    defaultEnvironment,
    tiltPort: data.tilt_port,
    gatewayPort: data.gateway_port,
  };
  return _cache;
}

export function refresh() {
  _cache = null;
  return loadServices();
}

function validate(services, stacks, defaultStack, environments, defaultEnvironment) {
  const names = new Set();
  const ports = new Map();
  const errors = [];

  for (const s of services) {
    if (!s.name) errors.push(`service missing 'name'`);
    if (names.has(s.name)) errors.push(`duplicate service name: ${s.name}`);
    names.add(s.name);

    // Companion entries (worker/merger that share another service's repo) declare
    // 'source:' and don't bind a port or own an env_prefix.
    const isCompanion = !!s.source;

    if (!s.port && !isCompanion) errors.push(`${s.name}: missing 'port'`);
    if (s.port) {
      if (ports.has(s.port)) {
        errors.push(
          `port collision on ${s.port}: ${ports.get(s.port)} vs ${s.name}`,
        );
      } else {
        ports.set(s.port, s.name);
      }
    }

  }

  // Stacks — each member must be a known service name OR the literal "*".
  for (const [stackName, stack] of Object.entries(stacks || {})) {
    if (!stack || typeof stack !== "object") {
      errors.push(`stack ${stackName}: must be an object`);
      continue;
    }
    if (!Array.isArray(stack.services)) {
      errors.push(`stack ${stackName}: 'services' must be a list`);
      continue;
    }
    for (const ref of stack.services) {
      if (ref === "*") continue;
      if (!names.has(ref)) {
        errors.push(`stack ${stackName}: unknown service '${ref}'`);
      }
    }
  }

  if (defaultStack && !stacks[defaultStack]) {
    errors.push(`default_stack '${defaultStack}' is not defined under stacks`);
  }

  for (const [envName, spec] of Object.entries(environments)) {
    const parent = spec?.extends;
    if (parent && !environments[parent]) {
      errors.push(`environment ${envName}: extends unknown environment '${parent}'`);
    }
  }
  if (!environments[defaultEnvironment]) {
    errors.push(`default_environment '${defaultEnvironment}' is not defined under environments`);
  }

  if (errors.length) {
    throw new Error("services.yaml is invalid:\n  " + errors.join("\n  "));
  }
}

export function byName(name) {
  const { services } = loadServices();
  return services.find((s) => s.name === name);
}

// A "companion" shares another service's repo via `source:` and runs as a
// sidecar (e.g. a queue worker next to its API). It has no own clone, no
// port, and no env_prefix. `repoDirOf` resolves which on-disk folder a
// service's code lives in — its own name, or its source's.
export function isCompanion(svc) {
  return !!(svc && svc.source);
}

export function repoDirOf(svc) {
  return (svc && svc.source) || svc.name;
}

// Filter a list of services by kind. No "enabled" filtering here — the
// concept of an enabled-by-default service is gone; activity is decided
// by the active selection (presets/stacks).
export function backends(services) {
  return services.filter((s) => s.kind !== "frontend");
}

export function frontends(services) {
  return services.filter((s) => s.kind === "frontend");
}

// Port the generated nginx gateway listens on: `gateway_port`, default 8080.
export function gatewayPort() {
  return Number(loadServices().gatewayPort) || 8080;
}

// Environment names declared in services.yaml, in file order.
export function envNames() {
  return Object.keys(loadServices().environments);
}

export function defaultEnv() {
  return loadServices().defaultEnvironment;
}

// Git branch an environment tracks: its `branch:` field, else its own name.
export function envBranch(env) {
  const spec = loadServices().environments[env] || {};
  return spec.branch || env;
}

// Environment whose branch is `branch`, or null when none tracks it.
export function envForBranch(branch) {
  return envNames().find((e) => envBranch(e) === branch) || null;
}

// Short display name used for Tilt resources: `display_name`, else the name.
export function displayName(svc) {
  return svc.display_name || svc.name;
}
