// `ym init [dir] [--example <name>]` — scaffold a workspace: services.yaml,
// .env.example, .gitignore; or a runnable example fleet.

import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { TOOL_ROOT } from "./bootstrap.js";
import { ok, info, fail, nextStep } from "./term.js";

const TEMPLATES = path.join(TOOL_ROOT, "templates", "workspace");
const EXAMPLES = path.join(TOOL_ROOT, "examples");

// Template file → name it is written as (npm strips dotfiles named .gitignore).
const FILES = {
  "services.yaml": "services.yaml",
  "env.example": ".env.example",
  "gitignore": ".gitignore",
};

export function version() {
  return JSON.parse(fs.readFileSync(path.join(TOOL_ROOT, "package.json"), "utf8")).version;
}

export async function initWorkspace(args = []) {
  const force = args.includes("--force");
  const exIdx = args.indexOf("--example");
  const example = exIdx >= 0 ? args[exIdx + 1] : null;
  const positional = args.filter((a, i) => !a.startsWith("-") && !(exIdx >= 0 && i === exIdx + 1));
  const dir = path.resolve(positional[0] || (example ? example : "."));

  if (fs.existsSync(path.join(dir, "services.yaml")) && !force) {
    fail(`${path.join(dir, "services.yaml")} already exists (pass --force to overwrite).`);
    process.exit(1);
  }

  if (exIdx >= 0) return initExample(example, dir);

  fs.mkdirSync(dir, { recursive: true });
  for (const [src, dest] of Object.entries(FILES)) {
    const target = path.join(dir, dest);
    if (fs.existsSync(target) && !force && dest !== "services.yaml") {
      info(`kept existing ${dest}`);
      continue;
    }
    fs.copyFileSync(path.join(TEMPLATES, src), target);
    ok(`wrote ${dest}`);
  }

  process.stdout.write("\n");
  const rel = path.relative(process.cwd(), dir);
  if (rel) nextStep(`cd ${rel}`);
  nextStep("edit services.yaml   declare your repos, ports and stacks");
  nextStep("ym setup             clone, install and generate .env files");
}

async function initExample(name, dir) {
  const available = fs.existsSync(EXAMPLES) ? fs.readdirSync(EXAMPLES) : [];
  if (!name || !available.includes(name)) {
    fail(`Unknown example '${name ?? ""}'. Available: ${available.join(", ")}`);
    process.exit(1);
  }
  const mod = await import(pathToFileURL(path.join(EXAMPLES, name, "create.mjs")).href);
  mod.create(dir);
  ok(`created the ${name} example — service repos are local git origins in .origins/`);

  process.stdout.write("\n");
  const rel = path.relative(process.cwd(), dir);
  if (rel) nextStep(`cd ${rel}`);
  nextStep("ym setup   clone, install and generate .env files");
  nextStep("ym up      run it at http://localhost:8080");
}
