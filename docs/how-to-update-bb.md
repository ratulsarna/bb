# How to update BB

This is the runbook for Ratul's custom BB deployment. It is fork-only and is
not intended for an upstream pull request.

## Current layout

- Fork: `https://github.com/ratulsarna/bb.git`
- Upstream: `https://github.com/get-bb/bb.git`
- Deployment branch: `codex/deployment`
- Build and server: VPS `srv1191956`
- Server URL: `https://srv1191956.tail7af381.ts.net`
- Mac and RDLEGION: clients and execution machines

The VPS is the source of truth. Build and deploy there. Do not build BB on the
Mac just to update this setup.

## Update order

Always update in this order:

1. Sync the fork and deployment branch with upstream.
2. Build, test, back up, and deploy the VPS package.
3. Let machine daemons update from the VPS.
4. Update the upstream Mac desktop app.

The desktop app and the host daemon are separate. Updating `/Applications/bb.app`
does not replace the custom VPS server. Keeping the VPS first avoids running a
newer desktop shell against an older server.

## 1. Sync the branches

Run on the VPS:

```bash
ssh vps
cd ~/Developer/Projects/bb
git fetch origin
git fetch upstream

git switch main
git merge --ff-only upstream/main
git push origin main

git switch codex/deployment
git merge main
```

Resolve any conflict on `codex/deployment`, then:

```bash
git status
git push origin codex/deployment
```

When upstream has implemented one of our fixes, remove the duplicate fork fix
during this merge. Do not keep both implementations.

## 2. Build and test an isolated package

Keep the deployment checkout clean. Build from a temporary detached worktree:

```bash
cd ~/Developer/Projects/bb
corepack enable pnpm
umask 0022

DEPLOY_SHA="$(git rev-parse codex/deployment)"
SHORT_SHA="$(git rev-parse --short=12 codex/deployment)"
STAMP="$(date -u +%Y%m%d%H%M%S)"
BUILD_DIR="$(mktemp -d ~/Developer/Projects/bb-builds/${SHORT_SHA}-${STAMP}.XXXXXX)"
ARTIFACT_DIR="$HOME/bb-artifacts/${SHORT_SHA}-${STAMP}"
mkdir -p "$ARTIFACT_DIR"

git worktree add --detach "$BUILD_DIR" "$DEPLOY_SHA"
cd "$BUILD_DIR"
pnpm install --frozen-lockfile --prefer-offline

BASE_VERSION="$(node -p "require('./packages/bb-app/package.json').version")"
CUSTOM_VERSION="$(node -e '
  const [version, stamp, sha] = process.argv.slice(1);
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  if (match === null) throw new Error(`Invalid version: ${version}`);
  console.log(`${match[1]}.${match[2]}.${Number(match[3]) + 1}-deploy.${stamp}.${sha}`);
' "$BASE_VERSION" "$STAMP" "$SHORT_SHA")"

node scripts/bump-version.mjs "$CUSTOM_VERSION"
node .github/workflows/check-version-lockstep.mjs

# --concurrency=2 is deliberate. At the default, the app, server, and
# host-daemon suites run at once and starve the VPS, and tests that pass in
# isolation fail on their own timeouts.
pnpm exec turbo run typecheck \
  --filter=@bb/app \
  --filter=@bb/config \
  --filter=@bb/server \
  --filter=@bb/host-daemon \
  --filter=bb-app \
  --concurrency=2 \
  --output-logs=new-only

# Tests run separately so --testTimeout only reaches vitest, never tsc.
# Vitest's default 5s per-test timeout is budgeted for fast machines; even at
# --concurrency=2 this VPS starves one heavy test past 5s most builds, while
# the same test passes in isolation. 30s absorbs the load spikes and still
# fails real hangs. If a test fails here for any reason other than a timeout,
# treat it as real.
pnpm exec turbo run test \
  --filter=@bb/app \
  --filter=@bb/config \
  --filter=@bb/server \
  --filter=@bb/host-daemon \
  --filter=bb-app \
  --concurrency=2 \
  --output-logs=new-only \
  -- --testTimeout=30000

pnpm exec turbo run smoke:tarball --filter=bb-app --force --output-logs=new-only
npm pack ./packages/bb-app --pack-destination "$ARTIFACT_DIR" --json \
  > "$ARTIFACT_DIR/pack.json"
sha256sum "$ARTIFACT_DIR"/bb-app-*.tgz | tee "$ARTIFACT_DIR/sha256.txt"
printf 'commit=%s\nversion=%s\n' "$DEPLOY_SHA" "$CUSTOM_VERSION" \
  > "$ARTIFACT_DIR/build-metadata.txt"
```

The version change exists only in the temporary build worktree. Do not commit
generated deployment versions to `codex/deployment`.

## 3. Back up and deploy the VPS

Run this from a plain SSH shell, never from a BB thread. `bb.service` is one
unit holding the server, the host daemon, and every thread executing on this
VPS, so stopping it kills the thread issuing the command mid-turn. Thread
history survives in `~/.bb`; the in-flight turn does not.

First confirm there are no running BB turns, open terminals, or pending
interactions. Then choose the exact tarball produced above:

```bash
TARBALL="$HOME/bb-artifacts/<build>/bb-app-<version>.tgz"
ROLLBACK_ROOT="$HOME/bb-deploy-backups/$(date -u +%Y%m%d%H%M%S)-before-update"
mkdir -p "$ROLLBACK_ROOT/rollback"

# Take the install location from the unit that actually runs BB. `npm root -g`
# follows the ambient npm prefix, which resolves elsewhere inside a BB
# workspace shell; installing under the wrong prefix leaves the service running
# the old build and reports success.
BB_BIN="$(systemctl --user show bb.service -p ExecStart --value \
  | sed -n 's/.*path=\([^ ;]*\).*/\1/p')"
BB_PREFIX="$(dirname "$(dirname "$BB_BIN")")"
GLOBAL_MODULES="$BB_PREFIX/lib/node_modules"
NPM="$BB_PREFIX/bin/npm"
ls -d "$GLOBAL_MODULES/bb-app"

"$NPM" pack "$GLOBAL_MODULES/bb-app" \
  --pack-destination "$ROLLBACK_ROOT/rollback" --json \
  > "$ROLLBACK_ROOT/rollback/pack.json"
systemctl --user cat bb.service > "$ROLLBACK_ROOT/bb.service"

systemctl --user stop bb.service
cp -a "$HOME/.bb" "$ROLLBACK_ROOT/bb-state"
npm_config_prefix="$BB_PREFIX" npm_config_ignore_scripts=false \
  "$NPM" install --global "$TARBALL"
systemctl --user start bb.service
```

Verify before declaring success:

```bash
"$BB_PREFIX/bin/bb" --version
systemctl --user is-active bb.service
curl -fsS http://127.0.0.1:38886/health
curl -fsS https://srv1191956.tail7af381.ts.net/health
curl -fsS https://srv1191956.tail7af381.ts.net/install/version
bb machine list --json
journalctl --user -u bb.service --since '10 minutes ago' --no-pager -p warning
```

The Mac and RDLEGION daemons use `--auto-update`. When the server protocol is
newer, they download the exact package from `/install/bb-app.tgz` and restart.

If a Mac daemon update fails, install the server package from a Mac terminal
where Node and npm are available, then restart its existing LaunchAgent:

```bash
curl -fsS https://srv1191956.tail7af381.ts.net/install/bb-app.tgz \
  -o /tmp/bb-app-from-vps.tgz
npm_config_ignore_scripts=false npm install --global /tmp/bb-app-from-vps.tgz
launchctl kickstart -k "gui/$(id -u)/dev.bb.host-daemon.srv1191956"
```

Confirm the VPS reports that Mac as `connected` with no rejected protocol.

## 4. Update the Mac desktop app

After the VPS and Mac daemon are healthy, allow the normal upstream desktop
update. The saved custom server target remains the VPS.

If the desktop app opens the built-in server instead, select the custom server:

```text
https://srv1191956.tail7af381.ts.net
```

## Rollback

Use the backup made immediately before that deployment. Stop BB, preserve the
failed post-update state separately, restore both the old package tarball and
the matching `bb-state`, then restart and run the health checks again.

Do not roll back only the package after a release that changed the database.
The newer server may already have migrated the data.

After a successful update, remove the temporary build worktree but keep the
artifact and rollback backup:

```bash
cd ~/Developer/Projects/bb
git worktree remove --force <exact-build-worktree-path>
git worktree prune
```
