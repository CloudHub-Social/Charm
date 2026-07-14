---
name: ci-failure-investigation
description: Diagnose Charm GitHub Actions failures using the exact workflow, job, step, commit, platform, logs, and last successful comparison. Use for failing, flaky, cancelled, queued, or environment-specific CI checks before implementing a fix.
---

# CI failure investigation

1. Read the live PR, head SHA, required checks, workflow run, job, failed step, annotations, and relevant logs. Re-query after new pushes.
2. Confirm whether the failure belongs to the current head, a merge-group commit, or an obsolete run.
3. Compare the failing run with the last successful run for the same workflow, branch, platform, toolchain, cache, and relevant files.
4. Classify the failure as deterministic code, deterministic configuration, dependency or advisory drift, environment or service outage, resource exhaustion, cancellation, race, or suspected flake.
5. Reproduce locally or in the narrowest equivalent environment when practical. Preserve exact error text and versions without secrets.
6. Identify the smallest evidence-supported cause and remediation. Implement only when requested or clearly within the task.
7. Run the affected check and the repository-required gate. Do not disable tests, weaken assertions, lower coverage, add unconditional ignores, or convert failures to success.

Report: run and commit, failing job and step, first relevant error, classification and confidence, comparison evidence, reproduction result, root cause, proposed or applied fix, validation, and remaining risk.
