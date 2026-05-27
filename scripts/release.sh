#!/usr/bin/env bash
# Release script for agents-observe.
# Auto-bumps version from latest git tag, generates changelog via Claude,
# opens editor for review, then commits, tags, and pushes.
#
# Usage: scripts/release.sh [--dry-run] [patch|minor|major]
#   e.g.  scripts/release.sh           # 1.1.0 → 1.1.1
#         scripts/release.sh minor      # 1.1.0 → 1.2.0
#         scripts/release.sh major      # 1.1.0 → 2.0.0
#         scripts/release.sh --dry-run minor

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# ── Parse args ──────────────────────────────────────────────

DRY_RUN=false
BUMP="patch"

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    patch|minor|major) BUMP="$arg" ;;
    -h|--help)
      echo "Usage: $0 [--dry-run] [patch|minor|major]"
      echo ""
      echo "Bump types:"
      echo "  patch  (default)  Bug fixes and small tweaks"
      echo "                    1.1.0 → 1.1.1 → 1.1.2 ..."
      echo ""
      echo "  minor             New features (resets patch to 0)"
      echo "                    1.1.2 → 1.2.0 → 1.3.0 ..."
      echo ""
      echo "  major             Breaking changes (resets minor and patch to 0)"
      echo "                    1.2.0 → 2.0.0 → 3.0.0 ..."
      exit 0
      ;;
    *) echo "Error: unknown argument '$arg'"; echo "Usage: $0 [--dry-run] [patch|minor|major]"; exit 1 ;;
  esac
done

# ── Compute version from latest tag ────────────────────────

LATEST_TAG=$(git tag --sort=-v:refname | head -1)

if [ -z "$LATEST_TAG" ]; then
  echo "No tags found. Starting from v0.1.0"
  LATEST_TAG="v0.0.0"
fi

# Strip v prefix, split into components
CURRENT="${LATEST_TAG#v}"
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "$BUMP" in
  patch) PATCH=$((PATCH + 1)) ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
esac

VERSION="${MAJOR}.${MINOR}.${PATCH}"
TAG="v${VERSION}"

echo ""
echo "  ${LATEST_TAG} → ${TAG} (${BUMP})"
echo ""

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Error: tag $TAG already exists"
  exit 1
fi

if ! $DRY_RUN && [ -n "$(git status --porcelain)" ]; then
  echo "Error: working directory is not clean — commit or stash changes first"
  exit 1
fi

# Make sure all hooks are properly configured in the hooks files
echo ""
if bun run ./scripts/check-hooks.ts; then
  echo "All hooks properly configured"
else
  echo "Fix the hooks before releasing"
  exit 1
fi

echo "=== Releasing $TAG ==="

# ── Generate changelog ──────────────────────────────────

scripts/generate-changelog.sh "$VERSION"

# Open in editor for review
EDITOR="${VISUAL:-${EDITOR:-vi}}"
echo ""
echo "Opening CHANGELOG.md in $EDITOR for review..."
echo "Save and close when done. Ctrl-C to abort the release."
"$EDITOR" CHANGELOG.md

# Verify the new version appears in CHANGELOG.md
if ! grep -q "## $TAG" CHANGELOG.md; then
  echo "Error: CHANGELOG.md does not contain an entry for $TAG"
  echo "The entry must include a line starting with: ## $TAG"
  exit 1
fi

echo "Changelog entry for $TAG confirmed."

# ── Bump versions ────────────────────────────────────────

echo ""
echo "Bumping version to $VERSION..."

# VERSION file (source of truth for server + CLI)
echo "$VERSION" > VERSION

# package.json (root)
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" package.json

# .claude-plugin/plugin.json (static manifest — can't read files)
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" .claude-plugin/plugin.json

# ── Test and build ───────────────────────────────────────

echo ""
echo "=== Running tests ==="
npm test

echo ""
echo "=== Building Docker image ==="
docker build -t agents-observe:local .

echo ""
echo "=== Running fresh install test ==="
scripts/test-fresh-install.sh --skip-build

if $DRY_RUN; then
  echo ""
  echo "=== Dry run complete ==="
  echo "Changelog, version bumps, tests, and Docker build all passed."
  echo "Modified files (not committed):"
  git status --short
  echo ""
  echo "To finish the release, revert changes and run without --dry-run:"
  echo "  git checkout -- VERSION package.json .claude-plugin/plugin.json CHANGELOG.md"
  echo "  scripts/release.sh $BUMP"
  exit 0
fi

# ── Commit, tag, push ────────────────────────────────────

echo ""
echo "Committing release..."
git add VERSION package.json .claude-plugin/plugin.json CHANGELOG.md
git commit -m "release: v${VERSION}"

echo "Tagging $TAG..."
git tag "$TAG"

echo "Pushing to origin..."
git push origin main "$TAG"

echo ""
echo "=== Released $TAG ==="
echo "GitHub Actions will build the Docker image and create the GitHub release."
echo "Watch: https://github.com/diegorv/koko-fork-agents-observe/actions"
