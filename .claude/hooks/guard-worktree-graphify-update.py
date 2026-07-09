#!/usr/bin/env python3
"""Blocks `graphify update` from a worktree with a symlinked graphify-out.

scripts/git-hooks/post-checkout symlinks graphify-out from main into new
worktrees so graphify works immediately (see CLAUDE.md). But that means
`graphify update .` run from a worktree writes through the symlink into
main's real graphify-out — overwriting the shared graph with a snapshot of
unmerged, worktree-only code. Every other worktree reading that same symlink
then sees misleading nodes/paths until someone rebuilds it from main. main
itself has a real (non-symlink) graphify-out, so this only fires for
worktrees, and scripts/sync-main-graphify.sh remains the intended way to
refresh the shared graph.

Resolves the effective working directory from a leading `cd <path> &&`/`;` in
the command when present (e.g. `cd ~/git/Charm && graphify update .`), rather
than trusting CLAUDE_PROJECT_DIR blindly — a Claude session rooted in a
worktree can still legitimately `cd` into main first to run the update there,
and that's exactly the documented workaround this hook's own message
suggests, so it must not itself be blocked.
"""
import json
import os
import re
import sys

GRAPHIFY_UPDATE = re.compile(r"\bgraphify\s+update\b")
LEADING_CD = re.compile(r'^\s*cd\s+("[^"]+"|\'[^\']+\'|\S+)\s*(?:&&|;)')


def resolve_cwd(command, default_cwd):
    m = LEADING_CD.match(command)
    if not m:
        return default_cwd
    path = m.group(1).strip("\"'")
    path = os.path.expanduser(path)
    if not os.path.isabs(path):
        path = os.path.join(default_cwd, path)
    return os.path.normpath(path)


def main():
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return 0

    if (payload.get("tool_name") or "") != "Bash":
        return 0

    command = (payload.get("tool_input") or {}).get("command") or ""
    if not GRAPHIFY_UPDATE.search(command):
        return 0

    default_root = os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())
    root = resolve_cwd(command, default_root)
    graphify_out = os.path.join(root, "graphify-out")
    if not os.path.islink(graphify_out):
        return 0

    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": (
                "graphify-out here is a symlink into ~/git/Charm's real "
                "graph (see scripts/git-hooks/post-checkout). Running "
                "`graphify update .` from this worktree would overwrite "
                "main's shared graph with this branch's unmerged state, "
                "misleading every other worktree linked to it. The graph "
                "refreshes automatically every ~15 minutes from main via "
                "scripts/sync-main-graphify.sh; if you need it sooner, run "
                "`graphify update .` from ~/git/Charm (main) directly, not "
                "from this worktree."
            ),
        }
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
