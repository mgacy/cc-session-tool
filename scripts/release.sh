#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <major|minor|patch>" >&2
  exit 1
}

[[ $# -eq 1 ]] || usage

KIND="$1"
[[ "$KIND" == "major" || "$KIND" == "minor" || "$KIND" == "patch" ]] || usage

# 1. Assert on main with clean working tree
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "main" ]]; then
  echo "Error: must be on main (currently on $BRANCH)" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean" >&2
  exit 1
fi

# 2. Assert local main is up-to-date with remote
git fetch origin main --quiet
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "Error: local main is not up-to-date with origin/main" >&2
  echo "Run 'git pull origin main' first." >&2
  exit 1
fi

# 3. Assert commits exist since last tag
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [[ -n "$LAST_TAG" ]]; then
  COMMITS_SINCE=$(git rev-list "${LAST_TAG}..HEAD" --count)
  if [[ "$COMMITS_SINCE" -eq 0 ]]; then
    echo "Error: no commits since $LAST_TAG" >&2
    exit 1
  fi
fi

# 4. Run tests
echo "Running tests..."
if ! bun test; then
  echo "Error: tests failed — release aborted." >&2
  exit 1
fi

# 5. Compute next version
CURRENT=$(sed -n 's/^export const VERSION = "\([^"]*\)";$/\1/p' index.ts)
if [[ -z "$CURRENT" ]]; then
  echo "Error: could not read VERSION from index.ts" >&2
  exit 1
fi

IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

if [[ -z "$MAJOR" || -z "$MINOR" || -z "$PATCH" ]] || \
   ! [[ "$MAJOR" =~ ^[0-9]+$ && "$MINOR" =~ ^[0-9]+$ && "$PATCH" =~ ^[0-9]+$ ]]; then
  echo "Error: VERSION '$CURRENT' is not a valid major.minor.patch triplet" >&2
  exit 1
fi

case "$KIND" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac

NEXT="${MAJOR}.${MINOR}.${PATCH}"
TAG="v${NEXT}"

echo "Releasing: $CURRENT -> $NEXT"

# 6. Check for tag collision before any mutations
if git show-ref --tags --verify -- "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "Error: tag $TAG already exists. Was there a previous failed release?" >&2
  echo "To remove it: git tag -d $TAG" >&2
  exit 1
fi

# 7. Update VERSION in index.ts
sed -i '' "s/^export const VERSION = \"${CURRENT}\";$/export const VERSION = \"${NEXT}\";/" index.ts

VERIFY=$(sed -n 's/^export const VERSION = "\([^"]*\)";$/\1/p' index.ts)
if [[ "$VERIFY" != "$NEXT" ]]; then
  echo "Error: VERSION substitution failed — got '$VERIFY', expected '$NEXT'" >&2
  git checkout index.ts
  exit 1
fi

# 8. Commit
git add index.ts
git commit -m "Bump $TAG"

# 9. Tag
git tag "$TAG"

# 10. Push commit + tag together
if ! git push origin main "$TAG"; then
  echo "" >&2
  echo "Error: push failed. Local commit and tag '$TAG' exist but were not pushed." >&2
  echo "To retry:  git push origin main $TAG" >&2
  echo "To undo:   git tag -d $TAG && git reset HEAD~1" >&2
  exit 1
fi

echo "Done. $TAG pushed — CI will build and create the release."
