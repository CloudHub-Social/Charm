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
cross-process source of truth. Settings changes that disable Sentry close the
already-running frontend SDK for the current window and apply to Rust crash
monitoring on restart. Re-enabling after a same-window opt-out is persisted but
does not call `Sentry.init()` a second time; it takes effect after reload/startup.

## Environment

Use these variables for local or release builds:

- `VITE_SENTRY_DSN`: public frontend DSN.
- `SENTRY_DSN`: Rust/native DSN.
- `VITE_SENTRY_ENVIRONMENT` / `SENTRY_ENVIRONMENT`: Sentry environment.
- `VITE_SENTRY_RELEASE` / `SENTRY_RELEASE`: release override.
- `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`: sourcemap upload through
  `@sentry/vite-plugin`.

The Vite plugin is gated on all three upload variables so dev and normal PR
builds do not create releases or emit sourcemaps.

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
replay, profiling, and warning/error console logs.

User feedback, screenshots, IPC breadcrumb wrapping, Rust tracing/log bridges,
native SDKs, dSYMs, Android mapping files, Rust debug-info upload, and size
analysis remain separate follow-up phases from Spec 21.
