# Debugging And QA

- `pnpm dev` prints the active frontend URL, server API URL, host daemon port, data dir, and logs dir. Do not assume fixed dev ports.
- The packaged app defaults to server/frontend `:38886`, host daemon `:38887`, data dir `~/.bb/`, and logs under `~/.bb/logs/`.
- Entity IDs in URLs (`proj_*`, `thr_*`) are primary keys. Query them directly against the active data dir: `sqlite3 <data>/bb.db "SELECT * FROM threads WHERE id = 'thr_xxx';"`.
- API routes are under `/api/v1/`, for example `GET /api/v1/threads/:id`.
- Use `curl` against the server API to isolate frontend issues from server behavior.
- Use the CLI to inspect state: `pnpm bb thread show <id>`, `pnpm bb project list`, `pnpm bb status`. From source, use `pnpm bb:dev`.

## Local Dev QA Launcher

Use `scripts/bb-dev-app` when validating changes in the desktop dev app or helping QA from this checkout:

- `pnpm dev:status` runs `scripts/bb-dev-app status` to print the active branch, dev URLs, data dir, and logs.
- `scripts/bb-dev-app current` restarts the dev server on the current branch.
- `scripts/bb-dev-app main` fetches `origin/main`, fast-forwards `main`, and launches the dev server from this checkout.
- `scripts/bb-dev-app branch <branch>` switches to a local branch, or creates it from `origin/<branch>`, then launches the dev server.
- `scripts/bb-dev-app stop` stops the launcher-managed dev server and desktop.
- `scripts/bb-dev-app logs dev` and `scripts/bb-dev-app logs desktop` follow logs.

By default the launcher starts only the dev server (web frontend, server, host daemon) and prints the URL without opening a browser. Pass `--open` to open the browser after startup. Pass `--desktop` (e.g. `scripts/bb-dev-app current --desktop`) to also launch the Electron desktop shell — only do this when the user is testing a desktop-only change.

Branch switches intentionally keep dirty work in this checkout; git will stop if a local file would be overwritten. Set `BB_DEV_APP_STASH_DIRTY=1` for a one-off launch that stashes first.

For CLI QA against the dev instance, run `eval "$(scripts/bb-dev-app env)"` first. This sets `BB_SERVER_URL`, `BB_HOST_DAEMON_PORT`, and `BB_PROJECT_ID=proj_personal` so `pnpm bb:dev ...` does not accidentally target the packaged app.

Test agents with:

```bash
eval "$(scripts/bb-dev-app env)"
pnpm bb:dev thread spawn --project proj_personal --provider codex --permission-mode accept-edits --title "Smoke test" --prompt "Reply only with ok." --json
```

## Local bb Cloud

Run the Cloud account service and tunnel/AI gate locally with one command:

```bash
pnpm cloud:dev
```

Before the first run, copy `apps/connect/.dev.vars.example` to the ignored
`apps/connect/.dev.vars`, add an OpenAI API key, and generate the local auth
secret with `openssl rand -hex 32`. The launcher applies the Connect migrations
to an ignored, checkout-local D1 under `.wrangler/cloud-dev`, starts `apps/web`
and `apps/connect` on deterministic, worktree-specific ports against that same
database, creates only a local authenticated user identity, and configures the
current checkout's dev server to use the local account worker. Open the
dashboard URL printed by the launcher, choose a handle, create the first bb,
and generate its pairing code through the same UI as production. A handle such
as `michael` gets the real worktree-local gate URL printed by the UI,
`http://michael.localhost:<connect-port>`; local development never displays or
dials a `getbb.app` address. It skips GitHub authentication but does not seed a
handle, server, or pairing code. It never reads or writes remote Cloudflare
resources.

Keep ordinary `pnpm dev` running in another terminal. The launcher applies
`BB_CONNECT_BASE_URL` and `BB_CONNECT_LOOPBACK_URL` through the dev server's
managed environment reload, so the settings flow needs no URL field and no
server restart. The latter targets the current worktree's Vite app port, which
means the bare local handle serves the same UI as `pnpm dev`. The launcher
restores both previous values when stopped. After generating a code in the
Cloud dashboard, open the printed Settings → Cloud URL and paste it. Use the
printed commands to enable the `cloudAi` experiment and AI preference before
testing thread-title inference, commit-message inference, or voice
transcription. Press Ctrl-C in the Cloud terminal to stop both Workers.

The dashboard's terminal disclosure is also self-contained: its `bb connect`
command includes both the per-label local gate (`--server`) and the separate
account/redeem worker (`--base-url`). It does not depend on production's
single-origin deployment topology.

The printed setup unsets `BB_CLI` after selecting the dev server. Agent shells
can inherit that variable from another running bb installation; leaving it set
would make `pnpm bb:dev` re-exec that installation's CLI instead of the CLI in
this checkout.

The defaults use the same checkout hash as `pnpm dev`, in separate port ranges,
so multiple worktrees can run concurrently without manual configuration. Flags
remain available for a one-off override:

```bash
pnpm cloud:dev -- --connect-port 8891 --web-port 8892
```

To exercise the real GitHub OAuth flow instead of seeded authentication, create
a separate local GitHub OAuth App. Configure its homepage as
`http://127.0.0.1` and its authorization callback as
`http://127.0.0.1/api/auth/callback/github`. GitHub permits the redirect URI for
a loopback callback to select the actual listening port, so the same local OAuth
App works across worktrees. Copy `apps/web/.dev.vars.example` to the ignored
`apps/web/.dev.vars`, add that app's client id and secret, then run:

```bash
pnpm cloud:dev -- --github-auth
```

The launcher does not enable seeded authentication or mint a seeded pairing
code in this mode. Continue with GitHub in `apps/web`, then claim a handle and
create/pair a bb from the dashboard. The local Better Auth cookie is host-only
and uses its HTTP name; deployed staging and production retain the shared,
secure domain cookie.
