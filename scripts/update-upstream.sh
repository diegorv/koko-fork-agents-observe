#!/usr/bin/env bash
#
# Sync the local `upstream-main` branch with the upstream repo
# (simple10/agents-observe) and push it to `origin` (your fork).
#
# This script only updates the mirror branch. It does NOT touch
# your `main`. To bring upstream changes into your work:
#
#   git checkout main
#   git merge upstream-main      # or: git rebase upstream-main
#
# Usage:
#   ./scripts/update-upstream.sh           # sync upstream-main only
#   ./scripts/update-upstream.sh --tags    # also push new tags to origin

set -euo pipefail

UPSTREAM_REMOTE="upstream"
UPSTREAM_URL="https://github.com/simple10/agents-observe.git"
UPSTREAM_BRANCH="main"
LOCAL_MIRROR="upstream-main"
ORIGIN_REMOTE="origin"

push_tags=0
for arg in "$@"; do
  case "$arg" in
    --tags) push_tags=1 ;;
    -h|--help)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"

if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  echo "Adding remote '$UPSTREAM_REMOTE' -> $UPSTREAM_URL"
  git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
fi

echo "Fetching $UPSTREAM_REMOTE..."
git fetch --prune --tags "$UPSTREAM_REMOTE"

# Reject sync if the local mirror has diverged (i.e., somebody committed to it).
# The mirror must stay a fast-forward of upstream/$UPSTREAM_BRANCH.
if git show-ref --verify --quiet "refs/heads/$LOCAL_MIRROR"; then
  base=$(git merge-base "$LOCAL_MIRROR" "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" || true)
  local_sha=$(git rev-parse "$LOCAL_MIRROR")
  if [ -n "$base" ] && [ "$base" != "$local_sha" ] && [ "$local_sha" != "$(git rev-parse "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH")" ]; then
    echo "ERROR: '$LOCAL_MIRROR' has commits not in $UPSTREAM_REMOTE/$UPSTREAM_BRANCH." >&2
    echo "The mirror branch must never receive local commits. Inspect with:" >&2
    echo "  git log $UPSTREAM_REMOTE/$UPSTREAM_BRANCH..$LOCAL_MIRROR" >&2
    exit 1
  fi
else
  echo "Creating local branch '$LOCAL_MIRROR' from $UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
  git branch "$LOCAL_MIRROR" "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
fi

current_branch=$(git symbolic-ref --quiet --short HEAD || echo "")

if [ "$current_branch" = "$LOCAL_MIRROR" ]; then
  echo "Fast-forwarding '$LOCAL_MIRROR'..."
  git merge --ff-only "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
else
  echo "Updating '$LOCAL_MIRROR' ref (fast-forward only)..."
  git fetch . "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH:$LOCAL_MIRROR"
fi

echo "Pushing '$LOCAL_MIRROR' to $ORIGIN_REMOTE..."
git push "$ORIGIN_REMOTE" "$LOCAL_MIRROR"

if [ "$push_tags" -eq 1 ]; then
  echo "Pushing tags to $ORIGIN_REMOTE..."
  git push "$ORIGIN_REMOTE" --tags
fi

ahead=$(git rev-list --count "$LOCAL_MIRROR..main" 2>/dev/null || echo "?")
behind=$(git rev-list --count "main..$LOCAL_MIRROR" 2>/dev/null || echo "?")
echo
echo "Done. main vs $LOCAL_MIRROR: ahead $ahead, behind $behind."
if [ "$behind" != "0" ] && [ "$behind" != "?" ]; then
  echo "To pull upstream changes into main:"
  echo "  git checkout main && git merge $LOCAL_MIRROR"
fi
