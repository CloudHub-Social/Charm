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
# A `-d .git` check misses a valid checkout that's itself a linked worktree
# (where .git is a file pointing at the common dir, not a directory) — probe
# with git itself instead, which works for both a normal checkout and a
# linked worktree.
[ -d "$repo_root" ] || exit 0
git -C "$repo_root" rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
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
fail_marker="/tmp/charm-graphify-update-failed"

# Retry the graph update even when main hasn't moved, if the last attempt
# failed or never ran (missing graph) — otherwise a transient graphify
# failure (or `graphify` landing on PATH after this job started) would leave
# graphify-out stale/missing until origin/main happens to advance again.
need_graphify_update=0
if [ ! -f "$repo_root/graphify-out/graph.json" ] || [ -f "$fail_marker" ]; then
  need_graphify_update=1
fi

if [ "$local_head" != "$remote_head" ]; then
  if ! git merge-base --is-ancestor "$local_head" "$remote_head"; then
    echo "sync-main-graphify: local main has diverged from origin/main — skipping" >&2
    exit 0
  fi

  lockfile_before=""
  [ -f "$repo_root/pnpm-lock.yaml" ] && lockfile_before="$(cat "$repo_root/pnpm-lock.yaml")"

  git merge --quiet --ff-only origin/main
  echo "sync-main-graphify: fast-forwarded main $local_head -> $remote_head"
  need_graphify_update=1

  lockfile_after=""
  [ -f "$repo_root/pnpm-lock.yaml" ] && lockfile_after="$(cat "$repo_root/pnpm-lock.yaml")"

  # If the fast-forward moved pnpm-lock.yaml, main's own real node_modules
  # is now stale relative to its own lockfile — and every worktree created
  # afterwards would symlink that stale install while believing (correctly,
  # by lockfile comparison) that it matches main. Reinstalling here is what
  # actually keeps the shared node_modules trustworthy, not just the
  # lockfile-comparison guard (which only catches divergence, not main
  # itself being behind its own lockfile).
  if [ "$lockfile_before" != "$lockfile_after" ]; then
    if command -v pnpm >/dev/null 2>&1; then
      echo "sync-main-graphify: pnpm-lock.yaml changed — reinstalling main's dependencies"
      if pnpm install --frozen-lockfile >/tmp/charm-sync-pnpm-install.log 2>&1; then
        echo "sync-main-graphify: pnpm install completed"
      else
        echo "sync-main-graphify: pnpm install failed — see /tmp/charm-sync-pnpm-install.log" >&2
      fi
    else
      echo "sync-main-graphify: pnpm-lock.yaml changed but pnpm not found on PATH — main's node_modules is now stale" >&2
    fi
  fi
fi

if [ "$need_graphify_update" = "1" ]; then
  if command -v graphify >/dev/null 2>&1; then
    if graphify update . >/tmp/charm-graphify-update.log 2>&1; then
      echo "sync-main-graphify: graphify updated"
      rm -f "$fail_marker"
    else
      echo "sync-main-graphify: graphify update failed — see /tmp/charm-graphify-update.log" >&2
      touch "$fail_marker"
    fi
  else
    # graphify isn't resolvable right now (e.g. launchd's PATH doesn't
    # include it yet) — mark this a failure too, not just a silent no-op,
    # so the *next* run retries even though main didn't move meanwhile.
    echo "sync-main-graphify: graphify not found on PATH — will retry next run" >&2
    touch "$fail_marker"
  fi
fi

# Backfill graphify-out into worktrees that didn't get the symlink at
# creation time — e.g. created before main had ever built a graph, so
# scripts/git-hooks/post-checkout had nothing to link to yet.
if [ -d "$repo_root/graphify-out" ]; then
  git worktree list --porcelain | sed -n 's/^worktree //p' | while IFS= read -r wt; do
    [ "$wt" = "$repo_root" ] && continue
    [ -e "$wt/graphify-out" ] && continue
    [ -L "$wt/graphify-out" ] && continue
    ln -s "$repo_root/graphify-out" "$wt/graphify-out" 2>/dev/null || true
  done
fi
