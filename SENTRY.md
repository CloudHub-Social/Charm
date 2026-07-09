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

Android JVM setup lives in
`src-tauri/gen/android/app/src/main/java/social/cloudhub/charm/CharmApplication.kt`.
The app manifest removes Sentry's Android `ContentProvider` auto-init path, so
adding the runtime SDK does not start Sentry before application code runs.
`CharmApplication` initializes `SentryAndroid` only when all conditions are true:

- `SENTRY_DSN` or `VITE_SENTRY_DSN` was present at Android build time.
- `observability.json` in Android app storage has
  `observability.state.sentryEnabled: true`.

The Android runtime initializer watches the same store and gates `beforeSend`
and `beforeBreadcrumb` from an in-memory consent flag, keeps `sendDefaultPii`
off, disables Android auto-session tracking, and leaves performance tracing
unconfigured. This initial Android coverage is therefore scoped to Sentry
Android's JVM crash and ANR capture after opt-in. Same-session opt-out prevents
new captures through the callback gates, but events already accepted by the SDK
can still be retried or delivered from Sentry's queue. Opting back in during the
same session resumes events only if Sentry was already initialized at startup. If
Android starts with consent disabled, first opt-in still requires an app restart
because `SentryAndroid.init` only runs from `Application.onCreate`.
NDK/native crash capture, Android Mobile Vitals, and performance transactions
remain disabled until Charm has the corresponding SDK integration and a native
consent bridge that can shut down or reconfigure the SDK immediately when a user
opts out.

When Sentry consent is enabled, Rust installs a Sentry `tracing` layer after
Sentry initialization, even if `logsEnabled` is false at startup, so
same-session log opt-in can start native tracing without a restart. The layer is
target-filtered to Charm-owned Rust modules, uses runtime `logsEnabled` consent
seeded from the store and refreshed immediately by settings IPC, emits tracing
events only while log consent is enabled, captures warn/error events as Sentry
logs, keeps info/warn/error events as breadcrumbs, captures error events as
Sentry issues, and ignores debug/trace tracing events. The native Sentry Logs
client support is initialized for the same-session opt-in path, but its
`before_send_log` hook drops logs whenever runtime log consent is disabled, and
drops debug logs outside debug builds.

## Environment

Use these variables for local or release builds:

- `VITE_SENTRY_DSN`: public frontend DSN.
- `SENTRY_DSN`: Rust/native DSN. Android also embeds this at build time for
  JVM crash and ANR coverage.
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

Manual dispatch is safe only after the repository owner has configured the four
required secrets above. A dry repo-side check can validate workflow syntax,
release/env propagation, and build wiring, but it cannot prove Sentry accepted
the sourcemaps, debug files, Android mappings/native symbols, or Size Analysis
build without those secrets and a real workflow run.

Suggested owner-side dispatch for a release candidate:

```sh
gh workflow run sentry-release-artifacts.yml \
  --ref main \
  -f release=charm@2.0.0-rc.1 \
  -f environment=production
```

For a tag release, prefer running from the tag ref and omit `release` so the
workflow uses the tag name:

```sh
gh workflow run sentry-release-artifacts.yml \
  --ref v2.0.0 \
  -f environment=production
```

Sentry-side verification after the workflow finishes:

- Releases: the selected release exists and has frontend artifacts with debug
  IDs/source maps for the built JavaScript chunks.
- Debug files: Linux, macOS, Windows, and iOS simulator debug files appear under
  the `charm` project and are processed without unresolved upload errors.
- Android: ProGuard/R8 mapping and native symbols are associated with the
  release build uploaded by the Gradle plugin.
- Size Analysis: the Android APK/AAB appears in Sentry Size Analysis with the
  configured `Release` build configuration and base SHA.
- Workflow artifacts: GitHub contains the frontend, Linux, Apple, Windows, and
  Android size report artifacts for the run.

Sentry Size Analysis currently receives Android builds only. The current iOS CI
path builds an unsigned simulator debug app, while Sentry accepts XCArchive or
IPA inputs for iOS size analysis; wire that upload once a signed device-release
archive or IPA exists. Frontend and desktop bundle sizes are reported in GitHub
because Sentry Size Analysis is a mobile build-size product, not a generic web
or desktop bundle analyzer.

Signed iOS device-release dSYMs, NDK/native Android crash capture, Android
Mobile Vitals, and performance transactions are still Phase 3 follow-ups.

## Scrubbing Rules

Frontend scrubbers live in `src/observability/scrubbers.ts`; Rust scrubbers live
next to the Rust Sentry setup in `src-tauri/src/lib.rs`.

Both sides redact Matrix user IDs, room IDs, room aliases, event IDs, `mxc://`
URIs, and known secret fields. Any new `captureMessage`, `captureException`,
breadcrumb, log, or manual context call must go through the SDK's normal
pipeline so these hooks run. Do not send raw Matrix IDs or tokens through a
custom transport or external logging path.

## User Feedback

Charm registers Sentry's Feedback integration only after the existing Sentry
opt-in gate passes. The integration is configured with `autoInject: false`, so
Sentry does not add its own always-visible launcher; Charm opens the form from
the Observability settings panel and the top-level error fallback instead.

The feedback form hides name and email fields by default. Users can describe
what happened, and the form includes Sentry's optional screenshot capture UI
when the current SDK/browser path supports it. Feedback events and screenshot
metadata still travel through the normal Sentry client pipeline, including
Charm's before-send scrubbers. Screenshot pixels are not text/JSON payloads,
so they are not scrubbed by Charm; the settings UI warns that optional
screenshots may include visible room names, Matrix IDs, or message text.

Screenshot capture is best-effort: the current implementation relies on
Sentry's browser feedback form support rather than a custom screenshot
attachment pipeline. If the SDK cannot create the feedback form, Charm leaves
the button unavailable or reports that feedback requires Sentry observability.

## Phasing

This implementation covers the foundation: consent, settings UI, Sentry init,
release/environment/platform tags, release-health sessions, basic tracing,
scrubbing, docs, and the opt-in frontend configuration for replay, canvas
replay, profiling, warning/error console logs, frontend Tauri IPC breadcrumbs,
Rust attachment-upload IPC breadcrumbs correlated by the frontend operation ID
header, and a consent-gated Rust `tracing`/Sentry Logs bridge for startup,
attachment IPC, and push decrypt fallback events. It also covers opt-in user
feedback from settings and the crash fallback, with optional SDK-provided
screenshot capture when supported.

Broader Rust tracing/log bridges, NDK/native Android crash capture, Android
Mobile Vitals, and signed iOS device-release dSYMs remain separate follow-up
phases from Spec 21.
Broader per-command Rust instrumentation is still intentionally incremental;
new producers should stay Charm-targeted and avoid raw Matrix identifiers, file
paths, and secrets.
