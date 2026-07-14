---
name: upstream-import-audit
description: Audit provenance, licensing, maintenance, dependencies, vulnerabilities, and architectural fit before adapting upstream code into Charm. Use whenever code, assets, queries, workflows, or substantial design patterns may be copied from another repository.
---

# Upstream import audit

1. Record the source repository, immutable commit, relevant files, retrieval date, and proposed use.
2. Verify the license at that commit, file-level notices, attribution, generated-code status, and compatibility with Charm. Escalate unclear licensing.
3. Review release cadence, recent activity, maintainer status, open security issues, advisories, and abandonment signals.
4. Inspect direct and transitive dependencies, build scripts, generated artifacts, network behavior, and platform assumptions.
5. Compare the source architecture with Charm's typed Tauri IPC, `matrix-rust-sdk`, feature flags, platform targets, privacy model, and quality gates.
6. Search for known vulnerabilities and relevant security fixes after the selected commit.
7. Produce an adaptation plan that identifies what to reuse, rewrite, test, attribute, and reject.

Do not copy code during the audit. Do not rely on the default branch name as provenance. Preserve source links and exact commits in the eventual PR and project-note proposal.

Output: provenance table, license conclusion, maintenance and advisory assessment, dependency deltas, architectural mismatches, security/privacy risks, adaptation steps, required tests, attribution text, and unresolved questions.
