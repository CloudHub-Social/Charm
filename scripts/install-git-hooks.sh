#!/bin/sh
# Installs repo-tracked git hooks (scripts/git-hooks/*) into the shared
# hooks directory. Hooks aren't versioned by git itself (.git/hooks is
# never committed), so this copies them in on `pnpm install` instead.
#
# Uses --git-common-dir rather than --git-dir: worktrees each have their own
# .git file pointing at a private git-dir, but they all share one common dir
# and its hooks/ — installing once here covers every worktree of this repo.
set -e

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
common_dir="$(git -C "$repo_root" rev-parse --git-common-dir 2>/dev/null)" || exit 0
[ -n "$common_dir" ] || exit 0

case "$common_dir" in
  /*) ;;
  *) common_dir="$repo_root/$common_dir" ;;
esac

mkdir -p "$common_dir/hooks"
for hook in "$repo_root"/scripts/git-hooks/*; do
  name="$(basename "$hook")"
  cp "$hook" "$common_dir/hooks/$name"
  chmod +x "$common_dir/hooks/$name"
done
