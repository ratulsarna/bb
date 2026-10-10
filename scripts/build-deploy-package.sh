#!/usr/bin/env bash
# Builds and tests a deployable bb-app tarball from codex/deployment in a
# throwaway worktree. See docs/how-to-update-bb.md for where it fits.
set -euo pipefail

cd ~/Developer/Projects/bb
corepack enable pnpm
umask 0022

mkdir -p ~/Developer/Projects/bb-builds

DEPLOY_SHA="$(git rev-parse codex/deployment)"
SHORT_SHA="$(git rev-parse --short=12 codex/deployment)"
STAMP="$(date -u +%Y%m%d%H%M%S)"
BUILD_DIR="$(mktemp -d ~/Developer/Projects/bb-builds/${SHORT_SHA}-${STAMP}.XXXXXX)"
ARTIFACT_DIR="$HOME/bb-artifacts/${SHORT_SHA}-${STAMP}"
mkdir -p "$ARTIFACT_DIR"

echo "::: BUILD_DIR=$BUILD_DIR"
echo "::: ARTIFACT_DIR=$ARTIFACT_DIR"

git worktree add --detach "$BUILD_DIR" "$DEPLOY_SHA"
cd "$BUILD_DIR"

echo "::: STEP install"
pnpm install --frozen-lockfile --prefer-offline

BASE_VERSION="$(node -p "require('./packages/bb-app/package.json').version")"
CUSTOM_VERSION="$(node -e '
  const [version, stamp, sha] = process.argv.slice(1);
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  if (match === null) throw new Error(`Invalid version: ${version}`);
  console.log(`${match[1]}.${match[2]}.${Number(match[3]) + 1}-deploy.${stamp}.${sha}`);
' "$BASE_VERSION" "$STAMP" "$SHORT_SHA")"

echo "::: BASE_VERSION=$BASE_VERSION"
echo "::: CUSTOM_VERSION=$CUSTOM_VERSION"

node scripts/bump-version.mjs "$CUSTOM_VERSION"
node .github/workflows/check-version-lockstep.mjs

# Three cases in this upstream test run a real `npm install bb-app` from the
# registry, because they never stub npm and this VPS has the apt npm on PATH.
# A full install takes 16-23s against the test's 15s budget. Raise it in this
# throwaway worktree only; drop this once upstream stubs npm there.
INSTALLER_TEST=apps/server/test/app/install-machine-script.test.ts
if grep -q 'describeOnPosix("machine install script", { timeout: 15_000 }' "$INSTALLER_TEST"; then
  sed -i 's/describeOnPosix("machine install script", { timeout: 15_000 }/describeOnPosix("machine install script", { timeout: 60_000 }/' "$INSTALLER_TEST"
  echo "::: installer test budget raised to 60s (build worktree only)"
else
  echo "::: installer test budget pattern not found; upstream changed it, check whether this step is still needed"
fi

echo "::: STEP typecheck"
pnpm exec turbo run typecheck \
  --filter=@bb/app \
  --filter=@bb/config \
  --filter=@bb/server \
  --filter=@bb/host-daemon \
  --filter=bb-app \
  --concurrency=2 \
  --output-logs=new-only

echo "::: STEP test"
# Two budgets, both sized for this 8-core VPS which also runs the live bb
# server. Vitest's 5s default per-test timeout is too tight under load, so 30s
# absorbs spikes while still failing real hangs. And turbo --concurrency=2 used
# to run two packages at once, each spawning cpus-1 vitest workers: ~14 workers
# on 8 cores, which starved the server suite's installer tests past 30s.
# --concurrency=1 plus --maxWorkers=4 keeps total workers under the core count.
pnpm exec turbo run test \
  --filter=@bb/app \
  --filter=@bb/config \
  --filter=@bb/server \
  --filter=@bb/host-daemon \
  --filter=bb-app \
  --concurrency=1 \
  --output-logs=new-only \
  -- --testTimeout=30000 --maxWorkers=4

echo "::: STEP codex plugin typecheck"
pnpm exec turbo run typecheck --filter=bb-plugin-provider-codex --output-logs=new-only

echo "::: STEP codex plugin test"
pnpm exec turbo run test --filter=bb-plugin-provider-codex --output-logs=new-only -- --testTimeout=30000 --maxWorkers=4

echo "::: STEP smoke:tarball"
pnpm exec turbo run smoke:tarball --filter=bb-app --force --output-logs=new-only

echo "::: STEP pack"
npm pack ./packages/bb-app --pack-destination "$ARTIFACT_DIR" --json \
  > "$ARTIFACT_DIR/pack.json"
sha256sum "$ARTIFACT_DIR"/bb-app-*.tgz | tee "$ARTIFACT_DIR/sha256.txt"
printf 'commit=%s\nversion=%s\n' "$DEPLOY_SHA" "$CUSTOM_VERSION" \
  > "$ARTIFACT_DIR/build-metadata.txt"

echo "::: BUILD OK"
echo "::: artifact dir: $ARTIFACT_DIR"
ls -la "$ARTIFACT_DIR"
