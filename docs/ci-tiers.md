# CI / release tiers

Charm 2.0's CI is split into tiers, each with a different job: fast feedback
on every commit vs. thorough platform coverage vs. actually shipping a
release. This exists because the full native platform matrix (macOS,
Windows, Linux, iOS, Android) is by far the most expensive part of CI, and
running it on every PR push and every merge-queue entry was the dominant
cost driver slowing down day-to-day development — without actually being a
required check that blocks merging.

## Tier 1 — PR gate (`quality-checks.yml`, `codeql.yml`, etc.)

Runs on every push to an open PR. **Blocking** — these are the required
status checks branch protection actually enforces.

- Lint / format / typecheck / unit tests (`Frontend`)
- Rust `fmt` / `clippy` / `nextest` (`rust`, `rust-integration`,
  `rust-integration-qr`)
- Storybook + axe a11y, Playwright e2e
- CodeQL, GitGuardian, dependency audits

No native platform bundling happens here. A path-based `changes` job skips
whole categories of checks when nothing relevant changed (e.g. a Rust-only
PR skips `Frontend`/`Storybook`/`E2E`; a docs-only PR skips almost
everything).

## Tier 2 — Merge queue

Same checks as Tier 1, re-run against the synthetic tree GitHub's merge
queue builds (the PR combined with whatever else is ahead of it in the
queue). Still no native platform bundling. This is the last gate before a
commit lands on `main`.

## Tier 3 — Nightly platform builds (`nightly-platform-builds.yml`)

**Implemented.** Full native builds — macOS, Windows, Linux, iOS
(simulator), Android — on a daily cron (09:00 UTC) plus manual
`workflow_dispatch`, always off the current tip of `main`. **Non-blocking**:
a failure here never blocks a PR or the merge queue. Instead, the failing
job opens (or comments on, if one's already open) a GitHub issue titled
`Nightly build failure: <Platform>`, so drift gets tracked and triaged
without gating anyone's work.

These builds only prove "does it compile and bundle" — they don't need to
gate every commit, just catch breakage within a day.

## Tier 3.5 — Release-candidate builds _(planned, not yet built)_

The idea: when a `release/X.Y.Z` branch is cut (already a recognized PR base
per `CLAUDE.md`), run the full native matrix in **release** mode (not the
`--debug` used elsewhere) as a more rigorous pre-ship gate — this is where a
release-mode-only bug (LTO/codegen differences, bundler-specific issues)
would actually get caught before tagging. Not yet implemented; no new
credentials needed to build it, just workflow wiring.

## Tier 4 — Production release _(partially implemented)_

Triggered by pushing a version tag (`v*`). `sentry-release-artifacts.yml`
already does part of this today: uploads debug symbols / release artifacts
to Sentry for the tagged commit. The remaining piece — producing real
**signed and notarized** shipping bundles (macOS notarization, code-signing
certs, Windows Authenticode, etc.) and publishing them (GitHub Release
assets, the auto-updater feed) — is designed but not built. It needs signing
credentials that don't exist in CI yet; that's a distinct follow-up task,
not something to wire up silently.

## Supporting infrastructure

- **`Swatinem/rust-cache`** — whole-`target/`-directory caching, scoped so
  only `main` saves (every other branch restores/falls back) to avoid
  exceeding GitHub's 10GB-per-repo Actions cache cap.
- **`sccache`** — object-level (per compilation-unit) caching, backed by a
  dedicated DigitalOcean Spaces bucket (S3-compatible) rather than GitHub's
  Actions cache, so it isn't constrained by that same 10GB cap and every
  branch can freely read+write.
- Native builds in Tier 1/2 (the `rust` job) and Tier 3 (nightly) both build
  in `--debug` mode where they're pure compile-checks — release-mode
  optimization (`opt-level=3`) is expensive and buys nothing for "does it
  build."

## Future consideration — Moonrepo (Day 4)

Logged as a backlog item, not planned for the current work: **Moonrepo** is
a free/open-source, genuinely polyglot (Rust + JS/TS) build-graph tool that
could replace the hand-rolled path-diff `changes` job with proper
content-addressed task caching if the repo's shape changes (e.g. the JS side
splits into multiple real packages — today it's a single `pnpm` package with
no `packages:` list, so the added complexity isn't justified yet). Not
Turborepo/Nx (JS-only) or Bazel/Buck2 (far higher adoption cost for a team
this size) — see the raw-capture note for the full comparison.
