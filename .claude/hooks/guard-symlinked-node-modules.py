#!/usr/bin/env python3
"""Blocks dependency installs that would write through a symlinked node_modules.

scripts/git-hooks/post-checkout symlinks node_modules from main into a fresh
worktree when the lockfiles match at creation time (see CLAUDE.md). If the
worktree's branch later changes package.json/pnpm-lock.yaml and someone runs
an install anyway, pnpm/npm/yarn follow the symlink and write straight into
main's real node_modules — corrupting the shared install for main and every
other worktree still linked to it. This is worth a hard block, not a nudge:
there's no legitimate reason to run an install against a symlinked
node_modules from inside a worktree (it should be `rm`'d first, per
CLAUDE.md), and the corruption is silent and hard to notice until later.
"""
import json
import os
import re
import sys

INSTALL_COMMAND = re.compile(
    r"\b(pnpm|npm|yarn)\b[^|;&]*\b(install|i|add|remove|rm|update|up|prune)\b"
)


def main():
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return 0

    if (payload.get("tool_name") or "") != "Bash":
        return 0

    command = (payload.get("tool_input") or {}).get("command") or ""
    if not INSTALL_COMMAND.search(command):
        return 0

    root = os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())
    node_modules = os.path.join(root, "node_modules")
    if not os.path.islink(node_modules):
        return 0

    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": (
                "node_modules here is a symlink into ~/git/Charm's real "
                "node_modules (see scripts/git-hooks/post-checkout). Running "
                "an install through it would write into main's shared "
                "node_modules, corrupting it for every other worktree linked "
                "to it. If this branch changed package.json/pnpm-lock.yaml: "
                "`rm node_modules` first, then `pnpm install "
                "--frozen-lockfile` to get a real, isolated install."
            ),
        }
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
