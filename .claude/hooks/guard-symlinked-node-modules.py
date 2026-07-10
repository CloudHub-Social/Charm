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

Tracks the effective working directory per shell-operator-separated segment
(splitting on &&/||/;/|), updating it on each `cd <path>` segment, instead of
resolving one cwd from only a single leading `cd` — a compound command can
`cd` more than once before the actual package-manager invocation (e.g. `cd
~/git/Charm && true; cd ~/git/Charm-worktree && npm install`), and only the
cwd active *at that invocation* is the one that matters. This is a plain
whitespace/operator split, not real shell parsing (doesn't handle quoting,
subshells, or command substitution) — a best-effort heuristic, not a
security boundary.
"""
import json
import os
import re
import sys

# Subcommands that mutate the dependency tree in place (write straight
# through the symlink into main's real node_modules) — always denied,
# regardless of whether the lockfiles currently happen to match. Includes
# npm's documented aliases (install: i/in/ins/inst; uninstall: un/unlink/r;
# ci is npm's separate "clean install" verb) plus link/rebuild/dedupe, which
# rewrite node_modules without going through the install/remove path at all.
HARD_DENY_SUBCOMMANDS = {
    "install", "i", "in", "ins", "inst",
    "insta", "instal", "isnt", "isnta", "isntal", "isntall",
    "install-test", "it",
    "install-ci-test", "cit", "clean-install-test", "sit",
    "ci", "add",
    "remove", "rm", "uninstall", "un", "unlink", "r",
    "update", "up", "prune",
    "link", "rebuild", "dedupe",
}
# Read-only/informational subcommands — never touch node_modules, so never
# worth blocking or even lockfile-checking.
SAFE_SUBCOMMANDS = {"--version", "-v", "list", "ls", "why", "outdated", "config", "store"}
# Leading package-manager options that take a following value token, so the
# token after them isn't the subcommand either (e.g. `npm --prefix . install`
# — "." is --prefix's value, "install" is the actual verb). Also used to
# redirect the check to the target directory itself, since that's where
# the command actually operates, not the caller's cwd.
VALUE_FLAGS = {"--prefix", "--dir", "--cwd", "-C"}

PKG_MANAGER_NAME = re.compile(r"\b(pnpm|npm|yarn|npx)\b")
BIN_INVOCATION = re.compile(r"(?:^|[/\s])node_modules/\.bin/")
SHELL_OPERATORS = re.compile(r"(&&|\|\||;|\||\n)")
CD_SEGMENT = re.compile(r'^\s*cd\s+("[^"]+"|\'[^\']+\'|\S+)\s*$')


def find_subcommand(rest_of_segment):
    """Given the text after a package-manager name within one segment,
    return (subcommand, target_override) — skipping leading option flags,
    and for a known value-taking flag, capturing its value as the effective
    target directory (e.g. `npm --prefix ~/other install` operates on
    ~/other, not the caller's cwd) while still skipping past it to find the
    actual verb."""
    tokens = rest_of_segment.split()
    i = 0
    override = None
    while i < len(tokens):
        tok = tokens[i]
        if tok.startswith("-"):
            # --prefix=<value> packs the value into the same token; --prefix
            # <value> (or -C <value>) puts it in the next one. Handle both.
            name, sep, value = tok.partition("=")
            if sep and name in VALUE_FLAGS:
                override = value
                i += 1
            elif tok in VALUE_FLAGS:
                if i + 1 < len(tokens):
                    override = tokens[i + 1]
                i += 2
            else:
                i += 1
            continue
        return tok, override
    return None, override


def classify_segment(segment):
    """Returns (kind, target_override) for one shell-operator-separated
    segment of a command. kind is "install" (always deny), "run" (deny only
    on lockfile mismatch), or None (nothing risky). target_override is a
    directory (from e.g. --prefix) the command actually operates on, if
    different from the caller's cwd."""
    saw_run = bool(BIN_INVOCATION.search(segment))
    run_override = None
    for m in PKG_MANAGER_NAME.finditer(segment):
        rest = segment[m.end():]
        if m.group(1) == "npx":
            # npx runs arbitrary third-party packages as commands (e.g.
            # install-peerdeps, npm-check-updates, patch-package,
            # npm-force-resolutions) — an open-ended set we can't enumerate
            # subcommand-by-subcommand like pnpm/npm/yarn's own fixed verb
            # list. Treat every invocation as install-equivalent (always
            # denied on a symlinked node_modules) except the couple of
            # genuinely inert forms — checked as the literal first token,
            # not via find_subcommand (which skips flags to find a verb
            # that, for npx, doesn't exist the same way).
            first = rest.split()[:1]
            if first and first[0] not in {"--version", "-v"}:
                return "install", None
            continue
        sub, override = find_subcommand(rest)
        if sub is None:
            continue
        if sub in HARD_DENY_SUBCOMMANDS:
            return "install", override
        if sub not in SAFE_SUBCOMMANDS:
            saw_run = True
            run_override = override
    return ("run", run_override) if saw_run else (None, None)


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


def check_segment(kind, cwd):
    """Returns True (and prints a deny) if this segment's node_modules
    situation should block the command; False if it's fine."""
    root = find_package_root(cwd)
    node_modules = os.path.join(root, "node_modules")
    if not os.path.islink(node_modules):
        return False

    # realpath, not readlink: readlink returns the symlink's literal target,
    # which is relative to node_modules's own directory if it was created as
    # a relative symlink (e.g. hand-linked per CLAUDE.md's fallback
    # instructions) — dirname()'ing that directly would resolve to the wrong
    # place. realpath always returns an absolute, fully resolved path.
    main_root = os.path.dirname(os.path.realpath(node_modules))

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
        return True

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
        return True

    # Written by scripts/sync-main-graphify.sh when a reinstall of main's own
    # dependencies fails after a lockfile-changing fast-forward. Lockfiles
    # can match while this is set — that's exactly the case it exists to
    # catch: main's real install doesn't actually reflect its own lockfile
    # right now, so a "matching" comparison would otherwise wrongly pass.
    if os.path.exists(os.path.join(main_root, "node_modules", ".charm-stale")):
        deny(
            "node_modules here is a symlink into main's node_modules, but "
            "main's own dependency reinstall failed after its last "
            "lockfile change (see scripts/sync-main-graphify.sh) — its "
            "real node_modules doesn't actually reflect its own lockfile "
            "right now, even though the lockfiles compare equal. `rm "
            "node_modules && pnpm install --frozen-lockfile` first to get "
            "a real, isolated install."
        )
        return True

    return False


def main():
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return 0

    if (payload.get("tool_name") or "") not in ("Bash", "PowerShell"):
        return 0

    command = (payload.get("tool_input") or {}).get("command") or ""
    default_root = os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())

    for segment, cwd in iter_segments_with_cwd(command, default_root):
        kind, override = classify_segment(segment)
        if kind is None:
            continue
        effective_cwd = cwd
        if override:
            override_path = os.path.expanduser(override)
            if not os.path.isabs(override_path):
                override_path = os.path.join(cwd, override_path)
            effective_cwd = os.path.normpath(override_path)
        if check_segment(kind, effective_cwd):
            return 0

    return 0


if __name__ == "__main__":
    sys.exit(main())
