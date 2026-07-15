---
title: "Charm 2.0 Spec — Build and release identification (short SHA, PR previews)"
type: spec
project: "Charm 2.0"
created: "2026-07-10"
status: shipped
sidebar:
  label: "Build and release identification"
---

## Implementation status

**Shipped in [PR #166](https://github.com/CloudHub-Social/Charm/pull/166), with
follow-up fixes in [PR #182](https://github.com/CloudHub-Social/Charm/pull/182)
and [PR #184](https://github.com/CloudHub-Social/Charm/pull/184).** The shared
build-ID script now produces commit, PR-preview, and nightly identifiers; workflows
pass the same identifier to the app and Sentry, and Settings exposes it for copy.

:::note[Historical baseline]
The “Current state” section below describes the fragmented pre-implementation
release naming found on 2026-07-10.
:::

**Workstream:** single PR. **Tier:** fast-follow to [Spec 21 — Sentry observability](/specs/day-1/spec-21--sentry-observability-error-monitoring-tracing-replay-logs/) (owner request, 2026-07-10).

## Problem & why now

There's no single, consistent, user- and reporter-visible identifier for "which
exact build is this." `AboutPanel.tsx` shows only `packageJson.version` (e.g.
`0.4.2`) — the same string for every commit between version bumps, so a bug
report referencing "version 0.4.2" is ambiguous across dozens of commits,
several nightly builds, and any number of PR previews. This directly limits
[Spec 22 — User feedback categorization and GitHub label mapping](/specs/day-1/spec-22--user-feedback-categorization-and-github-label-mapping/) and
[Spec 23 — User feedback client context capture](/specs/day-1/spec-23--user-feedback-client-context-capture/), both of which want a
build identifier to attach to feedback/error reports.

## Current state (verified 2026-07-10)

Partial infrastructure already exists, scattered and inconsistent:

- **Sentry release naming already has SHA fallback**, but only for Sentry's
  own release/sourcemap bookkeeping, not surfaced anywhere in-app:
  - `.github/workflows/sentry-release-artifacts.yml` — triggered on `v*` tags
    or manual dispatch; release name defaults to "the tag name or commit SHA"
    per its own `workflow_dispatch` input description (confirm exact
    fallback logic in the script referenced around its "Configure Sentry
    release upload" step before assuming full vs. short SHA).
  - `.github/workflows/web-deploy-dev.yml` — comment states `RELEASE_INPUT`
    "is left unset so it defaults to GITHUB_SHA — unique per dev deploy,"
    reusing the same script as the tagged-release workflow. This is the
    **full** 40-char SHA per `GITHUB_SHA`'s standard GitHub Actions value,
    not a short SHA — inconsistent with the owner's "short-sha" ask.
  - `vite.config.ts:41` — `release: { name: procEnv.SENTRY_RELEASE ||
    procEnv.npm_package_version }` — this is the Sentry SDK's own release
    tag, set at JS build time, independent of the CI workflows above unless
    they also set `SENTRY_RELEASE` as an env var reaching this build step
    (verify whether they do — if not, local/CI JS builds fall through to
    `npm_package_version` regardless of what the CI release workflows
    compute for Sentry's server-side release object).
  - `src-tauri/src/lib.rs:179` — `sentry::release_name!()` — Cargo-version-
    derived, no SHA involvement at all on the Rust side.
- **PR preview builds already know their PR number**: `web-preview.yml` reads
  `github.event.pull_request.number` into `PR_NUMBER` and posts/updates a PR
  comment — but this is CI-workflow-local; it isn't baked into the built
  artifact itself or exposed in-app.
- **Nightly builds** (`nightly-platform-builds.yml`) run on a schedule against
  a commit but have no visible "this is the nightly from commit X" marker
  either in the workflow's own naming or in the built app.
- **No single source of truth.** Each workflow computes its own notion of
  "release," inconsistently (full SHA in one place, tag-or-SHA in another,
  package version elsewhere), and none of it reaches `AboutPanel.tsx` or any
  other in-app surface.

**Re-verified 2026-07-10 (later same day)**:
- `configure-sentry-release-env.sh` (the shared script) is already called by
  **both** `sentry-release-artifacts.yml` (tagged releases) and
  `web-deploy-dev.yml` (main pushes) with `WRITE_FRONTEND_UPLOAD_ENV: "true"`,
  writing `VITE_SENTRY_RELEASE` (full `GITHUB_SHA` for non-tag runs, tag name
  for tag runs) — this *is* the single-source-of-truth script the design
  section proposes; it just isn't called from the other two workflows yet
  and doesn't compute a short SHA or the `+pr{n}.{sha}`/`+nightly.{sha}`
  suffixes.
- `web-preview.yml` **deliberately does not** call it (confirmed via its own
  comment at line 148) — PR previews don't upload sourcemaps or create a
  Sentry release today, consistent with this spec's premise that preview
  builds have no build-identifier story at all yet.
- `nightly-platform-builds.yml` has **zero** Sentry/release wiring of any
  kind currently — confirmed via grep, not just "no visible marker."
- Net effect: the "single reusable script" this spec calls for **already
  exists and is already shared by 2 of 4 workflows** — this spec is really
  "extend the existing script to (a) shorten the SHA, (b) add PR/nightly
  suffixes, (c) call it from the 2 workflows that don't yet, (d) surface the
  result in-app," not a from-scratch build. Scope down accordingly when this
  gets picked up — item 1 in [Scope summary](#scope-in--summary) should read "extend"
  rather than "create."

## Non-goals

- **A full build-provenance/supply-chain-attestation system** (SLSA, sigstore,
  etc.) — this is a human-readable "which build is this" identifier, not a
  cryptographic provenance chain.
- **Changing Sentry's `release` field semantics** — Sentry's own release
  bookkeeping (used for symbolication, Release Health) stays as-is; this spec
  adds a separate, simpler, always-present *display* identifier that happens
  to often overlap with the same commit.
- **Renumbering or changing the versioning scheme** (`package.json`/
  `Cargo.toml` semver) — the short SHA is additive context alongside the
  existing version number, not a replacement for semver.
- **Backfilling identifiers into already-shipped builds** — applies going
  forward only.

## Design & approach

### Canonical build identifier format

`{version}+{short_sha}` for ordinary commits (e.g. `0.4.2+a1b2c3d`),
`{version}+pr{number}.{short_sha}` for PR previews (e.g.
`0.4.2+pr187.a1b2c3d`), `{version}+nightly.{short_sha}` for scheduled nightly
builds. Short SHA = first 7 characters of `GITHUB_SHA` (or
`github.event.pull_request.head.sha` for PR builds, which is the actual head
commit being previewed — not the merge-ref SHA `GITHUB_SHA` resolves to on
`pull_request` events; this distinction matters and should be verified against
current GitHub Actions docs before implementation, since using the wrong SHA
here would label the preview with a synthetic merge commit instead of the
commit the PR actually contains). This mirrors Cargo/semver's own build-
metadata convention (`+` suffix, ignored in version comparisons) so it doesn't
fight either ecosystem's version-parsing expectations.

### Single source of truth

Compute this string **once**, in one reusable place, and thread it through
every consumer rather than letting each workflow/build script recompute its
own variant (root cause of today's inconsistency):

- A small script (e.g. `scripts/compute-build-id.sh` or a `justfile`/npm
  script — match whatever tooling convention the repo already uses for
  cross-workflow shared scripts, check `scripts/` for precedent) takes
  `GITHUB_SHA`, `GITHUB_EVENT_NAME`, `GITHUB_REF`, and PR context as input,
  outputs the canonical string above, and is called identically from
  `sentry-release-artifacts.yml`, `web-deploy-dev.yml`, `web-preview.yml`,
  and `nightly-platform-builds.yml`.
- The computed value is exposed to:
  - **JS build**: as `VITE_BUILD_ID` (or reuse `SENTRY_RELEASE` if it's
    decided the Sentry release string and the display build ID should be
    identical — **open question, engineering**: unifying them is simpler but
    means Sentry's release-based features, e.g. Release Health, get a
    slightly noisier release list for every PR preview/nightly; keeping them
    separate is more flexible but is two things to keep in sync. Recommend
    unifying unless Release Health data quality across many ephemeral PR
    preview "releases" proves to be a problem in practice).
  - **Rust build**: as a `CARGO_ENV`-style build-time constant (e.g. via
    `build.rs` reading the same env var Cargo/Tauri's build step receives, or
    a `.env`-style file the CI step writes before `cargo build` — confirm
    the least-friction mechanism against how `sentry::release_name!()`
    already gets its value, since that's already solved once for a similar
    problem in this exact file).

### In-app display

`AboutPanel.tsx` shows the version line as today, plus a second line: the
computed build identifier (e.g. `Build: a1b2c3d` or the full canonical string
if the version is otherwise ambiguous — favor showing just the short SHA
alone if the version number above it already covers the semver part, to avoid
a visually redundant long string). Make the value tappable/selectable so a
user reporting a bug can copy it into the feedback form or an issue.

## Scope (in) — summary

1. `scripts/compute-build-id.sh` (or equivalent), producing the canonical
   format above, called identically from all four CI workflows in
   [Current state](#current-state).
2. `VITE_BUILD_ID` (or unified with `SENTRY_RELEASE`, per the open question
   above) wired into `vite.config.ts` and read at runtime for display.
3. Rust-side equivalent constant, following whatever mechanism
   `sentry::release_name!()` already uses as precedent.
4. `AboutPanel.tsx` — new "Build" row, copyable value.
5. `charm.build.id` tag wired into Sentry init (both JS and Rust) so error/
   feedback events carry it — this is what
   [Spec 23 — User feedback client context capture](/specs/day-1/spec-23--user-feedback-client-context-capture/) consumes.
6. Update `web-deploy-dev.yml`/`web-preview.yml`/`nightly-platform-builds.yml`/
   `sentry-release-artifacts.yml` to call the shared script instead of each
   computing their own value, fixing the full-SHA-vs-short-SHA inconsistency
   noted in [Current state](#current-state).

## Acceptance criteria

1. A build produced by each of the four workflows (regular main push, PR
   preview, nightly, tagged release) exposes a build identifier matching the
   canonical format in [Canonical build identifier format](#canonical-build-identifier-format), verifiable by
   inspecting the built artifact's `AboutPanel` (or, for CI-only checks, the
   env var/constant the build step injected).
2. `AboutPanel.tsx` displays and allows copying the build identifier.
3. A representative Sentry event (error or feedback) from a test build
   carries `charm.build.id` matching what `AboutPanel` shows for that same
   build.
4. All four workflows use the single shared script — no duplicated
   SHA-computation logic remains inline in more than one workflow file
   (grep-verifiable).
5. `pnpm lint`, `pnpm fmt:check`, `pnpm typecheck`, `pnpm test:coverage`,
   `pnpm knip`, `pnpm build`, `cargo fmt --check`, `cargo clippy -D warnings`,
   `cargo test` all pass per `CLAUDE.md`'s quality gate.

## Dependencies & sequencing

- Independent of Spec 22; **Spec 23 depends on this spec** for `charm.build.id`
  (see [Spec 23 — User feedback client context capture](/specs/day-1/spec-23--user-feedback-client-context-capture/)'s dependencies) —
  land this one first if sequencing matters.
- No file overlap with Spec 21's remaining phases (build distribution/CI
  work in Spec 21 Phase 3 touches the same workflow files though — check
  Phase 3's status before starting, to avoid two specs editing
  `sentry-release-artifacts.yml` concurrently in conflicting ways).

## Effort estimate

**S–M.** Mostly CI-script consolidation and one new `AboutPanel` row; the
main real unknown is the PR-preview head-SHA-vs-merge-SHA distinction and
confirming the least-friction way to inject a build-time constant into the
Rust/Tauri build (mirroring the existing `release_name!()` precedent should
make this low-risk).
