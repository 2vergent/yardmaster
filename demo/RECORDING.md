# Recording the demo

Two outputs: README GIFs rendered from the `.tape` scripts, and a short narrated screen capture for social posts.

## Before you start

- `ym` on PATH: `cd yardmaster && npm link`
- Ports **8080** and **10350** free. Stop any other Tilt or nginx stack first.
- A clean terminal: large font, dark theme, prompt trimmed to `PS>` or `$`.
- Do one full run first (`ym setup` downloads Tilt/nginx on first use), then `ym down` and delete `%TEMP%\bookshop` so the take starts from nothing.

## README GIFs (VHS)

```powershell
winget install charmbracelet.vhs    # also needs ttyd and ffmpeg on PATH
vhs demo/demo.tape                  # → demo/gifs/demo.gif + demo/videos/demo.mp4
vhs demo/quickstart.tape            # → demo/gifs/quickstart.gif + demo/videos/quickstart.mp4
vhs demo/branches.tape              # → demo/gifs/branches.gif + demo/videos/branches.mp4
```

The `Sleep` values are padded for a cold machine. Trim them once a take looks right.

## Social video (OBS, 60–90 s)

Use a 1920×1080 canvas, with the terminal on the left two-thirds and the browser on the right. Record at 30 fps with no music, and add captions instead of voice-over if you prefer.

| # | ~sec | Show | Say / caption |
|---|---|---|---|
| 1 | 0–6 | `ym init --example bookshop`, then `services.yaml` from `stacks:` down in an editor | "Five repos. One file describes all of them." |
| 2 | 6–20 | `cd bookshop` → `ym setup` → pick **Storefront** | "One command clones, installs and writes every `.env`." |
| 3 | 20–30 | `ym up`, then the Tilt dashboard turning green | "Everything starts under Tilt, with live restarts." |
| 4 | 30–38 | Browser at `localhost:8080`: catalogue + orders, `dev` badge | "One gateway, one origin. The APIs call each other through generated URLs." |
| 5 | 38–48 | `ym add notifier-worker` → `ym logs notifier-worker -f` showing 📧 lines | "Need the worker too? Add it live." |
| 6 | 48–62 | `ym checkout orders-api=feature/discounts shop-web=feature/discounts` → `ym env staging` → browser refresh shows the **Discount** column and `staging` badge | "Feature branches across repos, plus a different environment, in two commands." |
| 7 | 62–75 | `ym stack save discounts --with-branches --with-env` → `ym switch main` → `ym stack apply discounts` | "Bookmark the whole fleet's state and come back to it later." |
| 8 | 75–85 | `ym doctor` (all green) → `ym down` | "Diagnostics built in. `ym down` and it's all gone." |
| 9 | 85–90 | Repo URL card: `github.com/2vergent/yardmaster` | "Open source, MIT. Bring your own services.yaml." |

Tips:

- Pre-type long commands in a scratch file and paste them, so the typing stays fast and typo-free.
- After `ym env staging`, wait a few seconds before refreshing: Tilt sees the changed `.env` files and restarts the services by itself.
- The example's `repo:` lines are local `.origins/` paths. Keep them off screen; the story is the commands, not the URLs.
- Keep the Tilt dashboard on the left sidebar view, which reads better at 1080p than the table view.
