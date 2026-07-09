#!/usr/bin/env python3
"""Nudges toward graphify for broad/architecture-shaped searches.

CLAUDE.md already asks agents to prefer `graphify query`/`explain`/`path` over
an open-ended grep/Explore sweep for "how does X work" / "what calls Y" /
cross-file questions, but that's a soft instruction easy to forget mid-task.
This surfaces it right at the point of decision instead: fires just before a
Bash grep-family command or an unscoped Grep tool call, and — only when a
graphify graph actually exists to fall back on — attaches a suggestion via
additionalContext. It never blocks or denies; a narrow, deliberate grep for an
exact string/symbol should proceed exactly as asked (CLAUDE.md's own stated
exception), this just makes the faster option visible alongside it.

Deduplicated per session (one nudge per session, not one per matching call) so
it reads as a single tip rather than nagging on every subsequent grep.
"""
import json
import os
import re
import sys
import tempfile

# Recursive/whole-repo search patterns, not a narrow single-file/line lookup.
BROAD_BASH_PATTERNS = [
    r"\bgrep\b[^|;&]*(-r|-R|--recursive)\b",
    r"\bgit\s+grep\b",
    r"\brg\b(?!\s+--files\b)",  # ripgrep is recursive by default
]


def is_broad_bash(command):
    return any(re.search(p, command) for p in BROAD_BASH_PATTERNS)


def is_broad_grep_tool(tool_input):
    path = (tool_input.get("path") or "").strip()
    return path in ("", ".", "./")


def already_nudged(session_id):
    if not session_id:
        return False
    marker = os.path.join(tempfile.gettempdir(), f"charm-graphify-nudge-{session_id}")
    if os.path.exists(marker):
        return True
    try:
        open(marker, "w").close()
    except OSError:
        pass
    return False


def main():
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return 0

    root = os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())
    if not os.path.isfile(os.path.join(root, "graphify-out", "graph.json")):
        return 0

    tool_name = payload.get("tool_name") or ""
    tool_input = payload.get("tool_input") or {}

    triggered = False
    if tool_name == "Bash":
        triggered = is_broad_bash(tool_input.get("command") or "")
    elif tool_name == "Grep":
        triggered = is_broad_grep_tool(tool_input)

    if not triggered or already_nudged(payload.get("session_id")):
        return 0

    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "additionalContext": (
                "This repo has a graphify graph (graphify-out/). For "
                "architecture/cross-file questions ('how does X work', "
                "'what calls Y', tracing relationships) `graphify query "
                "\"<question>\"`, `graphify explain \"<Symbol>\"`, or "
                "`graphify path \"<A>\" \"<B>\"` is faster and more precise "
                "than a broad grep sweep. Narrow exact-string/symbol lookups "
                "are still fine as grep."
            ),
        }
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
