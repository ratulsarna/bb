#!/usr/bin/env bash
# Publishes a verified build-deploy-package.sh artifact as the fork's latest
# GitHub release. Installed fork servers read the release's `latest` asset to
# find updates and install the tarball by its versioned URL, so a published
# release must never be replaced. See docs/how-to-update-bb.md.
set -euo pipefail

REPO="ratulsarna/bb"
ARTIFACT_DIR="${1:?usage: publish-fork-release.sh <artifact-dir>}"

cd ~/Developer/Projects/bb

COMMIT="$(sed -n 's/^commit=//p' "$ARTIFACT_DIR/build-metadata.txt")"
VERSION="$(sed -n 's/^version=//p' "$ARTIFACT_DIR/build-metadata.txt")"
TARBALL="$ARTIFACT_DIR/bb-app-$VERSION.tgz"
TAG="fork-v$VERSION"

echo "::: VERSION=$VERSION"
echo "::: COMMIT=$COMMIT"

(cd "$ARTIFACT_DIR" && sha256sum --check sha256.txt)

git fetch --quiet origin
if ! git merge-base --is-ancestor "$COMMIT" origin/codex/deployment; then
  echo "::: $COMMIT is not on origin/codex/deployment; push it first" >&2
  exit 1
fi

CURRENT="$(curl -fsSL "https://github.com/$REPO/releases/latest/download/latest" \
  | node -e 'process.stdin.on("data", (d) => console.log(JSON.parse(d).version))' \
  || true)"
echo "::: CURRENT=${CURRENT:-none}"
if [ -n "$CURRENT" ]; then
  node -e '
    const semver = require(require.resolve("semver", { paths: ["apps/server"] }));
    const [next, current] = process.argv.slice(1);
    if (!semver.gt(next, current)) {
      throw new Error(`${next} must be newer than the published ${current}`);
    }
  ' "$VERSION" "$CURRENT"
fi

UPSTREAM_BASE="$(git merge-base "$COMMIT" upstream/main)"
printf '{"version":"%s"}\n' "$VERSION" > "$ARTIFACT_DIR/latest"

gh release create "$TAG" \
  --repo "$REPO" \
  --target "$COMMIT" \
  --draft \
  --title "bb $VERSION" \
  --notes "Fork build of \`$COMMIT\` on upstream \`$UPSTREAM_BASE\`.

Install: \`npm install -g https://github.com/$REPO/releases/download/$TAG/bb-app-$VERSION.tgz\`" \
  "$TARBALL" "$ARTIFACT_DIR/sha256.txt" "$ARTIFACT_DIR/latest"

gh release edit "$TAG" --repo "$REPO" --draft=false --prerelease=false --latest

echo "::: PUBLISHED $TAG"
curl -fsSL --retry 10 --retry-all-errors --retry-delay 6 \
  "https://github.com/$REPO/releases/latest/download/latest"
