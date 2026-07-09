#!/bin/sh
# Fast-forwards the main worktree to origin/main when it has moved, then
# refreshes the graphify graph — so worktree-linked graphify-out (see
# scripts/git-hooks/post-checkout) doesn't silently drift stale behind main.
#
# Safe by construction: only ever fast-forwards (never rebases/resets), and
# skips entirely if the main worktree has any uncommitted changes — this must
# never discard in-progress work sitting in the shared ~/git/Charm checkout.
set -e

repo_root="${CHARM_MAIN_WORKTREE:-$HOME/git/Charm}"
[ -d "$repo_root/.git" ] || exit 0
cd "$repo_root"

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "main" ]; then
  echo "sync-main-graphify: $repo_root is on '$branch', not main — skipping" >&2
  exit 0
fi

if [ -n "$(git status --porcelain -uall)" ]; then
  echo "sync-main-graphify: $repo_root has uncommitted changes — skipping" >&2
  exit 0
fi

git fetch --quiet origin main

local_head="$(git rev-parse HEAD)"
remote_head="$(git rev-parse origin/main)"
[ "$local_head" = "$remote_head" ] && exit 0

if ! git merge-base --is-ancestor "$local_head" "$remote_head"; then
  echo "sync-main-graphify: local main has diverged from origin/main — skipping" >&2
  exit 0
fi

git merge --quiet --ff-only origin/main
echo "sync-main-graphify: fast-forwarded main $local_head -> $remote_head"

if command -v graphify >/dev/null 2>&1; then
  graphify update . >/tmp/charm-graphify-update.log 2>&1 \
    && echo "sync-main-graphify: graphify updated" \
    || echo "sync-main-graphify: graphify update failed — see /tmp/charm-graphify-update.log" >&2
fi
