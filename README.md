<div align="center">
  <h1>yardmaster</h1>
  <p><strong>Run your whole microservice fleet locally with one command.</strong></p>
  <br />
  <img src="demo/gifs/demo.gif" alt="yardmaster walkthrough demo" width="100%" />
</div>

`ym` turns a fleet of separate service repos into a one-command local dev environment. You describe the topology once in a `services.yaml`. yardmaster then clones every repo, installs dependencies, writes each service's `.env`, wires them together behind one nginx gateway, and runs everything under [Tilt](https://tilt.dev) with live restarts.

```bash
ym init my-fleet && cd my-fleet   # scaffold services.yaml
ym setup                          # clone + install + generate .env files
ym up                             # start everything (detached)
ym status                         # branch, health, port and dirty state per service
```

## Try it in two minutes

A five-service bookshop ships with yardmaster. Its repos are created as local git origins, so you need no GitHub access:

```bash
git clone https://github.com/2vergent/yardmaster.git
cd yardmaster && npm link
ym init --example bookshop && cd bookshop
ym setup && ym up                 # open http://localhost:8080
```

Then try `ym checkout orders-api=feature/discounts shop-web=feature/discounts` followed by `ym env staging`, and refresh the page.

## Why

A polyrepo of 10–50 services is painful to run locally. New joiners spend days on it, ports collide, `.env` files drift, and nobody remembers which branch each repo should be on. yardmaster keeps all of that in a single committed file. When a teammate adds a service, everyone else runs `ym update`.

## Install

Requires Node 20+ and git. Tilt and nginx are installed for you on first `ym setup`.

```bash
git clone https://github.com/2vergent/yardmaster.git
cd yardmaster && npm link
```

## The workspace

A workspace is a folder (usually its own small git repo) holding `services.yaml` and `.env.example`. Service repos are cloned next to them, and that is all you commit.

```yaml
environments:
  staging: { branch: staging }
  dev:     { branch: develop }
default_environment: dev

stacks:
  core:       { label: Core,       services: [web, catalog-api, orders-api] }
  everything: { label: Everything, services: ["*"] }
default_stack: core

services:
  - name: web
    kind: frontend
    repo: https://github.com/acme/web.git
    port: 5173
    serve_cmd: "npm run dev"
    routes: [/]

  - name: catalog-api
    repo: https://github.com/acme/catalog-api.git
    port: 4101
    env_prefix: CATALOG          # others reach it via SVC_CATALOG_URL
    routes: [/catalog]

  - name: orders-api
    repo: https://github.com/acme/orders-api.git
    port: 4102
    env_prefix: ORDERS
    routes: [/orders]
    depends_on: [catalog-api]
```

Every field is documented in the [starter services.yaml](templates/workspace/services.yaml).

### Generated `.env` files

`.env.example` is the template for every service's `.env`:

```dotenv
APP_PORT=                         # → the service's own port
SVC_CATALOG_URL=                  # → http://localhost:4101
DB_URL=postgres://localhost/app
STAGING_DB_URL=postgres://staging-db/app   # wins when the environment is `staging`
```

- `<ENV>_KEY` overrides `KEY` for that environment, and `extends:` chains environments.
- Secrets go in a git-ignored `.env.local`, which overrides everything, so nothing sensitive is ever committed.
- `ym env <name>` regenerates the files.
- `ym switch <branch>` regenerates them automatically when the branch belongs to an environment.

## Daily workflow

```bash
ym up                        # start the active stack
ym logs orders-api -f        # tail one service
ym restart orders-api        # re-trigger after weird state
ym shell orders-api          # subshell with that service's .env loaded
ym open web                  # open in the browser
ym doctor                    # diagnostics with copy-pasteable fixes (--fix applies safe ones)
ym down                      # stop everything
```

### Stacks: named working sets

```bash
ym stack apply everything                          # switch the active selection
ym add payments-api                                # clone + add one more service
ym checkout orders-api=feat/discounts web=feat/discounts
ym stack save discounts --with-branches --with-env # bookmark the exact state
ym stack apply core                                # …go do something else…
ym stack apply discounts                           # everything restored
```

### Branches across every repo

```bash
ym switch staging            # every repo → staging (dirty repos skipped; --stash to park them)
ym sync develop              # refresh develop in the background, stay on your branch
```

### VS Code

`ym code` opens a generated multi-root workspace containing every cloned repo, so Source Control shows changes across all of them. Use `ym workspace add <path>` to fold in other repos.

## How it works

- **Tilt** runs each service as a `local_resource`. The Tiltfile ships with yardmaster and reads your `services.yaml`.
- **nginx** is generated from `routes:` and serves the whole fleet on one origin (`gateway_port`, default 8080).
- **State** that's local to your machine (active stack, saved stacks, binaries, logs) lives in `.ym/` inside the workspace.
- **Coexistence:** yardmaster only ever stops a Tilt or nginx it started itself. Set `tilt_port:` / `gateway_port:` to run next to another project's stack.

## Platforms

| Platform | Status |
|---|---|
| Windows 10/11 (PowerShell, Git Bash) | ✓ primary |
| macOS (zsh/bash) | ✓ |
| Linux (bash/zsh) | ✓ |

Tab completion: `ym completion install` (bash, zsh, PowerShell).

## License

[MIT](LICENSE)
