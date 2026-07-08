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

The Android runtime initializer re-checks the same store in `beforeSend`, keeps
`sendDefaultPii` off, disables Android auto-session tracking, and sets
`tracesSampleRate` to `0.0`. This initial Android coverage is therefore scoped
to Sentry Android's native/JVM crash and ANR capture after opt-in. Android
Mobile Vitals/performance transactions remain disabled until Charm has a
same-session native consent bridge that can shut down or reconfigure the SDK
immediately when a user opts out.

## Environment

Use these variables for local or release builds:

- `VITE_SENTRY_DSN`: public frontend DSN.
- `SENTRY_DSN`: Rust/native DSN. Android also embeds this at build time for
  native runtime crash coverage, falling back to `VITE_SENTRY_DSN` when
  `SENTRY_DSN` is absent.
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

The workflow requires these repository secrets: `SENTRY_AUTH_TOKEN`,
`SENTRY_ORG`, `SENTRY_PROJECT`, and `VITE_SENTRY_DSN`. The DSN is used only for
the frontend sourcemap build so uploaded maps match the same Sentry-enabled
bundle shape as shipped releases. Manual runs can override the Sentry release
name and environment; tag runs default the release name to the tag, and manual
runs without a release input default to the commit SHA.

Signed iOS device-release dSYMs, Android Mobile Vitals, and Sentry size-analysis
uploads are still Phase 3 follow-ups. Add them to the release artifact workflow
once the corresponding signed/release, native consent bridge, or size-analysis
pipeline exists.

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
and Rust attachment-upload IPC breadcrumbs correlated by the frontend operation
ID header. It also covers opt-in user feedback from settings and the crash
fallback, with optional SDK-provided screenshot capture when supported.

Broader Rust tracing/log bridges, Android Mobile Vitals, signed iOS
device-release dSYMs, and size analysis remain separate follow-up phases from
Spec 21.
