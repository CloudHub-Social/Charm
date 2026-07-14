---
title: CI / release tiers
description: How Charm splits CI into fast PR gating, nightly platform builds, and releases.
---

:::note
This page mirrors [`docs/ci-tiers.md`](https://github.com/CloudHub-Social/Charm/blob/main/docs/ci-tiers.md)
in the repository, which is the canonical, most up-to-date copy.
:::

Charm 2.0's CI is split into tiers, each with a different job: fast feedback
on every commit vs. thorough platform coverage vs. actually shipping a
release. The full native platform matrix (macOS, Windows, Linux, iOS,
Android) is by far the most expensive part of CI, so it doesn't run on every
PR push.

## Tier 1 — PR gate

Runs on every push to an open PR. **Blocking** — lint/format/typecheck/unit
tests, Rust fmt/clippy/nextest, Storybook + axe a11y, Playwright e2e,
CodeQL, dependency audits. No native platform bundling. A path-based
`changes` job skips whole categories when nothing relevant changed.

## Tier 2 — Merge queue

Same checks as Tier 1, re-run against the synthetic tree GitHub's merge
queue builds. Last gate before a commit lands on `main`.

## Tier 3 — Nightly platform builds

Full native builds — macOS, Windows, Linux, iOS (simulator), Android — on a
daily cron plus manual dispatch, off the current tip of `main`.
**Non-blocking**: a failure opens/comments on a tracking GitHub issue rather
than gating anyone's work. Builds in release profile so the published
nightly and Sentry symbolication both reflect what actually ships.

## Tier 4 — Production release _(partially implemented)_

Triggered by pushing a version tag (`v*`). Debug-symbol/release-artifact
upload to Sentry is wired up; producing signed and notarized shipping
bundles and publishing them is designed but not yet built (needs signing
credentials not present in CI).

For the full rationale and supporting-infrastructure details (rust-cache,
sccache, the Moonrepo backlog item), see
[`docs/ci-tiers.md`](https://github.com/CloudHub-Social/Charm/blob/main/docs/ci-tiers.md)
in the repository.

## Related documentation

- [Cloudflare previews](/operations/cloudflare-previews/) explains the
  per-pull-request web deployment and smoke check.
- [Sentry observability](/operations/sentry/) covers release artifacts,
  symbols, and the full visual snapshot suite.
- [Maintaining the feature gallery](/features/maintaining/) documents the
  curated E2E evidence generated from those checks.
- [Documentation workflow](../documentation/) defines when a code change must
  update specs, runbooks, or feature evidence in the same pull request.
