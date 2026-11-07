// Builds the bookshop example: five service repos published as local git
// origins under <dir>/.origins, plus a ready-to-run workspace in <dir>.
// Used by `ym init --example bookshop [dir]`; also runnable directly:
//   node examples/bookshop/create.mjs [dir]

import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const IDENTITY = ["-c", "user.name=yardmaster example", "-c", "user.email=bookshop@example.invalid"];

function git(dir, ...args) {
  execFileSync("git", ["-c", "core.autocrlf=false", ...IDENTITY, ...args], { cwd: dir, stdio: "pipe" });
}

function write(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body.replace(/^\n/, ""));
  }
}

function commit(dir, msg) {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
}

const gitignore = "node_modules/\n.env\n";

const pkg = (name, description) => JSON.stringify({
  name,
  version: "1.0.0",
  private: true,
  description,
  type: "module",
  scripts: { start: "node --env-file=.env index.js" },
  engines: { node: ">=20.6" },
}, null, 2) + "\n";

// Matches what `npm install` writes for a dependency-free package, so
// installs leave the working tree clean.
const lock = (name) => JSON.stringify({
  name,
  version: "1.0.0",
  lockfileVersion: 3,
  requires: true,
  packages: { "": { name, version: "1.0.0", engines: { node: ">=20.6" } } },
}, null, 2) + "\n";

const readme = (name, text) =>
  `# ${name}\n\n${text}\n\nPart of the [yardmaster](https://github.com/2vergent/yardmaster) bookshop example.\n`;

// Shared JSON-over-HTTP helper copied into each API (no dependencies).
const httpKit = `
import http from "http";

export const log = (msg) => console.log(\`[\${new Date().toISOString().slice(11, 19)}] \${msg}\`);

export function serve(name, routes) {
  const port = Number(process.env.PORT || process.env.APP_PORT);
  http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const handler = routes[url.pathname];
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (handler) return send(200, await handler(url));
      send(200, { service: name, env: process.env.APP_ENV, ok: true });
    } catch (err) {
      log(\`error: \${err.message}\`);
      send(502, { error: err.message });
    }
  }).listen(port, () => log(\`\${name} listening on :\${port} (env=\${process.env.APP_ENV})\`));
}

export async function getJson(base, pathname) {
  const res = await fetch(new URL(pathname, base));
  if (!res.ok) throw new Error(\`\${pathname} → \${res.status}\`);
  return res.json();
}
`;

const ordersIndex = (discount) => `
import fs from "fs";
import { serve, getJson, log } from "./lib/http.js";

const orders = JSON.parse(fs.readFileSync(new URL("./data/orders.json", import.meta.url), "utf8"));
${discount ? "const discountPct = Number(process.env.DISCOUNT_PCT || 0);\n" : ""}
// Joins orders with books (catalog-api) and customers (users-api).
async function listOrders() {
  const [books, users] = await Promise.all([
    getJson(process.env.SVC_CATALOG_URL, "/catalog/books"),
    getJson(process.env.SVC_USERS_URL, "/users"),
  ]);
  log(\`joined \${orders.length} orders with \${books.length} books and \${users.length} users\`);
  return orders.map((o) => {
    const book = books.find((b) => b.id === o.bookId);
    const user = users.find((u) => u.id === o.userId);
    const subtotal = book.price * o.qty;
${discount
  ? "    const total = +(subtotal * (1 - discountPct / 100)).toFixed(2);\n    return { id: o.id, customer: user.name, book: book.title, qty: o.qty, subtotal, discountPct, total };"
  : "    return { id: o.id, customer: user.name, book: book.title, qty: o.qty, total: subtotal };"}
  });
}

serve("orders-api", {
  "/orders": listOrders,
});
`;

const page = (discount) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bookshop</title>
  <style>
    :root { color-scheme: light dark; --accent: #2f6fde; }
    body { font: 15px/1.5 system-ui, sans-serif; max-width: 860px; margin: 32px auto; padding: 0 16px; }
    header { display: flex; align-items: baseline; gap: 12px; }
    .env { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--accent); color: white; }
    table { width: 100%; border-collapse: collapse; margin: 8px 0 28px; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #8884; }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
${discount ? "    .deal { color: #1a8f4a; font-weight: 600; }\n" : ""}  </style>
</head>
<body>
  <header><h1>📚 Bookshop</h1><span class="env" id="env"></span></header>
  <h2>Catalogue</h2>
  <table id="books"><tr><th>Title</th><th>Author</th><th class="num">Price</th></tr></table>
  <h2>Recent orders</h2>
  <table id="orders"><tr><th>Order</th><th>Customer</th><th>Book</th><th class="num">Qty</th>${discount ? '<th class="num">Discount</th>' : ""}<th class="num">Total</th></tr></table>
  <script>
    const money = (n) => "$" + n.toFixed(2);
    const row = (cells) => "<tr>" + cells.map(([v, cls]) => '<td class="' + (cls || "") + '">' + v + "</td>").join("") + "</tr>";
    fetch("/config.json").then((r) => r.json()).then((c) => (document.getElementById("env").textContent = c.env));
    fetch("/catalog/books").then((r) => r.json()).then((books) => {
      document.getElementById("books").insertAdjacentHTML("beforeend",
        books.map((b) => row([[b.title], [b.author], [money(b.price), "num"]])).join(""));
    });
    fetch("/orders").then((r) => r.json()).then((orders) => {
      document.getElementById("orders").insertAdjacentHTML("beforeend",
        orders.map((o) => row([[o.id], [o.customer], [o.book], [o.qty, "num"],${discount ? ' [o.discountPct + "%", "num deal"],' : ""} [money(o.total), "num"]])).join(""));
    });
  </script>
</body>
</html>
`;

// name → { files on main, extra branches: { branch: files | null } }
const SERVICES = {
  "catalog-api": {
    files: {
      ".gitignore": gitignore,
      "package.json": pkg("catalog-api", "Books and prices for the bookshop example"),
      "package-lock.json": lock("catalog-api"),
      "README.md": readme("catalog-api", "Serves the book catalogue at `/catalog/books`."),
      "lib/http.js": httpKit,
      "data/books.json": JSON.stringify([
        { id: "b1", title: "The Left Hand of Darkness", author: "Ursula K. Le Guin", price: 14.5 },
        { id: "b2", title: "Kindred", author: "Octavia E. Butler", price: 12.0 },
        { id: "b3", title: "The Dispossessed", author: "Ursula K. Le Guin", price: 13.25 },
        { id: "b4", title: "Parable of the Sower", author: "Octavia E. Butler", price: 11.75 },
        { id: "b5", title: "Hyperion", author: "Dan Simmons", price: 15.0 },
      ], null, 2) + "\n",
      "index.js": `
import fs from "fs";
import { serve, log } from "./lib/http.js";

const books = JSON.parse(fs.readFileSync(new URL("./data/books.json", import.meta.url), "utf8"));
log(\`loaded \${books.length} books\`);

serve("catalog-api", {
  "/catalog/books": () => books,
});
`,
    },
    branches: { staging: null },
  },

  "users-api": {
    files: {
      ".gitignore": gitignore,
      "package.json": pkg("users-api", "Customer accounts for the bookshop example"),
      "package-lock.json": lock("users-api"),
      "README.md": readme("users-api", "Serves customers at `/users`."),
      "lib/http.js": httpKit,
      "data/users.json": JSON.stringify([
        { id: "u1", name: "Asha Rao", city: "Bengaluru" },
        { id: "u2", name: "Diego Alvarez", city: "Madrid" },
        { id: "u3", name: "Mei Lin", city: "Taipei" },
      ], null, 2) + "\n",
      "index.js": `
import fs from "fs";
import { serve } from "./lib/http.js";

const users = JSON.parse(fs.readFileSync(new URL("./data/users.json", import.meta.url), "utf8"));

serve("users-api", {
  "/users": () => users,
});
`,
    },
    branches: { staging: null },
  },

  "orders-api": {
    files: {
      ".gitignore": gitignore,
      "package.json": pkg("orders-api", "Orders for the bookshop example; calls catalog-api and users-api"),
      "package-lock.json": lock("orders-api"),
      "README.md": readme("orders-api", "Serves `/orders`, joining data from `catalog-api` (`SVC_CATALOG_URL`) and `users-api` (`SVC_USERS_URL`)."),
      "lib/http.js": httpKit,
      "data/orders.json": JSON.stringify([
        { id: "o-1001", userId: "u1", bookId: "b2", qty: 1 },
        { id: "o-1002", userId: "u2", bookId: "b5", qty: 2 },
        { id: "o-1003", userId: "u3", bookId: "b1", qty: 1 },
        { id: "o-1004", userId: "u1", bookId: "b4", qty: 3 },
      ], null, 2) + "\n",
      "index.js": ordersIndex(false),
    },
    branches: {
      staging: null,
      "feature/discounts": { "index.js": ordersIndex(true) },
    },
  },

  "notifier-worker": {
    files: {
      ".gitignore": gitignore,
      "package.json": pkg("notifier-worker", "Background worker that 'emails' customers about their orders"),
      "package-lock.json": lock("notifier-worker"),
      "README.md": readme("notifier-worker", "Polls `orders-api` and logs a (pretend) confirmation email per new order. Opt-in: add it with `ym add notifier-worker`."),
      "lib/http.js": httpKit,
      "index.js": `
import { serve, getJson, log } from "./lib/http.js";

const seen = new Set();
const everyMs = Number(process.env.POLL_SECONDS || 10) * 1000;

async function poll() {
  try {
    for (const o of await getJson(process.env.SVC_ORDERS_URL, "/orders")) {
      if (seen.has(o.id)) continue;
      seen.add(o.id);
      log(\`📧 emailed \${o.customer}: order \${o.id} (\${o.book}) confirmed\`);
    }
  } catch (err) {
    log(\`orders-api not reachable yet: \${err.message}\`);
  }
}

serve("notifier-worker", {});
poll();
setInterval(poll, everyMs);
`,
    },
    branches: { staging: null },
  },

  "shop-web": {
    files: {
      ".gitignore": gitignore,
      "package.json": pkg("shop-web", "Storefront for the bookshop example"),
      "package-lock.json": lock("shop-web"),
      "README.md": readme("shop-web", "Static storefront. It calls the APIs through the yardmaster gateway (same origin), so it needs no API URLs of its own."),
      "public/index.html": page(false),
      "index.js": `
import http from "http";
import fs from "fs";

const port = Number(process.env.PORT || process.env.APP_PORT);
const html = () => fs.readFileSync(new URL("./public/index.html", import.meta.url));

http.createServer((req, res) => {
  if (req.url === "/config.json") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ env: process.env.APP_ENV }));
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html());
}).listen(port, () => console.log(\`shop-web on :\${port} (env=\${process.env.APP_ENV})\`));
`,
    },
    branches: {
      staging: null,
      "feature/discounts": { "public/index.html": page(true) },
    },
  },
};

const servicesYaml = (origin) => `# Bookshop example fleet for yardmaster — https://github.com/2vergent/yardmaster
#   ym setup   clone + install + generate .env files
#   ym up      run everything at http://localhost:8080
#
# The repos are local git origins in .origins/ (created by
# \`ym init --example bookshop\`); swap in GitHub URLs for a real fleet.

version: 1

defaults:
  serve_cmd: "npm start"

environments:
  dev:
    branch: main
    description: "day-to-day work on main"
  staging:
    branch: staging
    description: "what's deployed to staging"
default_environment: dev

stacks:
  storefront:
    label: "Storefront"
    description: "The shop UI and the three APIs behind it"
    services: [shop-web, catalog-api, orders-api, users-api]
  apis:
    label: "APIs only"
    description: "Backends without the UI"
    services: [catalog-api, orders-api, users-api]
default_stack: storefront

gateway_port: 8080
tilt_port: 10350

services:
  - name: shop-web
    kind: frontend
    repo: "${origin("shop-web")}"
    port: 5173
    display_name: web
    routes: [/]

  - name: catalog-api
    repo: "${origin("catalog-api")}"
    port: 4101
    env_prefix: CATALOG
    display_name: catalog
    routes: [/catalog]

  - name: users-api
    repo: "${origin("users-api")}"
    port: 4103
    env_prefix: USERS
    display_name: users
    routes: [/users]

  - name: orders-api
    repo: "${origin("orders-api")}"
    port: 4102
    env_prefix: ORDERS
    display_name: orders
    routes: [/orders]
    depends_on: [catalog-api, users-api]

  - name: notifier-worker
    repo: "${origin("notifier-worker")}"
    port: 4104
    display_name: notifier
    depends_on: [orders-api]
    opt_in: true
`;

const envExample = `# Template for every service's generated .env (see the yardmaster README).
# STAGING_<KEY> overrides <KEY> when the environment is staging.
# Real secrets go in .env.local (git-ignored), never here.

APP_ENV=dev
STAGING_APP_ENV=staging
APP_PORT=
LOG_LEVEL=debug
STAGING_LOG_LEVEL=info

DISCOUNT_PCT=0
STAGING_DISCOUNT_PCT=10
POLL_SECONDS=10

SVC_CATALOG_URL=
SVC_USERS_URL=
SVC_ORDERS_URL=
`;

const workspaceReadme = `# Bookshop example

A five-service bookshop for trying [yardmaster](https://github.com/2vergent/yardmaster).
The service repos live as local git origins in \`.origins/\`, so no GitHub access is needed.

\`\`\`bash
ym setup        # pick a stack; clones + installs + writes .env files
ym up           # http://localhost:8080
\`\`\`

| Service | Port | Route | Talks to |
|---|---|---|---|
| shop-web | 5173 | \`/\` | everything, via the gateway |
| catalog-api | 4101 | \`/catalog\` | — |
| users-api | 4103 | \`/users\` | — |
| orders-api | 4102 | \`/orders\` | catalog-api, users-api |
| notifier-worker | 4104 | — | orders-api (opt-in: \`ym add notifier-worker\`) |

Things to try:

\`\`\`bash
ym status                                              # health, branch, port per service
ym logs orders-api -f                                  # watch it join catalog + users
ym add notifier-worker                                 # bring in the opt-in worker
ym checkout orders-api=feature/discounts shop-web=feature/discounts
ym env staging                                         # DISCOUNT_PCT=10, APP_ENV=staging
ym stack save discounts --with-branches --with-env
ym switch main && ym stack apply discounts             # …and it all comes back
\`\`\`
`;

const workspaceGitignore =
  "# Service repos are cloned into this folder; track only the workspace config.\n" +
  "/*\n!/services.yaml\n!/.env.example\n!/.gitignore\n!/README.md\n";

// Creates the example in `dir` (must not already hold a services.yaml).
export function create(dir) {
  const root = path.resolve(dir);
  const originsDir = path.join(root, ".origins");
  fs.mkdirSync(originsDir, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ym-bookshop-"));

  try {
    for (const [name, spec] of Object.entries(SERVICES)) {
      const repoDir = path.join(work, name);
      fs.mkdirSync(repoDir);
      git(repoDir, "init", "-q", "-b", "main");
      write(repoDir, spec.files);
      commit(repoDir, "Initial commit");
      for (const [branchName, files] of Object.entries(spec.branches)) {
        git(repoDir, "checkout", "-q", "-b", branchName, "main");
        if (files) {
          write(repoDir, files);
          commit(repoDir, `Add ${branchName}`);
        }
      }
      git(repoDir, "checkout", "-q", "main");
      const bare = path.join(originsDir, `${name}.git`);
      fs.rmSync(bare, { recursive: true, force: true });
      git(work, "clone", "-q", "--bare", repoDir, bare);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  const origin = (name) => path.join(originsDir, `${name}.git`).replace(/\\/g, "/");
  write(root, {
    "services.yaml": servicesYaml(origin),
    ".env.example": envExample,
    ".gitignore": workspaceGitignore,
    "README.md": workspaceReadme,
  });
  return root;
}

const invokedAsScript =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedAsScript) {
  const out = create(process.argv[2] || "bookshop");
  console.log(`Bookshop example ready in ${out}\n  cd ${path.relative(process.cwd(), out) || "."}\n  ym setup`);
}
