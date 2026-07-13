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

`quality-checks.yml` also runs on a daily schedule (08:00 UTC, an hour ahead
of Tier 3's nightly cron) against the current tip of main, unconditionally
running every gated check (same as `workflow_dispatch` — there's no diff
base for a schedule trigger). Two reasons: it catches drift a gated/skipped
check on the last merged PR could have missed (e.g. a freshly published
`cargo audit` advisory, or a toolchain/environment change with no
corresponding diff), and it keeps sccache/Swatinem rust-cache/Playwright
browser caches warm daily instead of only whenever someone happens to push
to main. Non-blocking on this trigger (no PR exists to gate) — a failure
instead opens/comments a tracking GitHub issue, same pattern as Tier 3.

## Tier 2 — Merge queue

Same checks as Tier 1, re-run against the synthetic tree GitHub's merge
queue builds (the PR combined with whatever else is ahead of it in the
queue). Still no native platform bundling. This is the last gate before a
commit lands on `main`.

## Tier 3 — Nightly platform builds (`nightly.yml`)

**Implemented.** Full native builds — macOS, Windows, Linux, iOS
(simulator), Android — on a daily cron (09:00 UTC) plus manual
`workflow_dispatch`, always off the current tip of `main`. **Non-blocking**:
a failure here never blocks a PR or the merge queue. Instead, the failing
job opens (or comments on, if one's already open) a GitHub issue titled
`Nightly build failure: <Platform>`, so drift gets tracked and triaged
without gating anyone's work.

Builds in **release** profile (not `--debug`) — this used to be split into a
fast `--debug` workflow and a separate release-mode one, but that split
didn't hold up: the installable nightly this workflow publishes
(`publish-nightly`) is meant to represent what actually ships, so handing
testers a `--debug` binary was actively counterproductive (different perf,
different codegen, compiled-out `debug_assert!`s can mask or introduce
different bugs than release does). Release mode also means the Sentry
debug-symbol upload after each build (same pattern as `release-builds.yml`)
actually matches what a real crash report would need to symbolicate, so
Sentry's nightly symbolication baseline stays fresh between tagged releases
too. The CI-cost tradeoff (release compiles slower, and the deb/rpm
bundler's intermittent hang is more likely to bite here) is accepted since
Tier 1/2 already catch plain compile errors — this only needs to catch
native-bundler and release-mode-specific breakage, and there's no strong
reason that needs to be fast.

## Tier 4 — Production release _(partially implemented)_

Triggered by pushing a version tag (`v*`). `release-builds.yml`
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
- Native builds in Tier 1/2 (the `rust` job) build in `--debug` mode where
  they're pure compile-checks — release-mode optimization (`opt-level=3`) is
  expensive and buys nothing for "does it build." Tier 3 and Tier 4 build in
  release mode deliberately, to catch release-mode-only failures and to
  produce artifacts (installable nightly, Sentry symbols) that actually
  represent what ships.

## Future consideration — Moonrepo (Day 4)

Logged as a backlog item, not planned for the current work: **Moonrepo** is
a free/open-source, genuinely polyglot (Rust + JS/TS) build-graph tool that
could replace the hand-rolled path-diff `changes` job with proper
content-addressed task caching if the repo's shape changes (e.g. the JS side
splits into multiple real packages — today it's a single `pnpm` package with
no `packages:` list, so the added complexity isn't justified yet). Not
Turborepo/Nx (JS-only) or Bazel/Buck2 (far higher adoption cost for a team
this size) — see the raw-capture note for the full comparison.
