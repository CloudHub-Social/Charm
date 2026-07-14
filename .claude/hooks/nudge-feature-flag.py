#!/usr/bin/env python3
"""Nudges toward feature-flag gating right before `gh pr create`.

CLAUDE.md/AGENTS.md ask that new user-facing features ship behind a feature
flag (see docs/FEATURE_FLAGS.md), and CI backstops that with the "PR checklist
gate" workflow. But an agent about to run `gh pr create` won't see the gate
until the PR is already open and CI has run — this fires at the point of
decision instead, same rationale as nudge-observability-coverage.py.

Heuristic and non-blocking (unlike check-pr-base.py): whether a diff is "a new
feature" is a judgment call this script can't make reliably, so it only
surfaces a reminder when the diff *adds* a new feature-surface file
(src/features/… or a new Tauri command area) without also touching the flag
catalog or evaluating a flag. Bug fixes, docs, refactors, and anything that
already wires a flag won't trip it. The underlying `gh pr create` is never
blocked — if a flag genuinely doesn't apply, proceed and mark the checklist
line `N/A: <reason>` (or apply the `internal` label).
"""
import json
import re
import subprocess
import sys

# Added files under these paths read as "new feature surface".
FEATURE_SURFACE_PATTERNS = [
    r"^src/features/.*\.tsx?$",
]
EXCLUDE_PATTERNS = [
    r"\.test\.tsx?$",
    r"\.spec\.tsx?$",
    r"\.stories\.tsx?$",
    r"/index\.tsx?$",
]
# Any of these in the diff means a flag is already in play — don't nudge.
FLAG_TOUCH_PATTERNS = [
    r"src/featureFlags/",
    r"feature_flags\.rs",
    r"src/bindings/FeatureFlagKey",
]
FLAG_USAGE_HINT = (
    r"\buseFlag\(|\bgetFlag\(|feature_flags::(flag|evaluate)\b|FeatureFlagKey\b"
)


def is_gh_pr_create(command):
    return bool(re.search(r"\bgh\s+pr\s+create\b", command))


def merge_base():
    try:
        out = subprocess.run(
            ["git", "merge-base", "HEAD", "origin/main"],
            capture_output=True, text=True, timeout=10,
        ).stdout.strip()
        return out or None
    except (subprocess.SubprocessError, OSError):
        return None


def added_and_changed_files(base):
    """Returns (added_files, all_changed_files) between base and HEAD."""
    try:
        out = subprocess.run(
            ["git", "diff", "--name-status", base, "HEAD"],
            capture_output=True, text=True, timeout=10,
        ).stdout
    except (subprocess.SubprocessError, OSError):
        return [], []
    added, changed = [], []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        status, path = parts[0], parts[-1]
        changed.append(path)
        if status.startswith("A"):
            added.append(path)
    return added, changed


def diff_text(base, paths):
    if not paths:
        return ""
    try:
        return subprocess.run(
            ["git", "diff", base, "HEAD", "--", *paths],
            capture_output=True, text=True, timeout=15,
        ).stdout
    except (subprocess.SubprocessError, OSError):
        return ""


def main():
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return 0

    cmd = (payload.get("tool_input") or {}).get("command") or ""
    if not is_gh_pr_create(cmd):
        return 0

    base = merge_base()
    if not base:
        return 0  # No merge-base: nothing to judge, fail open.

    added, changed = added_and_changed_files(base)
    if not changed:
        return 0

    new_feature_files = [
        f for f in added
        if any(re.search(p, f) for p in FEATURE_SURFACE_PATTERNS)
        and not any(re.search(p, f) for p in EXCLUDE_PATTERNS)
    ]
    if not new_feature_files:
        return 0

    touches_flag = any(
        re.search(p, f) for f in changed for p in FLAG_TOUCH_PATTERNS
    ) or bool(re.search(FLAG_USAGE_HINT, diff_text(base, changed)))
    if touches_flag:
        return 0

    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": (
                "This PR adds new feature surface "
                f"({', '.join(new_feature_files[:5])}"
                f"{'...' if len(new_feature_files) > 5 else ''}) but doesn't "
                "gate it behind a feature flag or evaluate one. New "
                "user-facing features should ship behind a flag defaulting "
                "off (see docs/FEATURE_FLAGS.md): add the key to the Rust "
                "catalog (src-tauri/src/feature_flags.rs) and "
                "src/featureFlags/catalog.ts, then gate the feature on "
                "useFlag()/getFlag()/feature_flags::flag(). The 'PR checklist "
                "gate' CI check will otherwise require you to check the "
                "feature-flag box or write an 'N/A: <reason>' in the PR body "
                "(or apply the `internal` label on a docs/internal PR)."
            ),
        }
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
