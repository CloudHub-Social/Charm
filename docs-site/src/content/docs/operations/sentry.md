---
title: Sentry observability
description: Runtime consent, privacy, releases, debug artifacts, visual snapshots, and operator checks.
---

Charm uses Sentry across the React frontend, native Rust shell, Android JVM,
and the Rust companion server. The integration is deliberately split by
runtime because each surface has different transport, consent, and artifact
requirements.

:::note
[`SENTRY.md`](https://github.com/CloudHub-Social/Charm/blob/main/SENTRY.md) is
the canonical detailed reference. This page is the operational map.
:::

## Runtime model

| Runtime | Enablement | Transport | What is captured |
| --- | --- | --- | --- |
| Browser web build | `VITE_SENTRY_DSN` plus saved user opt-in | Sentry browser SDK network transport | Frontend errors, logs, sessions, feedback, and configured metrics |
| Tauri frontend | `VITE_SENTRY_DSN` plus saved user opt-in | Sentry envelopes tunnel through typed Tauri IPC because the webview CSP blocks direct ingest | The same frontend signals after normal Sentry scrubbers run |
| Native Rust | `SENTRY_DSN` plus the same persisted opt-in | Rust Sentry SDK and a filtered `tracing` layer | Charm-owned breadcrumbs, consented logs, errors, and crashes |
| Android JVM | DSN embedded at build time plus persisted opt-in at startup | Sentry Android SDK | Opted-in JVM crashes and ANRs; native NDK capture is not enabled yet |
| Companion server | `CHARM_WEB_SERVER_SENTRY_DSN` | Rust Sentry SDK with `tracing` integration | Operator-enabled backend errors and logs; no end-user toggle exists in the headless service |

Client Sentry is **default-off**. A DSN makes reporting available but does not
override user consent. Turning reporting off stops new frontend events in the
current window; some native startup paths take effect on the next app launch.

## Privacy invariants

Frontend and Rust scrubbers redact Matrix user IDs, room IDs and aliases,
event IDs, `mxc://` URIs, and known secret fields such as tokens, passwords,
and recovery keys. New manual events, breadcrumbs, logs, and contexts must use
the normal SDK pipeline so those hooks run.

Do not:

- attach raw Matrix event bodies or identifiers to Sentry context;
- bypass the SDK with a custom logging or upload path;
- assume screenshot pixels are scrubbed like JSON. User feedback warns that
  an optional screenshot can contain visible room names or message text.

## Build and release variables

Runtime reporting uses:

- `VITE_SENTRY_DSN` for the React bundle;
- `SENTRY_DSN` for the native Rust process;
- `VITE_SENTRY_ENVIRONMENT` / `SENTRY_ENVIRONMENT`;
- `VITE_SENTRY_RELEASE` / `SENTRY_RELEASE`.

Artifact upload additionally requires `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and
`SENTRY_PROJECT`. `SENTRY_UPLOAD=true` is the explicit guard that enables the
Vite release plugin; normal local and pull-request builds do not create Sentry
releases or publish source maps.

The shared
[`configure-sentry-release-env.sh`](https://github.com/CloudHub-Social/Charm/blob/main/.github/scripts/configure-sentry-release-env.sh)
script validates credentials and computes consistent release/environment values
for web, nightly, and release workflows.

## Evidence produced in CI

### Runtime releases and symbols

The release workflow uploads frontend source maps, desktop debug information,
Android mappings/native symbols, and size reports. Source maps are removed from
the published frontend bundle after upload.

The shared development Worker also creates a Sentry release and uploads source
maps on trusted `main` builds. Pull-request Worker previews intentionally get
only the public runtime DSN: the write-capable Sentry token is never exposed to
PR-controlled install or build scripts.

### Visual snapshots

`.github/workflows/sentry-snapshots.yml` captures two independent baselines:

- `charm-storybook` for isolated component stories;
- `charm-e2e` for composed Playwright states.

Capture artifacts are retained in GitHub even when Sentry snapshot upload is
disabled. Upload is gated by the `SENTRY_SNAPSHOTS_ENABLED` repository variable
and is non-blocking on pull requests so a Sentry-side outage cannot block code
that otherwise passes deterministic screenshot capture.

## Operator verification

After a trusted web or release deployment:

1. Confirm the workflow computed the expected release and environment.
2. Confirm frontend artifacts and source maps share debug IDs.
3. Confirm native debug files finished processing without unresolved errors.
4. Trigger a safe, known test event only in an environment intended for test
   telemetry; verify its platform and release tags.
5. For snapshot runs, inspect the GitHub artifact first, then the matching
   `charm-storybook` or `charm-e2e` baseline in Sentry.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No client events | Verify both the DSN and persisted opt-in; a configured DSN alone is insufficient. |
| Browser events work but Tauri events do not | Check the IPC envelope forwarding command and the baked native DSN; do not loosen the webview CSP. |
| Events are unsymbolicated | Match the event release to the upload release and inspect source-map/debug-file processing. |
| PR preview has runtime events but no source maps | Expected: PR builds never receive the write-capable upload token. |
| Snapshot upload is absent | Check `SENTRY_SNAPSHOTS_ENABLED`, then inspect the always-produced GitHub screenshot artifact. |
| Backend startup failure is only in stdout | Verify `CHARM_WEB_SERVER_SENTRY_DSN` and the backend environment/release variables. |

For consent lifecycle details, crash-recovery behavior, Android limitations,
feedback routing, and the complete release checklist, read
[`SENTRY.md`](https://github.com/CloudHub-Social/Charm/blob/main/SENTRY.md).
