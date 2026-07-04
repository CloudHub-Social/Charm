#!/usr/bin/env python3
"""Blocks `gh pr create` unless it targets `main` or a `release/*` branch.

See CLAUDE.md: "All PRs must target the `main` branch." Rewritten from a
bash/grep implementation after review found several real bypasses that plain
regex substring-matching couldn't close: a --base value smuggled inside an
unrelated quoted argument, a --base flag belonging to a *different* chained
command (`;`, `&&`, `||`), and `gh`'s own global flags (e.g. `-R owner/repo`)
appearing before the `pr create` subcommand. Proper shell-aware tokenization
closes all three at once.

Note (Charm 2.0): 1.0 enforced `integration` because that fork used an
integration trunk. 2.0 is a fresh repo whose default branch is `main`; if an
integration/release branching model is adopted later, add it to ALLOWED_BASES.
"""
import json
import shlex
import sys

# Bases a PR may target. Adjust here if 2.0 adopts an integration trunk.
ALLOWED_BASES = {"main"}
ALLOWED_BASE_PREFIXES = ("release/",)

# gh's documented global flags that consume the following token as a value.
# https://cli.github.com/manual/gh_pr_create
GH_GLOBAL_FLAGS_WITH_VALUE = {"-R", "--repo", "--hostname"}

SHELL_OPERATORS = {";", "&&", "||", "|", "&"}


def tokenize(cmd):
    # plain shlex.split() only treats shell operators (;, &&, etc.) as their
    # own tokens when whitespace-separated — `dev;` stays glued together as
    # one token otherwise, silently defeating split_simple_commands below.
    # shlex.shlex with punctuation_chars splits them out unconditionally
    # while still honoring quotes.
    lexer = shlex.shlex(cmd, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    return list(lexer)


def split_simple_commands(tokens):
    commands = []
    current = []
    for t in tokens:
        if t in SHELL_OPERATORS:
            if current:
                commands.append(current)
            current = []
        else:
            current.append(t)
    if current:
        commands.append(current)
    return commands


def base_value_if_pr_create(tokens):
    """Return (is_gh_pr_create, base_value_or_None) for one simple command."""
    if not tokens or tokens[0] != "gh":
        return False, None
    i = 1
    while i < len(tokens) and tokens[i] != "pr":
        t = tokens[i]
        if t in GH_GLOBAL_FLAGS_WITH_VALUE:
            i += 2
            continue
        if t.startswith("--repo=") or t.startswith("--hostname="):
            i += 1
            continue
        if t.startswith("-"):
            i += 1
            continue
        # A non-flag token before "pr" means this isn't `gh ... pr create`.
        return False, None
    if i >= len(tokens) or tokens[i] != "pr":
        return False, None
    i += 1
    if i >= len(tokens) or tokens[i] != "create":
        return False, None

    base_val = None
    j = i + 1
    while j < len(tokens):
        t = tokens[j]
        if t == "--base" and j + 1 < len(tokens):
            base_val = tokens[j + 1]
            j += 2
            continue
        if t.startswith("--base="):
            base_val = t.split("=", 1)[1]
            j += 1
            continue
        j += 1
    return True, base_val


def is_allowed(base_val):
    if base_val is None:
        return False
    if base_val in ALLOWED_BASES:
        return True
    return base_val.startswith(ALLOWED_BASE_PREFIXES)


def main():
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return 0  # Malformed input isn't this hook's problem; fail open.

    cmd = (payload.get("tool_input") or {}).get("command") or ""
    if not cmd:
        return 0

    try:
        tokens = tokenize(cmd)
    except ValueError:
        return 0  # Unbalanced quotes: can't safely tokenize, fail open.

    for simple in split_simple_commands(tokens):
        is_pr_create, base_val = base_value_if_pr_create(simple)
        if is_pr_create and not is_allowed(base_val):
            sys.stderr.write(
                "Blocked: 'gh pr create' must pass --base main (or "
                "--base release/x.y.z for backports).\n"
            )
            return 2

    return 0


if __name__ == "__main__":
    sys.exit(main())
