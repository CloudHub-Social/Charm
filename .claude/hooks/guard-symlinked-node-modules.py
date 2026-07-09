#!/usr/bin/env python3
"""Blocks commands that would write through, or silently run against, a
symlinked node_modules that no longer matches main's lockfile.

scripts/git-hooks/post-checkout symlinks node_modules from main into a fresh
worktree when the lockfiles match at creation time (see CLAUDE.md). Two ways
that can go stale:

1. The worktree's own branch changes package.json/pnpm-lock.yaml after
   creation, and someone installs anyway — pnpm/npm/yarn follow the symlink
   and write straight into main's real node_modules, corrupting the shared
   install for every other worktree linked to it. Always blocked, regardless
   of whether the lockfiles currently happen to match.

2. main itself advances past a dependency change (its pnpm-lock.yaml moves),
   while this worktree's own lockfile stays where it was. The symlink still
   resolves, so `pnpm test`/`build`/`dev`/etc. run silently against a
   different dependency set than this worktree's lockfile declares, without
   an install ever touching the symlink. Blocked only when the lockfiles
   currently mismatch, since that's the actual signal something drifted.

Resolves the effective working directory from a leading `cd <path> &&`/`;`
in the command when present (e.g. `cd ~/git/Charm && pnpm install`), rather
than trusting CLAUDE_PROJECT_DIR blindly — otherwise a command that
deliberately cd's into main to run there would be wrongly blocked just
because the *session* is rooted in a worktree.
"""
import json
import os
import re
import sys

# Matches each package-manager invocation together with its *immediate* next
# token (the actual subcommand) — deliberately not a scan over the rest of
# the line, so a test file or flag named e.g. "install"/"config" elsewhere in
# the command can't be mistaken for the subcommand itself.
PKG_MANAGER_INVOCATION = re.compile(r"\b(?:pnpm|npm|yarn|npx)\b\s+(\S+)")

# Subcommands that mutate the dependency tree in place (write straight
# through the symlink into main's real node_modules) — always denied,
# regardless of whether the lockfiles currently happen to match. Includes
# npm's documented aliases (uninstall: un/unlink/r; install: i; ci is npm's
# separate "clean install" verb) plus link/rebuild/dedupe, which rewrite
# node_modules without going through the install/remove path at all.
HARD_DENY_SUBCOMMANDS = {
    "install", "i", "ci", "add",
    "remove", "rm", "uninstall", "un", "unlink", "r",
    "update", "up", "prune",
    "link", "rebuild", "dedupe",
}
# Read-only/informational subcommands — never touch node_modules, so never
# worth blocking or even lockfile-checking.
SAFE_SUBCOMMANDS = {"--version", "-v", "list", "ls", "why", "outdated", "config", "store"}
BIN_INVOCATION = re.compile(r"(?:^|[/\s])node_modules/\.bin/")
LEADING_CD = re.compile(r'^\s*cd\s+("[^"]+"|\'[^\']+\'|\S+)\s*(?:&&|;)')


def classify_command(command):
    """Returns "install" (always deny), "run" (deny only on lockfile
    mismatch), or None (nothing risky) for the given shell command."""
    saw_run = bool(BIN_INVOCATION.search(command))
    for m in PKG_MANAGER_INVOCATION.finditer(command):
        sub = m.group(1)
        if sub in HARD_DENY_SUBCOMMANDS:
            return "install"
        if sub not in SAFE_SUBCOMMANDS:
            saw_run = True
    return "run" if saw_run else None


def resolve_cwd(command, default_cwd):
    m = LEADING_CD.match(command)
    if not m:
        return default_cwd
    path = m.group(1).strip("\"'")
    path = os.path.expanduser(path)
    if not os.path.isabs(path):
        path = os.path.join(default_cwd, path)
    return os.path.normpath(path)


def find_package_root(start_dir):
    """Walk up to the nearest package.json, mirroring how npm/pnpm resolve
    the package root from a nested cwd (e.g. `cd src && npm install` still
    operates on the repo root's node_modules, not a nonexistent src/one)."""
    d = start_dir
    while True:
        if os.path.isfile(os.path.join(d, "package.json")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return start_dir
        d = parent


def lockfiles_match(worktree_root, main_root):
    a = os.path.join(worktree_root, "pnpm-lock.yaml")
    b = os.path.join(main_root, "pnpm-lock.yaml")
    if not (os.path.isfile(a) and os.path.isfile(b)):
        return False
    try:
        with open(a, "rb") as fa, open(b, "rb") as fb:
            return fa.read() == fb.read()
    except OSError:
        return False


def deny(reason):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
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
    kind = classify_command(command)
    if kind is None:
        return 0

    default_root = os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())
    root = find_package_root(resolve_cwd(command, default_root))
    node_modules = os.path.join(root, "node_modules")
    if not os.path.islink(node_modules):
        return 0

    main_root = os.path.dirname(os.readlink(node_modules))

    if kind == "install":
        deny(
            "node_modules here is a symlink into ~/git/Charm's real "
            "node_modules (see scripts/git-hooks/post-checkout). Running "
            "an install through it would write into main's shared "
            "node_modules, corrupting it for every other worktree linked "
            "to it. If this branch changed package.json/pnpm-lock.yaml: "
            "`rm node_modules` first, then `pnpm install "
            "--frozen-lockfile` to get a real, isolated install."
        )
        return 0

    if not lockfiles_match(root, main_root):
        deny(
            "node_modules here is a symlink into main's node_modules, but "
            "this worktree's pnpm-lock.yaml no longer matches main's — main "
            "has likely advanced past a dependency change since this "
            "worktree was created. Running this now would use a different "
            "dependency set than this worktree's own lockfile declares. "
            "`rm node_modules && pnpm install --frozen-lockfile` first to "
            "get a real, isolated install matching this branch's lockfile."
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
