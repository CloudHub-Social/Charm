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

Tracks the effective working directory per shell-operator-separated segment
(splitting on &&/||/;/|), updating it on each `cd <path>` segment, instead of
resolving one cwd from only a single leading `cd` — a compound command can
`cd` more than once before the actual `graphify update` invocation (e.g. `cd
~/git/Charm && true; cd ~/git/Charm-worktree && graphify update .`), and only
the cwd active *at that invocation* is the one that matters. This is a plain
whitespace/operator split, not real shell parsing (doesn't handle quoting,
subshells, or command substitution) — a best-effort heuristic, not a
security boundary.
"""
import json
import os
import re
import sys

GRAPHIFY_UPDATE = re.compile(r"\bgraphify\s+update\b")
SHELL_OPERATORS = re.compile(r"(&&|\|\||;|\|)")
CD_SEGMENT = re.compile(r'^\s*cd\s+("[^"]+"|\'[^\']+\'|\S+)\s*$')


def iter_segments_with_cwd(command, default_cwd):
    """Yields (segment, cwd) pairs, tracking cwd across `cd` segments."""
    cwd = default_cwd
    for part in SHELL_OPERATORS.split(command):
        if SHELL_OPERATORS.fullmatch(part):
            continue
        m = CD_SEGMENT.match(part)
        if m:
            path = m.group(1).strip("\"'")
            path = os.path.expanduser(path)
            if not os.path.isabs(path):
                path = os.path.join(cwd, path)
            cwd = os.path.normpath(path)
        yield part, cwd


def deny():
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
    for segment, cwd in iter_segments_with_cwd(command, default_root):
        if not GRAPHIFY_UPDATE.search(segment):
            continue
        graphify_out = os.path.join(cwd, "graphify-out")
        if os.path.islink(graphify_out):
            deny()
            return 0

    return 0


if __name__ == "__main__":
    sys.exit(main())
