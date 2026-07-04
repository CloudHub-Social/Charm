#!/usr/bin/env python3
"""Runs oxlint against a single edited file right after Edit/Write, so lint
errors surface immediately instead of at the next manual lint/CI run.

Ported from a bash script so the same interpreter (python3) handles this
hook and check-pr-base.py consistently across platforms, instead of
depending on a POSIX shell (see check-pr-base.py's docstring for why that
mattered on Windows machines without Git Bash).

Self-gating: if oxlint isn't installed yet (the Charm 2.0 scaffold doesn't
ship it), this no-ops. It activates automatically once oxlint lands in
node_modules — no config change needed.
"""
import json
import os
import subprocess
import sys


def main():
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return 0

    file_path = (payload.get("tool_input") or {}).get("file_path") or ""
    if not file_path.endswith((".ts", ".tsx")):
        return 0

    root = os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())
    oxlint = os.path.join(root, "node_modules", ".bin", "oxlint")
    if os.name == "nt":
        oxlint += ".cmd"
    if not os.path.isfile(oxlint) or not os.access(oxlint, os.X_OK):
        return 0
    if not os.path.isfile(file_path):
        return 0

    result = subprocess.run(
        [oxlint, file_path], capture_output=True, text=True
    )
    out = (result.stdout + result.stderr).strip()
    if "No files found to lint" in out:
        return 0
    if out:
        sys.stderr.write(f"oxlint found issues in {file_path}:\n{out}\n")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
