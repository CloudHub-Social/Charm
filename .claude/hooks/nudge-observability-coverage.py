#!/usr/bin/env python3
"""Nudges toward e2e/Sentry coverage right before `gh pr create`.

CLAUDE.md/AGENTS.md ask for Playwright e2e coverage and Sentry
breadcrumbs/logging on relevant changes (see SENTRY.md), and CI now backstops
that with the "PR checklist gate" workflow and observability-ratchet.json's
ratchet check. But an agent about to run `gh pr create` won't see either of
those until the PR is already open and CI has run — this fires at the point
of decision instead, same rationale as nudge-graphify.py.

Heuristic and non-blocking (unlike check-pr-base.py): whether a given diff
"needs" e2e or Sentry coverage is a judgment call this script can't make
reliably, so it only surfaces a reminder via additionalContext when the diff
touches likely-observable surface (components, Tauri commands, IPC handlers)
without also touching e2e/ or an obvious Sentry/tracing call site. The
underlying `gh pr create` is never blocked.
"""
import json
import re
import subprocess
import sys

OBSERVABLE_PATTERNS = [
    r"^src/components/",
    r"^src-tauri/src/.*\.rs$",
]
EXCLUDE_PATTERNS = [
    r"\.test\.tsx?$",
    r"\.spec\.tsx?$",
    r"\.stories\.tsx?$",
]
E2E_PATTERN = r"^e2e/"
SENTRY_HINT_PATTERN = (
    r"Sentry\.(captureException|captureMessage)|addBreadcrumb\(|"
    r"tracing::(info|warn|error|debug)!|sentry::|capture_event|add_breadcrumb"
)


def is_gh_pr_create(command):
    return bool(re.search(r"\bgh\s+pr\s+create\b", command))


def changed_files():
    try:
        merge_base = subprocess.run(
            ["git", "merge-base", "HEAD", "origin/main"],
            capture_output=True, text=True, timeout=10,
        ).stdout.strip()
        if not merge_base:
            return []
        out = subprocess.run(
            ["git", "diff", "--name-only", merge_base, "HEAD"],
            capture_output=True, text=True, timeout=10,
        ).stdout
        return [line for line in out.splitlines() if line.strip()]
    except (subprocess.SubprocessError, OSError):
        return []


def diff_text(paths):
    if not paths:
        return ""
    try:
        merge_base = subprocess.run(
            ["git", "merge-base", "HEAD", "origin/main"],
            capture_output=True, text=True, timeout=10,
        ).stdout.strip()
        if not merge_base:
            return ""
        out = subprocess.run(
            ["git", "diff", merge_base, "HEAD", "--", *paths],
            capture_output=True, text=True, timeout=15,
        ).stdout
        return out
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

    files = changed_files()
    if not files:
        return 0  # No merge-base / no diff: nothing to judge, fail open.

    observable = [
        f for f in files
        if any(re.search(p, f) for p in OBSERVABLE_PATTERNS)
        and not any(re.search(p, f) for p in EXCLUDE_PATTERNS)
    ]
    if not observable:
        return 0

    touches_e2e = any(re.search(E2E_PATTERN, f) for f in files)
    touches_sentry = bool(re.search(SENTRY_HINT_PATTERN, diff_text(observable)))

    missing = []
    if not touches_e2e:
        missing.append("no e2e/*.spec.ts changes")
    if not touches_sentry:
        missing.append("no Sentry/tracing call sites in the changed diff")

    if not missing:
        return 0

    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": (
                "This PR touches components/Tauri code "
                f"({', '.join(observable[:5])}"
                f"{'...' if len(observable) > 5 else ''}) but " +
                " and ".join(missing) + ". If this change has an "
                "observable user-facing or error path, add Playwright e2e "
                "coverage and/or Sentry breadcrumbs/logging (see SENTRY.md) "
                "before opening the PR — the 'PR checklist gate' CI check "
                "will otherwise require you to check the box or write an "
                "N/A explanation in the PR body. If neither genuinely "
                "applies here, proceed and explain why in the checklist."
            ),
        }
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
