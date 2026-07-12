# Sentry End-to-End Operational Checklist

Use this checklist to decide when Spec 21 can be called production-operational.
Do not mark an item pass without filling `Evidence` with a URL, timestamp, run
id, Sentry issue id, release id, screenshot, or exact command output.

Repo base reviewed: `origin/main`. Source reviewed: `SENTRY.md`, `PRIVACY.md`,
Sentry workflows, Sentry runtime/config references, GitHub secrets/variables,
Sentry-related merged PRs, and Sentry workflow run history. A standalone
`Spec 21` planning note was not found by filename in the repo or Charm vault;
`SENTRY.md` is the current repo source of truth for Spec 21 phasing.

## Current Repo Evidence

- Sentry docs: `SENTRY.md`, `PRIVACY.md`.
- Release workflow: `.github/workflows/sentry-release-artifacts.yml`.
- Snapshot workflow: `.github/workflows/sentry-snapshots.yml`.
- Release env helper: `.github/scripts/configure-sentry-release-env.sh`.
- Frontend runtime: `src/observability/instrument.ts`.
- Settings/consent UI: `src/features/settings/ObservabilityPanel.tsx`.
- Rust runtime: `src-tauri/src/lib.rs`.
- Android runtime/artifacts: `src-tauri/gen/android/app/build.gradle.kts`,
  `src-tauri/gen/android/app/src/main/java/social/cloudhub/charm/CharmApplication.kt`.
- GitHub workflow state: `Sentry release artifacts`, `Sentry Snapshots`, and
  `Review gate` are active.
- GitHub secrets present by name: `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`,
  `SENTRY_PROJECT`, `VITE_SENTRY_DSN`.
- GitHub variable present: `SENTRY_SNAPSHOTS_ENABLED=true`.
- Recent Sentry Snapshots runs on `main`/PRs are green; no `Sentry release
  artifacts` runs were found in the latest `gh run list` result.

## Owner-Side Setup

- [ ] **Sentry org/project exists**
  - Status:
  - Evidence:
  - Action: In Sentry, confirm the production org/project for Charm 2.0.
  - Expected: org slug equals GitHub `SENTRY_ORG`; project slug equals GitHub
    `SENTRY_PROJECT`.

- [ ] **DSN values are correct**
  - Status:
  - Evidence:
  - Action: In Sentry Project Settings -> Client Keys, compare the public DSN
    with GitHub `VITE_SENTRY_DSN`.
  - Expected: the DSN targets the same Charm 2.0 project used by artifact
    uploads; native Android currently receives this DSN as `SENTRY_DSN` in the
    release artifact workflow.

- [ ] **Auth token can upload all artifact types**
  - Status:
  - Evidence:
  - Action: Confirm `SENTRY_AUTH_TOKEN` has release/artifact upload permission
    for the configured org/project.
  - Expected: sourcemap, debug-file, snapshot, and Android build-size uploads
    do not fail with auth, org, project, or permission errors.

- [ ] **Seer is enabled**
  - Status:
  - Evidence:
  - Action: In Sentry, enable Seer for the Charm project. Separately confirm
    GitHub's `Seer Code Review` check appears on PR head commits.
  - Expected: Sentry issues can receive Seer analysis/triage; GitHub review
    gate can observe a completed `Seer Code Review` check.

- [ ] **Dashboards, alerts, and ownership are configured or declared N/A**
  - Status:
  - Evidence:
  - Action: Configure or explicitly skip Sentry dashboards/alerts for release
    health, error volume, replay/feedback, artifact upload failures, Android
    ANRs, and high-risk tags. Configure ownership/routing rules if used.
  - Expected: test issue/event routes to the intended owner/channel, or this
    is recorded as not applicable for the current production stage.

## GitHub Repository Settings

- [ ] **Required Actions secrets exist**
  - Status:
  - Evidence:
  - Action: Run `gh secret list -R CloudHub-Social/Charm`.
  - Expected: `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`,
    `VITE_SENTRY_DSN` are present.

- [ ] **Required Actions variable exists**
  - Status:
  - Evidence:
  - Action: Run `gh variable list -R CloudHub-Social/Charm`.
  - Expected: `SENTRY_SNAPSHOTS_ENABLED` is `true`.

- [ ] **Secret values match Sentry**
  - Status:
  - Evidence:
  - Action: Owner checks GitHub Settings -> Secrets and variables -> Actions.
  - Expected: values point to one Charm 2.0 Sentry org/project; stale Sable or
    Charm 1.0 values are not used.

## Release Artifact Workflow

- [ ] **Manual smoke release workflow succeeds**
  - Status:
  - Evidence:
  - Action: GitHub Actions -> Sentry release artifacts -> Run workflow with
    `release=ops-sentry-smoke-YYYYMMDD` and `environment=production`.
  - Expected: all jobs pass: frontend sourcemaps, Linux/macOS/Windows debug
    files, Apple simulator debug files, Android mapping/native symbols,
    GitHub size reports, and Android Sentry size upload.

- [ ] **Tag release workflow succeeds**
  - Status:
  - Evidence:
  - Action: Confirm the next `v*` tag run of `Sentry release artifacts`.
  - Expected: release defaults to the tag name; environment defaults to
    `production`; artifacts upload against the tag release.

- [ ] **Frontend sourcemaps upload and are not shipped**
  - Status:
  - Evidence:
  - Action: Inspect workflow logs for `Build and upload frontend sourcemaps`
    and `Verify sourcemaps are not left in dist`.
  - Expected: Sentry upload succeeds; `dist` contains no `.map` files.

- [ ] **Native debug files upload**
  - Status:
  - Evidence:
  - Action: Inspect Linux/macOS/Windows/Apple upload logs and Sentry Project
    Settings -> Debug Files.
  - Expected: debug files for the smoke release exist and processing finishes.

- [ ] **Android mappings, native symbols, and size analysis upload**
  - Status:
  - Evidence:
  - Action: Inspect Android workflow logs, Sentry Debug Files, and Sentry Size
    Analysis for the selected APK/AAB.
  - Expected: mapping/native symbols process successfully; Android build upload
    appears with the expected base SHA.

## Symbolication Verification

- [ ] **Frontend sourcemap symbolication works**
  - Status:
  - Evidence:
  - Action: Run a Sentry-enabled production build for the same smoke release,
    opt in, trigger a controlled JS error from a non-sensitive test path.
  - Expected: Sentry stack trace resolves to original TypeScript/React source,
    not minified bundle offsets.

- [ ] **Rust/desktop symbolication works**
  - Status:
  - Evidence:
  - Action: With the same release id, opt in and trigger a controlled native
    Rust event/panic in a non-sensitive test build.
  - Expected: stack trace resolves through uploaded debug files.

- [ ] **Android JVM mapping/symbolication works**
  - Status:
  - Evidence:
  - Action: With an Android release build, opt in and trigger a controlled JVM
    test event/crash or ANR path.
  - Expected: Java/Kotlin frames are deobfuscated; Sentry event carries the
    expected release/environment.

- [ ] **Apple debug symbolication works for current scope**
  - Status:
  - Evidence:
  - Action: Trigger a controlled macOS/iOS-simulator event for the smoke
    release if runtime coverage exists for that platform.
  - Expected: frames are symbolicated. Signed iOS device-release dSYMs remain
    outside current Spec 21 scope until a signed device archive/IPA pipeline
    exists.

## Runtime Event Verification

- [ ] **Fresh install sends no Sentry data**
  - Status:
  - Evidence:
  - Action: Start clean app profile with DSN configured and all toggles off.
  - Expected: no errors, traces, sessions, logs, replays, breadcrumbs,
    screenshots, or feedback are sent.

- [ ] **Primary opt-in sends baseline events only**
  - Status:
  - Evidence:
  - Action: Enable Error monitoring only; trigger controlled JS and native
    events.
  - Expected: redacted errors/traces/sessions/breadcrumbs appear; no replay,
    profiling, logs, or feedback unless separately enabled/used.

- [ ] **Replay is consent-gated and masked**
  - Status:
  - Evidence:
  - Action: Enable replay; trigger an error after viewing synthetic
    Matrix-looking room content.
  - Expected: replay appears only after opt-in; text, inputs, and media are
    masked/blocked.

- [ ] **Structured frontend and Rust logs are consent-gated and scrubbed**
  - Status:
  - Evidence:
  - Action: Enable Structured logs; trigger warning/error logs containing
    synthetic Matrix IDs and fake secret fields.
  - Expected: logs appear only after log opt-in; IDs/secrets are redacted.

- [ ] **Profiling is consent-gated**
  - Status:
  - Evidence:
  - Action: Enable Profiling and run a controlled traced interaction.
  - Expected: profiles attach to traces only when profiling is enabled.

- [ ] **Manual user feedback works**
  - Status:
  - Evidence:
  - Action: Enable Error monitoring, open Settings -> Observability -> Send
    feedback, submit a test report.
  - Expected: Sentry User Feedback item appears with `charm.feedback.surface`
    tag and optional screenshot metadata only if the user chose screenshot.

- [ ] **Crash fallback feedback works**
  - Status:
  - Evidence:
  - Action: Trigger a controlled React error boundary path after opt-in and use
    the fallback feedback entry point.
  - Expected: feedback links to the expected event context when available.

## Visual Snapshot Verification

- [ ] **Main baseline snapshots upload**
  - Status:
  - Evidence:
  - Action: Confirm the latest `Sentry Snapshots` run on `main`.
  - Expected: Storybook `charm-storybook` and e2e `charm-e2e` snapshots upload
    successfully; no missing-base warning remains.

- [ ] **PR snapshot diffs work**
  - Status:
  - Evidence:
  - Action: Open or reuse a harmless UI PR that captures snapshots.
  - Expected: PR snapshots upload, compare against the matching `main`
    baseline, and upload failure is visible in the step summary.

## Privacy and Consent Verification

- [ ] **Docs match shipped behavior**
  - Status:
  - Evidence:
  - Action: Compare `PRIVACY.md`, `SENTRY.md`, and the live Observability UI.
  - Expected: docs list exactly what can be sent, what screenshots can expose,
    and how opt-out behaves per platform.

- [ ] **Anonymous identity only**
  - Status:
  - Evidence:
  - Action: Inspect Sentry event user context from test events.
  - Expected: random local id only; no Matrix ID, display name, or email.

- [ ] **Scrubbing holds across categories**
  - Status:
  - Evidence:
  - Action: Trigger test error/log/breadcrumb/transaction/feedback values with
    synthetic `@user:example.org`, `!room:example.org`, `$event:example.org`,
    `#alias:example.org`, `mxc://example.org/media`, and fake secret fields.
  - Expected: every text/JSON category is redacted. Screenshot pixels are not
    scrubbed; user-facing warning and optional screenshot choice must be visible.

- [ ] **Opt-out stops frontend Sentry in-session**
  - Status:
  - Evidence:
  - Action: Enable Sentry, generate a test event, turn off Error monitoring,
    then generate another controlled frontend event.
  - Expected: post-opt-out frontend event is not sent; feedback dialog is
    removed/disabled.

- [ ] **Native opt-out semantics match docs**
  - Status:
  - Evidence:
  - Action: On desktop and Android, opt out after initialization and trigger
    controlled native/log events.
  - Expected: behavior matches `SENTRY.md`/`PRIVACY.md`: desktop native crash
    monitoring fully applies after restart; Android same-session callback gates
    prevent new accepted events, with already queued SDK events documented.

## Repo PR vs Owner-Side Split

Owner-side only unless verification fails:

- Sentry org/project creation and slug confirmation.
- Secret value verification and token permissions.
- Seer enablement.
- Sentry dashboards, alerts, ownership/routing.
- Manual workflow dispatch and Sentry UI artifact/symbolication checks.
- Production smoke events, replay, feedback, privacy, and consent evidence.

Repo PR required only if a checklist item fails because repo behavior is wrong:

- Missing or mismatched workflow secret/variable references.
- Release artifact workflow fails for a repo-controlled reason.
- Sourcemaps/debug files/uploaded build artifacts do not match release ids.
- Runtime events bypass consent, fail scrubbing, or use non-anonymous identity.
- Feedback/replay/log/profiling toggles do not match docs.
- Snapshot uploads no longer create comparable baselines/diffs.
- Docs differ from actual shipped behavior.

Known explicit non-blockers for the current Spec 21 declaration if documented:

- Signed iOS device-release dSYMs wait for a signed device archive/IPA pipeline.
- Android NDK/native crash capture, Mobile Vitals, and performance transactions
  wait for the corresponding SDK/native consent bridge.
- Sentry Size Analysis is Android-only in Sentry; frontend/desktop/Apple sizes
  are reported as GitHub artifacts/summaries.

## Final Declaration

Only after every applicable item above is checked with evidence:

> Sentry is end-to-end operational for Charm 2.0 in production: owner-side
> Sentry/GitHub configuration is complete, release artifacts upload and
> symbolicate, runtime events/replay/logs/feedback behave as documented, visual
> snapshots upload and diff, alerts/routing are configured or explicitly not
> applicable, and privacy/consent guarantees have been verified.
