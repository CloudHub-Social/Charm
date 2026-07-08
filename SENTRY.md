# Sentry Observability

Charm's Sentry integration is default-off and consent-gated.

## Runtime Configuration

Frontend Sentry setup lives in `src/observability/instrument.ts`. It reads
persisted settings from `src/observability/persistence.ts`, then initializes
`@sentry/react` only when both conditions are true:

- `VITE_SENTRY_DSN` is present.
- `sentryEnabled` is true in `observability.json` or the local mirror.

Rust setup lives in `src-tauri/src/lib.rs`. It initializes Sentry from Tauri
`setup()` only when both conditions are true:

- `SENTRY_DSN` is present.
- `observability.json` in the app data directory has
  `observability.state.sentryEnabled: true`.

Rust startup cannot read browser `localStorage`, so the Tauri store file is the
cross-process source of truth. Settings changes that disable Sentry turn off the
already-running frontend client for the current window and apply to Rust crash
monitoring on restart. Re-enabling after a same-window opt-out flips the
frontend client back on without calling `Sentry.init()` a second time.

## Environment

Use these variables for local or release builds:

- `VITE_SENTRY_DSN`: public frontend DSN.
- `SENTRY_DSN`: Rust/native DSN.
- `VITE_SENTRY_ENVIRONMENT` / `SENTRY_ENVIRONMENT`: Sentry environment.
- `VITE_SENTRY_RELEASE` / `SENTRY_RELEASE`: release override.
- `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`: artifact upload through
  `@sentry/vite-plugin` and `sentry-cli`.
- `SENTRY_UPLOAD=true`: release-build guard that requires the three upload
  variables above and fails the build if any are missing.

The Vite plugin is gated on `SENTRY_UPLOAD=true` plus all three upload
variables, so dev and normal PR builds do not create releases or emit
sourcemaps even if repository secrets are available. Release upload workflows
set `SENTRY_UPLOAD=true` so a missing token/org/project is a hard failure
instead of silently producing an unsymbolicated build.

## Release Artifacts

`.github/workflows/sentry-release-artifacts.yml` runs on `v*` tags and manual
dispatch. It currently uploads:

- Frontend sourcemaps through `@sentry/vite-plugin`, with emitted `.map` files
  deleted from `dist` after upload.
- Linux, macOS, and Windows debug information from Tauri release builds
  compiled with `CARGO_PROFILE_RELEASE_DEBUG=1`, using
  `sentry-cli debug-files upload --include-sources --wait`.
- iOS simulator debug information from the current unsigned CI build path.
- Android ProGuard/R8 mapping files and native symbols through the Sentry
  Android Gradle plugin, enabled only in the release artifact workflow via
  `SENTRY_ANDROID_UPLOAD=true`.
- Size-analysis reports for frontend, desktop release, Apple debug/simulator,
  and Android release outputs as GitHub step summaries and downloadable workflow
  artifacts.
- Android APK/AAB output to Sentry Size Analysis with
  `sentry-cli build upload` after the Android release-artifact build succeeds.

The workflow requires these repository secrets: `SENTRY_AUTH_TOKEN`,
`SENTRY_ORG`, `SENTRY_PROJECT`, and `VITE_SENTRY_DSN`. The DSN is used only for
the frontend sourcemap build so uploaded maps match the same Sentry-enabled
bundle shape as shipped releases. Manual runs can override the Sentry release
name and environment; tag runs default the release name to the tag, and manual
runs without a release input default to the commit SHA.

Sentry Size Analysis currently receives Android builds only. The current iOS CI
path builds an unsigned simulator debug app, while Sentry accepts XCArchive or
IPA inputs for iOS size analysis; wire that upload once a signed device-release
archive or IPA exists. Frontend and desktop bundle sizes are reported in GitHub
because Sentry Size Analysis is a mobile build-size product, not a generic web
or desktop bundle analyzer.

Signed iOS device-release dSYMs and native Android SDK runtime crash coverage
are still Phase 3 follow-ups.

## Scrubbing Rules

Frontend scrubbers live in `src/observability/scrubbers.ts`; Rust scrubbers live
next to the Rust Sentry setup in `src-tauri/src/lib.rs`.

Both sides redact Matrix user IDs, room IDs, room aliases, event IDs, `mxc://`
URIs, and known secret fields. Any new `captureMessage`, `captureException`,
breadcrumb, log, or manual context call must go through the SDK's normal
pipeline so these hooks run. Do not send raw Matrix IDs or tokens through a
custom transport or external logging path.

## Phasing

This implementation covers the foundation: consent, settings UI, Sentry init,
release/environment/platform tags, release-health sessions, basic tracing,
scrubbing, docs, and the opt-in frontend configuration for replay, canvas
replay, profiling, warning/error console logs, frontend Tauri IPC breadcrumbs,
and Rust attachment-upload IPC breadcrumbs correlated by the frontend operation
ID header.

Screenshots, native Android SDK runtime coverage, and signed iOS device-release
dSYMs remain separate follow-up phases from Spec 21.
