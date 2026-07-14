---
title: "Charm 2.0 Spec — Sentry observability (error monitoring, tracing,
  replay, logs)"
type: spec
project: "Charm 2.0"
created: "2026-07-08"
status: shipped
sidebar:
  label: "Sentry observability"
---

**Workstream:** too large for one PR — phased, see [Phasing](#phasing). **Tier:** Day-1 scope (owner request, 2026-07-08).

## Problem & why now

Charm 2.0 ships almost no observability today. `src/main.tsx` calls
`Sentry.init({dsn, enabled})` with nothing else configured — no environment,
release, integrations, sampling, replay, logs, or scrubbing. `src-tauri/src/lib.rs`
calls `sentry::init` reading a bare `SENTRY_DSN` env var with a `before_send`
scrubber that only redacts known secret *field names* (`access_token`,
`password`, etc.) — it does not touch Matrix room/user/event IDs, which are the
dominant PII shape in this app. `src-tauri/src/push/mod.rs` has one
`sentry::capture_message` call for repeated UTD failures. Nothing else exists:
no tracing, no profiling, no session replay, no structured logs beyond default
breadcrumbs, no screenshot capture, no user feedback widget, no build
distribution (sourcemaps/dSYMs/symbols upload), no size analysis, and no opt-in
consent UI — Sentry currently activates for every user with a DSN configured,
which is not acceptable to ship as default-on.

Without this, the team is flying blind on crashes, slow paths, and the
cross-boundary bugs specific to this architecture (JS ↔ Tauri IPC ↔ Rust ↔
matrix-rust-sdk ↔ homeserver) once real users are on it. The owner has asked
for this to be treated as Day-1 scope, matching the full breadth of Sentry's
product surface: Error Monitoring, Tracing + Distributed Tracing, Profiling,
Session Replay, Logs, Breadcrumbs, Screenshots, User Feedback, Build
Distribution, and Size Analysis — with strict opt-in and PII scrubbing as a
hard requirement, not a follow-up. Also folded in during review (2026-07-08):
Release Health (crash-free sessions/users), Mobile Vitals and ANR/watchdog-
termination detection (native-SDK-dependent, Phase 3), and a note on Seer,
which is already enabled on the owner's Sentry org and just needs to be
pointed at whatever project(s) this spec creates.

## Current state (in repo, verified 2026-07-08)

- **Frontend (`src/`):** `main.tsx:17-20` — bare `Sentry.init`. `package.json`
  already has `@sentry/react` (`^10.63.0`) and `@sentry/vite-plugin`
  (`^5.3.0`) as deps, but the Vite plugin is not wired into `vite.config.ts`
  (no sourcemap upload configured). `src/components/ErrorFallback.tsx` is
  wired as the `Sentry.ErrorBoundary` fallback in `main.tsx:40`, but is a pure
  UI component with no Sentry calls of its own (no user-feedback hook, no
  screenshot).
- **Rust core (`src-tauri/`):** `Cargo.toml:28` — `sentry = "0.48.3"`.
  `lib.rs:17-58` — `SECRET_FIELD_PATTERN` regex + `scrub_secrets`/
  `scrub_event` (`before_send` hook), documented as a deliberately narrow
  defense-in-depth backstop, not a general scrubber. `lib.rs:144-151` —
  `sentry::init` reads `SENTRY_DSN` from env (no opt-in gate, no environment/
  release tags beyond `sentry::release_name!()`, no tracing/profiling config).
  `push/mod.rs:598-740` — one `capture_message` call for UTD-failure
  correlation, with an in-code comment acknowledging room IDs need scrubbing
  before this ships broadly (not yet implemented).
- **Mobile targets:** `src-tauri/gen/android` and `src-tauri/gen/apple` exist
  (Tauri-generated Android/iOS/macOS projects, not separate native codebases).
  No `sentry-android`/`sentry-cocoa` native SDK is wired into either — Tauri
  mobile apps get crash coverage today only from the Rust `sentry` crate
  inside the shared core, which does not capture JVM-level (Kotlin/Java
  WebView glue) or Obj-C/Swift-level native crashes on those platforms.
- **No opt-in UI exists.** No settings surface, no consent banner, no
  toggle of any kind — Sentry is either fully off (no `SENTRY_DSN`/
  `VITE_SENTRY_DSN`) or fully on for every user, for whoever built the binary.
- **No CI wiring** for sourcemap upload, dSYM upload, Android mapping/symbol
  upload, Rust debug-info upload, or bundle/app size analysis in
  `.github/workflows/quality-checks.yml` (checked — no `sentry` step present).
- **No docs** — no `PRIVACY.md`, `SENTRY.md`, or observability section in any
  existing doc in the repo.

### Reference implementation: Charm 1.0 legacy codebase

Charm 1.0 (matrix-js-sdk, single-process web/Tauri client — no separate Rust
core) has a mature setup worth mining for patterns, though its PII surface is
simpler (one process, not two across an IPC boundary):

- **`src/instrument.ts`** — the entire init lives here, imported first in the
  app's lifecycle.
  - **Default-off, opt-in via `localStorage`:** `sable_sentry_enabled`,
    `sable_sentry_replay_enabled`, `sable_sentry_canvas_replay_enabled` — three
    independent flags. `Sentry.init` only runs if a DSN is configured *and*
    `sable_sentry_enabled === 'true'`.
  - `sendDefaultPii: false` unconditionally.
  - Integrations: `reactRouterV6BrowserTracingIntegration`,
    `replayIntegration({maskAllText: true, blockAllMedia: true,
    maskAllInputs: true})` (gated on the replay flag) + optional
    `replayCanvasIntegration` (gated on the canvas-replay flag),
    `consoleLoggingIntegration({levels: ['error', 'warn']})`,
    `browserProfilingIntegration()`.
  - Tracing: `tracesSampleRate` 1.0 in dev/preview, 0.5 in prod.
    `tracePropagationTargets` allowlists `localhost` + a regex on the app's own
    homeserver domain — this is what makes distributed tracing (client →
    homeserver) work instead of stopping at the browser boundary.
  - Profiling: `profileLifecycle: 'trace'` (required — without it, profiling
    silently defaults to `'manual'` and never starts when only
    `profileSessionSampleRate` is set), `profileSessionSampleRate` 1.0 dev/
    preview, 0.5 prod. Requires a `Document-Policy: js-profiling` response
    header from whatever serves the app.
  - Replay sampling: `replaysSessionSampleRate` 1.0 dev/preview, 0.5 prod;
    `replaysOnErrorSampleRate: 1.0` (always capture replay around an error,
    regardless of the session sample roll).
  - Logs: `enableLogs: true`; `beforeSendLog` drops `debug`-level logs in
    production and scrubs Matrix IDs from both the log message and any
    string-valued attribute.
  - `beforeSendTransaction`: drops known-noisy synthetic transactions (e.g.
    `media.load`); scrubs Matrix IDs from the transaction name and from every
    string value in span data, handling the several OTel semconv attribute
    name variants in use across Sentry SDK versions (`http.url`, `url.full`,
    `http.target`, `server.address`, etc.) rather than one hardcoded key.
  - Per-session error rate limit: a module-level counter capped at 50 error
    events per page load, separate from the transaction/log budgets.
  - **`src/app/utils/sentryScrubbers.ts`** — `scrubMatrixIds`,
    `sanitizeSentryPayload`, `scrubMatrixUrl`: shared regex-based redaction
    helpers, applied consistently across `beforeSend`, `beforeSendLog`,
    `beforeSendTransaction` rather than one hook doing all the work.
  - **`src/app/utils/sentryToolbar.ts`** — Sentry Toolbar (dev-only inline
    debugging overlay), separate from the runtime SDK config. **Not ported
    in this spec** — see [Non-goals](#non-goals): it needs a PR-preview deploy URL
    to attach to, which Charm 2.0 doesn't have yet.
  - **`src/app/features/settings/developer-tools/SentrySettings.tsx`** +
    **`DevelopTools.tsx`** — the actual consent UI: toggles for
    enabled/replay/canvas-replay, living under Settings → Developer Tools.
  - **`src/app/features/bug-report/BugReportModal.tsx`** — user feedback flow,
    wired to Sentry's User Feedback API.
  - **`e2e/smoke/observability.spec.ts`** + **`e2e/support/sentrySnapshot.ts`**
    — Playwright patterns asserting init/scrubbing behavior without a real DSN
    (a fake transport, presumably — verify exact mechanism before porting).

**Why Charm 2.0 can't just copy this file-for-file:** Charm 1.0 is a single
JS process — one `beforeSend`/`beforeSendLog`/`beforeSendTransaction` triad
scrubs everything. Charm 2.0 splits the app across a JS frontend and a Rust
core connected by Tauri IPC; Matrix IDs, error messages, and breadcrumbs can
originate on *either* side, and IPC command arguments/results are exactly the
kind of thing that ends up in an automatic breadcrumb or a panic message on
the Rust side. Scrubbing has to be implemented twice (JS and Rust) with the
same ID-shape coverage, and the IPC boundary itself needs a policy (see
[IPC boundary scrubbing](#ipc-boundary-scrubbing)).

## Non-goals

- **Self-hosted Sentry.** Assumes Sentry SaaS (sentry.io) with an
  organization/project the owner controls; no on-prem relay.
- **Backend/homeserver-side Sentry.** Out of scope — this spec is Charm
  (client) instrumentation only, not Synapse/Sygnal.
- **A general-purpose telemetry/analytics pipeline.** This is crash/perf/UX
  observability for debugging, not product analytics (funnels, retention,
  etc.). Don't conflate the opt-in toggle with an analytics opt-in.
- **Windows/Linux desktop and Android/iOS store distribution mechanics**
  themselves — those are Spec 10's territory. This spec only adds the Sentry
  upload steps to whatever build pipeline already exists per platform; it does
  not stand up new build pipelines.
- **Real-user monitoring dashboards / alerting rules inside Sentry** —
  configuring alert rules, issue owners, Slack integration, etc. in the Sentry
  org itself is an operational task the owner does directly in Sentry's UI,
  not something to encode in this repo.
- **A fully generic PII scrubber.** Scope is Matrix identifiers (room/user/
  event IDs, homeserver domains embedded in them) and known secret fields —
  not an ML-based or exhaustive PII classifier.
- **GitHub PR-comment triage integration** and **Sentry Dev Toolbar** are
  owner-managed Sentry configuration, not runtime app work. Cloudflare preview
  deployments now provide the live per-PR URLs those tools need; see
  [Cloudflare previews](/operations/cloudflare-previews/) and
  [Sentry observability](/operations/sentry/) for the current operational
  contract.
- **Feature Flags product.** Sentry's Feature Flags tracking (flag-
  evaluation breadcrumbs, correlating flag state with issues; integrates
  with LaunchDarkly/Statsig/Unleash/a generic provider) has nothing to hook
  into — verified no feature-flag system of any kind exists in Charm 2.0
  today (`grep` across `src/`, `src-tauri/` for flag-provider names and
  "feature flag" turns up nothing). Not worth adding speculatively; revisit
  if/when Charm 2.0 adopts a feature-flag system for its own reasons (e.g.
  staged rollout of Spec 13's voice/video work), at which point wiring
  Sentry's flag tracking in is a small addition to whichever spec introduces
  flags, not a reason to build flag infrastructure now.

## Design & approach

### Consent model

One primary toggle, **default off**, plus category sub-toggles that are only
interactable once the primary is on — mirrors Charm 1.0's pattern, extended
for the categories Charm 2.0 adds:

| Setting key | Default | Gates |
|---|---|---|
| `sentry_enabled` | `false` | Whether `Sentry.init` runs on JS side *and* whether the Rust core's `sentry::init` is allowed to run (see [Cross-process consent](#cross-process-consent)) |
| `sentry_replay_enabled` | `false` | `replayIntegration` (JS only — no native equivalent) |
| `sentry_canvas_replay_enabled` | `false` | `replayCanvasIntegration`, sub-gated on replay being on |
| `sentry_profiling_enabled` | `false` | `browserProfilingIntegration` (JS) + Rust profiling (native, see [Profiling](#profiling)) |
| `sentry_logs_enabled` | `false` | `enableLogs` (JS) + Rust `tracing`→Sentry log bridge |

No separate toggle for error monitoring/tracing/breadcrumbs/tags — those are
the baseline of what `sentry_enabled` turns on, matching Charm 1.0 (which
doesn't split those either). Splitting five ways instead of Charm 1.0's three
is justified because profiling and logs are meaningfully separate consent
decisions (profiling samples CPU/stack data continuously; logs may echo
app-internal strings a user could reasonably want off even with crash
reporting on) — don't split further than this without a concrete reason.

**Cross-process consent:** since the JS frontend and Rust core each call
their own `sentry::init`/`Sentry.init`, the setting has to be readable by
both before either initializes. Store it via the existing Tauri
`tauri-plugin-store` (already a dependency per `package.json`) so it's
filesystem-backed and readable synchronously by the Rust core at startup,
*not* `localStorage` (which is JS-only and wouldn't be visible to
`lib.rs::run()`). This is the one required behavior change from Charm 1.0's
pattern — Charm 1.0 has no second process to synchronize with.

Startup ordering: the Rust core's `sentry::init` happens very early in
`run()` (`lib.rs:144`), before the frontend has loaded and before any
settings command has executed. Read the persisted toggle from the store
plugin's on-disk file directly (not via a Tauri command round-trip, which
doesn't exist yet at that point in startup) — same approach used for any
other pre-frontend Rust-side config, if a comparable pattern exists in Spec
15's per-account store isolation work; otherwise this needs its own minimal
synchronous read. **Open question, engineering** — confirm the exact
mechanism before implementation; flag if `tauri-plugin-store`'s on-disk
format changes between versions (it does, historically) since this repo
reads it outside the plugin's own API.

**Consent UI:** a new panel under Settings (reuse Spec 08/18's settings shell
— see whichever of the two IA reworks has landed by the time this starts, per
[Dependencies & sequencing](#dependencies--sequencing)), functionally equivalent to Charm 1.0's
`SentrySettings.tsx`: toggle rows for the five keys above, each with a
one-line description of what it sends, and a link out to the new privacy doc
(see [Docs](#docs)). No first-run banner/prompt in v1 — default-off with a
findable settings toggle is sufficient; a prompt can be a fast-follow if data
shows nobody finds the toggle organically.

### Error monitoring

- JS: `Sentry.ErrorBoundary` (already wired) + default unhandled
  exception/rejection capture from `Sentry.init`. No change to the boundary
  itself beyond adding the full init config from this spec.
- Rust: `sentry::init`'s default panic hook captures Rust panics. Existing
  explicit `capture_message` call in `push/mod.rs` stays, gets its room-ID
  scrubbing fixed (see [PII scrubbing](#pii-scrubbing)).
- Tauri command errors that surface to the frontend as `Result<T, String>`
  (or structured error types per Spec 20's convention) are **not**
  auto-captured by either SDK today — decide case by case whether a given
  command failure warrants an explicit `Sentry.captureException`/
  `sentry::capture_error` call on the JS side once it crosses IPC, vs. relying
  on the Rust-side panic/error capture at the source. Default: capture once,
  at the origin (Rust, since that's where the actual error context is
  richest), and treat IPC as a boundary the frontend doesn't need to
  re-report across for the same failure — avoids double-counting one failure
  as two Sentry issues in two projects/platforms.

**Release Health (crash-free sessions/users):** a different lens from issue-
level error monitoring — the % of sessions/users on a given `release` that
did *not* crash, which is what actually answers "did this release make
things worse" at a glance rather than requiring someone to eyeball issue
volume. Both SDKs support this close to automatically once `release` is set
(already planned, see [Tags, environment, and release](#tags-environment-and-release)) and sessions are
tracked (`autoSessionTracking`, on by default in `@sentry/react`; Rust side
needs `session_mode`/session tracking enabled explicitly — check `sentry`
crate `0.48.3`'s API). Marginal cost on top of what Phase 1 already ships is
small; include it in Phase 1 rather than deferring.

**Seer (AI-assisted issue triage):** already enabled on the owner's Sentry
org — it's what flagged the issue behind [Spec 20 — Structured UIA error type for settings commands](/specs/day-1/spec-20--structured-uia-error-type-for-settings-commands/)
via automated review on PR #57. No implementation work in this repo; the
only action item is making sure Seer is turned on for whichever Sentry
project(s) this spec creates (see [Sentry project structure](#sentry-project-structure)) once they
exist — owner-side Sentry configuration, not code.

### Tracing + distributed tracing

- JS: browser tracing integration equivalent to Charm 1.0's
  `reactRouterV6BrowserTracingIntegration` — Charm 2.0 uses a different
  router (check current `src/App.tsx`/routing setup before implementation;
  if Charm 2.0 has no client-side router yet, this integration may not apply
  1:1 and the spec should fall back to manual span creation around
  navigation-equivalent state transitions, e.g. room switches).
- Rust: `sentry` crate's tracing integration (`sentry-tracing` companion
  crate) if the Rust core already uses the `tracing` ecosystem (confirm via
  `Cargo.toml` — not currently listed; may need adding), wiring Rust spans
  into the same trace.
- **Tauri IPC boundary propagation:** this is the piece with no Charm 1.0
  precedent (single process, no boundary to cross). A JS-originated trace
  needs its trace ID to continue into the Rust-side spans for the same
  logical operation (e.g. "send message" spanning JS → `invoke()` → Rust
  command → matrix-rust-sdk → homeserver HTTP call). Options to evaluate
  during implementation:
  1. Pass Sentry's trace headers (`sentry-trace`, `baggage`) as explicit
     string arguments on relevant `#[tauri::command]` calls, continuing the
     trace context Rust-side via `sentry::continue_trace` (or the
     `sentry-tracing` equivalent).
  2. Accept that IPC-boundary trace continuity is Phase 2 (see
     [Phasing](#phasing)) and ship JS-side and Rust-side tracing as two
     *correlated-by-tag* but not *distributed-trace-linked* systems for v1 —
     tag both sides with a shared request/operation ID string instead of a
     true W3C trace context.
  Recommend starting with option 2 for the first phase (materially less
  Tauri-command surface area to touch) and evaluating option 1 once basic
  tracing ships and there's a concrete slow cross-boundary flow to debug.
- Distributed tracing to the homeserver itself (Rust → HTTP → Synapse) works
  automatically via `sentry`'s built-in HTTP client instrumentation if
  matrix-rust-sdk's HTTP client is one `sentry` auto-instruments (likely
  `reqwest` — confirm), same `tracePropagationTargets`-style allowlist
  concept as Charm 1.0, scoped to the user's own configured homeserver
  domain(s) (dynamic — Charm 2.0 users can point at any homeserver, unlike
  Charm 1.0's single-homeserver deployment target if that's still true;
  verify).

### Profiling

- JS: `browserProfilingIntegration`, same `profileLifecycle: 'trace'` +
  sample-rate pattern as Charm 1.0. Requires the `Document-Policy:
  js-profiling` response header — for the Tauri webview this may not apply
  the same way it does for a real HTTP-served page; **open question,
  engineering** — confirm whether Tauri's webview honors/needs this header at
  all, or whether it's a no-op requirement specific to browser-served
  contexts (Charm 2.0's companion-web-server spec, [Spec 16 — Web client via companion Matrix server](/specs/day-1/spec-16--web-client-via-companion-matrix-server/),
  is the one context where this literally applies as documented).
- Rust: `sentry`'s Rust SDK does not do continuous profiling out of the box
  the way the JS SDK does; Sentry's Rust profiling story is comparatively
  immature. Evaluate `pyroscope`/native `perf`-based options only if Sentry's
  own Rust profiling support proves workable during a short spike — **treat
  Rust-side profiling as Phase 3, don't block the rest of the spec on it.**
- Mobile native profiling (Android/iOS) depends on whether native SDKs are
  wired in at all (see [Mobile native SDKs](#mobile-native-sdks)) — `sentry-android`/
  `sentry-cocoa` both support profiling once the native SDK is present.

### Session replay

JS-only (`replayIntegration` + optional `replayCanvasIntegration`), same
config as Charm 1.0: `maskAllText: true`, `blockAllMedia: true`,
`maskAllInputs: true` always, non-negotiable — Charm renders message content
(potentially sensitive) and this masking is the only thing standing between
replay and leaking room content into Sentry. `replaysOnErrorSampleRate: 1.0`,
session sample rate mirrors Charm 1.0's dev/preview-vs-prod split. No replay
capability on the Rust/native side — Tauri desktop windows and mobile native
UI are out of scope for Sentry Session Replay (a JS/DOM-specific product);
document this limitation rather than attempting a workaround.

### Structured logs

- JS: `enableLogs: true` + `consoleLoggingIntegration` for `error`/`warn`,
  same `beforeSendLog` scrub-and-filter pattern as Charm 1.0.
- Rust: if the core adopts the `tracing` crate (see [Tracing](#tracing) — may
  already be a transitive dep via matrix-rust-sdk, confirm), use
  `sentry-tracing`'s log-forwarding layer to bridge `tracing` events into
  Sentry Logs, with an equivalent scrub-before-send hook.
- Drop `debug`-level logs in production on both sides (matches Charm 1.0's
  JS behavior; apply the same threshold Rust-side for consistency).

### Breadcrumbs

Both SDKs auto-generate breadcrumbs (console calls, HTTP requests, UI clicks
on JS side; explicit `sentry::add_breadcrumb` calls plus some auto-
instrumentation on Rust side). Two things need explicit design:

1. **Tauri IPC calls as breadcrumbs.** `invoke()` calls are the JS
   equivalent of Charm 1.0's fetch/XHR breadcrumbs and should be captured
   the same way — command name only, never raw args/results (args/results
   routinely contain room IDs, message bodies, tokens). Evaluate whether
   `@tauri-apps/api`'s `invoke` is auto-instrumented by `@sentry/react`'s
   default integrations or needs an explicit wrapper; if the latter, a thin
   wrapper around `invoke()` that adds a breadcrumb with just the command
   name (no payload) before calling through is the minimum viable version.
2. **Manual breadcrumbs for Matrix-specific state transitions** (room
   switch, sync state change, send/receive) — evaluate case by case during
   implementation which are worth adding explicitly vs. relying on
   auto-instrumentation; don't over-instrument up front.

All breadcrumbs, auto- or manual-generated, flow through the same scrubbing
as everything else (see [PII scrubbing](#pii-scrubbing)) — a breadcrumb is not a lower-
scrutiny category.

### Screenshots

JS-side: `Sentry.ErrorBoundary`'s fallback (`ErrorFallback.tsx`) and the new
user-feedback flow (see next section) should both offer a "include a
screenshot" option using `@sentry/react`'s built-in screenshot capture
(`Sentry.getScreenshotIntegration` or equivalent — check current SDK API,
this has moved between Sentry SDK versions). Screenshot capture must respect
the same masking philosophy as replay: if the SDK's screenshot integration
doesn't independently apply DOM masking (it uses a different capture path
than replay), evaluate whether that's an acceptable gap or whether
screenshots need to be excluded/opt-in separately. **Open question,
engineering** — verify current `@sentry/react` screenshot integration's
interaction (if any) with replay's masking config before shipping; if none,
screenshots may need their own explicit warning in the consent UI ("this
captures what's currently on screen, unmasked") rather than being silently
lumped under the general `sentry_enabled` toggle.

No Rust/native screenshot capture in v1 (desktop/mobile native crash
screenshots are a materially different mechanism per platform) — Phase 3+
if wanted later.

### User feedback

Port Charm 1.0's `BugReportModal.tsx` pattern: a user-triggered "Report a
problem" flow (Settings entry point + potentially the error boundary fallback
UI) that collects a description and optionally attaches a screenshot and
recent logs/breadcrumbs, submitted via Sentry's User Feedback API
(`Sentry.captureFeedback` or `Sentry.showReportDialog`, depending on which
Charm 1.0 actually uses — confirm by reading the file, don't assume). Only
available when `sentry_enabled` is on (feedback without error monitoring
enabled has nowhere useful to attach to) — the settings UI should make this
dependency clear rather than showing a feedback option that silently no-ops.

### Build distribution

Per-platform artifact upload so stack traces symbolicate:

| Platform | Artifact | Mechanism |
|---|---|---|
| Web/desktop JS bundle | Sourcemaps | `@sentry/vite-plugin` (already a dep, not yet wired into `vite.config.ts`) — wire in with `authToken`/`org`/`project` from CI secrets, upload on `pnpm build` |
| Rust core (all desktop platforms) | Debug info (DWARF/PDB) | `sentry-cli debug-files upload` step in CI after `cargo build --release`, or the `sentry` crate's native-debug-info Cargo feature if available in `0.48.3` — confirm |
| macOS/iOS | dSYMs | `sentry-cli` dSYM upload, standard for Xcode-produced builds via `src-tauri/gen/apple` |
| Android | ProGuard/R8 mapping + native symbols | `sentry-android-gradle-plugin` added to `src-tauri/gen/android/app/build.gradle.kts` (auto-uploads mapping + NDK symbols on release build) |

This is CI work (`.github/workflows/quality-checks.yml` or a new release
workflow — check which workflow actually produces release builds before
deciding where this lives) requiring new secrets
(`SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` — likely per-platform
project slugs, see [Sentry project structure](#sentry-project-structure)). Local dev builds should
not attempt uploads (no token available, and it would be noise) — gate on
`CI=true` or a release-build flag, matching how sourcemap upload plugins
conventionally no-op locally.

### Size analysis

Sentry's build/app size analysis product needs the built artifact (APK/IPA/
app bundle, or the web bundle) uploaded alongside build distribution. Same
CI step family as [Build distribution](#build-distribution) — evaluate whether this is a
separate `sentry-cli` invocation or bundled into the same upload step once
implementation starts; don't scope it as fully separate work, it's a flag/
additional artifact on the distribution step for most platforms.

### PII scrubbing

**The hard requirement, applies identically to every category above.** Matrix
IDs (`@user:homeserver.tld`, `!roomid:homeserver.tld`,
`$eventid:homeserver.tld`, room aliases `#alias:homeserver.tld`) embed a
homeserver domain and are treated as PII-adjacent throughout — Charm 1.0's
existing framing (`scrubMatrixIds`/`scrubMatrixUrl`) is correct and should be
adopted verbatim in shape, ported into Charm 2.0's JS side, plus a
**Rust-side equivalent with matching regex coverage** (the two must agree on
what counts as an ID — a shared test fixture of example strings, asserted
against both implementations, is worth the small overhead to prevent drift).

Coverage required in both languages:

- Any string field on any event/transaction/log/breadcrumb (message,
  exception value, span description, span data values, log message, log
  attributes, transaction name) — matches Charm 1.0's exhaustive-scrub
  philosophy (scrub every string value encountered, not just known field
  names), because Sentry/OTel attribute naming has changed across SDK
  versions and a fixed allowlist of field names silently stops working on
  upgrade.
- Known secret fields (`access_token`, `refresh_token`, `password`,
  `passphrase`, `recovery_key`, `secret_storage_key`, `session_key`) — Rust
  side already has this (`lib.rs` `SECRET_FIELD_PATTERN`); port an equivalent
  to JS side (currently absent — JS-originated errors have no secret-field
  scrubbing at all today).

#### IPC boundary scrubbing

Because Charm 2.0 splits state across JS and Rust, a value can be scrubbed
correctly on one side and still leak if the *other* side captures it first
(e.g. a Tauri command's Rust-side panic message embeds a room ID *before*
it's serialized back across IPC — Rust's own `before_send` catches this at
the Rust SDK's boundary, fine — but if the frontend also logs the raw IPC
error as a breadcrumb on receipt, JS's scrubber needs to catch it too before
*its* `beforeSend` fires). Design principle: **scrub at the point each SDK's
own `beforeSend`/`beforeSendLog`/`beforeSendTransaction` hook fires, on
whichever side that event originates** — do not rely on "the other side
already scrubbed it," since that's an implicit cross-process invariant that
silently breaks if either side's hook is bypassed (e.g. `capture_message`
call sites, which route through the same `before_send` hook already, so
this holds today for Rust — just confirm it continues to hold for every new
call site this spec adds).

#### Sentry project structure

**Open question, engineering** — decide whether Charm 2.0 uses one Sentry
project across all platforms (tag-differentiated by `platform`) or separate
projects per platform (web/desktop/android/ios), before wiring build
distribution (project slug is required at CI-secret-configuration time, not
deferrable). One project with a `platform` tag is simpler operationally and
matches how `environment`/`release` tagging is scoped below; recommend this
unless the owner has an existing Sentry org convention that says otherwise.
Check the owner-managed Sentry configuration to confirm whether Charm 1.0
already has a separate project, and do not accidentally reuse it for 2.0.

### Tags, environment, and release

| Tag | Source | Notes |
|---|---|---|
| `environment` | Build-time env var, mirroring whatever dev/preview/production concept already exists in Charm 2.0's build config (check `vite.config.ts`/CI for an existing convention before inventing a new one — Charm 1.0 uses `VITE_SENTRY_ENVIRONMENT` falling back to Vite's `MODE`) | dev/preview/production |
| `release` | App version (`Cargo.toml`/`package.json` version, or git tag at build time) | Both SDKs (`sentry::release_name!()` already present Rust-side; JS side needs an equivalent, not currently set) |
| `platform`/`os` | Static per build target (`macos`, `windows`, `linux`, `android`, `ios`, `web`) | Set explicitly at init — Sentry's own `os`/`device` context captures some of this automatically but an explicit tag makes filtering reliable across the mixed JS/Rust/native event sources |
| `build_channel` | Whatever release-channel concept exists today (stable/beta/nightly) if any — confirm with Spec 10/CI before assuming one exists | Skip this tag entirely if no such concept exists yet rather than inventing one for this spec alone |

### User identification

Opt-in only (covered by `sentry_enabled`), anonymized string only. Generate a
random, locally-persisted, non-reversible identifier (UUID or similar) at
first opt-in — **never** the user's Matrix ID, email, or display name. Store
alongside the other Sentry settings (same `tauri-plugin-store` file).
Regenerating this ID on opt-out-then-back-in (rather than reusing a stable
one) is worth an explicit decision: reusing it lets Sentry correlate a
user's issues across sessions (more useful for debugging); regenerating
maximizes privacy by breaking that correlation. **Open question, product/
owner** — pick one; default recommendation is *reuse* (stable per-install ID,
never tied to any real identity, regenerated only on full app data reset) for
debugging usefulness, since the anonymization already removes the actual
privacy risk reuse would otherwise pose.

### Mobile native SDKs

Whether to add `sentry-android` (Gradle plugin + SDK) and `sentry-cocoa`
(CocoaPods/SPM) directly into the generated `src-tauri/gen/android` and
`src-tauri/gen/apple` projects, vs. relying solely on the Rust core's
`sentry` crate for mobile crash coverage. Native SDKs catch JVM/Obj-C/Swift-
level crashes the Rust crate cannot see (WebView glue, Tauri's own mobile
runtime code) — recommended for completeness, but adds real complexity:
`src-tauri/gen/*` are **generated** directories (regenerated by
`tauri android init`/`tauri ios init` under some circumstances — verify
whether Charm 2.0's are hand-maintained-after-generation or regenerated in
CI), so native SDK config needs to live somewhere that survives
regeneration (a Tauri config hook, or documented manual reapplication step).
**Recommend Phase 3** (see [Phasing](#phasing)) — ship Rust-side + JS-side coverage
first (catches the large majority of app-logic bugs, which is where nearly
all of Charm's own code lives), add native SDKs once there's evidence of
native-layer crashes the Rust crate isn't catching.

If/when native SDKs are added, they bring three capabilities with no
Rust-crate equivalent, worth scoping explicitly into Phase 3 rather than
treating "add the native SDK" as the whole task:

- **ANR detection (Android)** — `sentry-android`'s Application-Not-
  Responding detector, catches UI-thread hangs the Rust crate can't see
  (it isn't on the UI thread).
- **Watchdog terminations (iOS)** — `sentry-cocoa`'s heuristic for
  detecting the OS silently killing the app in the background (memory
  pressure, watchdog timeout) — shows up as neither a crash nor a clean
  exit otherwise, and is invisible without this.
- **Mobile Vitals** (cold/warm app start time, slow/frozen frame rate,
  time-to-initial-display) — part of the Tracing product but only
  populated once the native SDK's automatic instrumentation is present;
  call this out specifically in Phase 3 acceptance criteria rather than
  assuming it falls out of the JS-side tracing work from Phase 1.

### Docs

Two new files, both scoped per the user's explicit ask:

1. **`PRIVACY.md`** at repo root (matches root-level convention of
   `CLAUDE.md`/`README.md` — check if a `docs/` directory is the established
   place for longer-form docs instead before finalizing location; default to
   root if no such convention exists). Plain-language, user-facing: what
   Sentry categories exist, that all are off by default, exactly what each
   toggle sends (event types, NOT sending Matrix content/IDs — name the
   scrubbing guarantee explicitly), how to opt out, how to request data
   deletion (Sentry's own retention/deletion mechanisms, linked).
2. **`SENTRY.md`** (root or `docs/`, same location decision as above) —
   contributor-facing technical doc: how to get a dev DSN, what each sample
   rate/toggle does and why, where the scrubbers live (JS + Rust file paths),
   the rule for adding new instrumentation safely ("if you add a
   `capture_message`/`add_breadcrumb`/log call, it inherits the existing
   `before_send` scrub — don't bypass it by capturing manually through a
   different path"), and the CI build-distribution secrets required.

## Scope (in) — summary

1. JS: full `Sentry.init` config in `main.tsx` (or extracted to its own
   `src/instrument.ts`, matching Charm 1.0's file name/pattern) —
   environment/release/platform tags, tracing, profiling, replay, logs,
   scrubbers, rate limiting, opt-in gating, Release Health/session tracking.
2. Rust: expanded `sentry::init` config in `lib.rs` — tags, tracing (if
   `tracing` crate adopted), scrubbers extended to Matrix ID coverage
   (matching JS scrubber shape), opt-in gating via shared store file.
3. New `sentryScrubbers` module, JS and Rust, with a shared test-fixture
   file of example Matrix IDs/URLs asserted identical in both.
4. New consent settings panel (JS) with the five toggles from
   [Consent model](#consent-model).
5. User feedback flow (port of `BugReportModal.tsx`), gated on
   `sentry_enabled`.
6. `@sentry/vite-plugin` wired into `vite.config.ts`, gated to CI/release
   builds only.
7. CI steps for sourcemap/dSYM/Android-mapping/Rust-debug-info upload (build
   distribution) and size analysis, per platform, with new repo secrets.
8. `PRIVACY.md` and `SENTRY.md`.
9. Tests: unit tests for both scrubber implementations (shared fixture),
   Vitest/RTL for the consent UI, Playwright smoke test mirroring Charm
   1.0's `e2e/smoke/observability.spec.ts` (init/opt-in/scrub behavior
   without a real DSN).
10. Confirm Seer (already enabled on the owner's Sentry org) is pointed at
    the Charm 2.0 project(s) once created — no code, an owner-side Sentry
    config step, tracked here so it doesn't fall through the cracks.
11. Check whether any periodic background job (push-token refresh, sync
    heartbeat, etc.) exists that would benefit from Cron Monitoring; add
    it only if a genuine candidate exists rather than inventing one.

## Phasing

This is far too large for one PR/one agent (the repo's usual spec-sizing
convention) — phase by Sentry-product breadth, not by platform, since JS +
Rust core (desktop) covers the large majority of users first and mobile
native adds narrower marginal value:

| Phase | Scope | Depends on |
|---|---|---|
| **1 — Foundation** | Consent model + settings UI, shared store-backed toggle, JS `instrument.ts` (error monitoring, tags, basic tracing, breadcrumbs, rate limiting, Release Health/session tracking), JS scrubbers + tests, Rust scrubber extension to Matrix IDs + tests, `PRIVACY.md` + `SENTRY.md` first drafts, confirm Seer is pointed at the new project(s) | None — start immediately |
| **2 — Depth** | Session replay, structured logs (both sides), profiling (JS + evaluate Rust), user feedback flow + screenshot capture, Tauri IPC breadcrumb wrapper, IPC-boundary trace correlation (tag-based, per [Tracing](#tracing) option 2) | Phase 1 (needs the toggle + scrub infra) |
| **3 — Build & mobile** | Build distribution (sourcemaps/dSYMs/Android mapping/Rust debug info) + size analysis CI wiring, native mobile SDK evaluation (Android/iOS) including ANR detection, iOS watchdog terminations, and Mobile Vitals, if Phase 1–2 shows native-layer gaps | Phase 1 (release process needs tags/release naming settled); independent of Phase 2 |

Each phase is itself likely 1-2 PRs, not one — split further at
implementation-planning time once Phase 1's actual diff size is known.

## Acceptance criteria

1. With no settings changed (fresh install), no Sentry event of any kind
   (error, transaction, log, replay, breadcrumb) leaves the app — verified by
   a test asserting `Sentry.init`/`sentry::init` are not called, or are
   called with `enabled: false`, when the toggle is unset.
2. Turning on `sentry_enabled` alone (all sub-toggles off) enables error
   monitoring, tracing, breadcrumbs, tags, and Release Health/session
   tracking — but not replay, profiling, or logs.
3. A test asserting a representative event (containing a Matrix room ID,
   user ID, and a known secret-field string) run through both the JS and
   Rust `beforeSend`-equivalent hooks comes out fully redacted on both sides,
   using the shared fixture file.
4. Session replay respects `maskAllText`/`blockAllMedia`/`maskAllInputs`
   whenever active — verified via Charm 1.0-style Playwright assertions if
   portable, otherwise a documented manual verification step.
5. Release builds (CI) successfully upload sourcemaps (web/desktop JS) and
   the CI job fails loudly (not silently) if the upload step errors — no
   silent swallow of a failed symbolication upload.
5a. (Phase 3) With native SDKs installed, an intentionally-forced ANR
    (Android) and a simulated background termination (iOS, or documented
    manual test if unsimulatable) each produce a Sentry event, and Mobile
    Vitals data (app start time at minimum) appears in the project.
6. `PRIVACY.md` accurately describes every category this spec ships (updated
   if scope changes during implementation — treat doc accuracy as a PR-review
   blocker, not a follow-up).
7. `pnpm lint`, `pnpm fmt:check`, `pnpm typecheck`, `pnpm test:coverage`,
   `pnpm knip`, `pnpm build`, `cargo fmt --check`, `cargo clippy -D
   warnings`, `cargo test` all pass per this repo's quality gate
   (`CLAUDE.md`), for every phase's PR(s).

## Testing

- Unit: JS scrubber tests + Rust scrubber tests against the shared fixture
  (example Matrix IDs, URLs, secret-field strings, and known-safe strings
  that must survive unscrubbed — a false-positive check matters as much as
  the redaction check, since over-scrubbing destroys debuggability).
- Unit: settings store read/write round-trip for the five toggles, including
  the Rust-side early-startup read path.
- Component: consent settings panel (Vitest/RTL) — toggle states, disabled-
  when-parent-off sub-toggles.
- E2E: Playwright smoke test analogous to Charm 1.0's
  `e2e/smoke/observability.spec.ts` — confirm init behavior and scrubbing
  without a live DSN, using `mockTauri.ts`'s fake backend for the Rust side
  of any assertion that needs it.
- Manual: session replay masking, screenshot capture, and user feedback flow
  end-to-end against a real (test/dev) Sentry project before Phase 2 ships —
  these are the categories least amenable to automated assertion of "did the
  actual pixels get masked."

## Dependencies & sequencing

- Independent of Specs 01–07, 09, 11–16, 19 — no shared files.
- **Settings UI location** depends on whichever of Spec 08 (original
  settings) / Spec 18 (global settings IA rework) has landed first — Phase 1
  should build the consent panel against whatever settings shell exists at
  implementation time, not block waiting for 18 if 08's shell is sufficient
  for a new panel.
- Loosely related to Spec 20 (structured Tauri command errors) — if 20 lands
  first, the "capture at IPC boundary vs. at origin" decision in
  [Error monitoring](#error-monitoring) should account for whichever commands already return
  `UiaCommandError`-style structured errors vs. plain strings, but neither
  spec blocks the other.
- Build distribution (Phase 3) depends on Spec 10's native platform shell
  work being far enough along that release build pipelines exist per
  platform to attach an upload step to — confirm CI/release tooling state
  for each platform before starting Phase 3.

## Effort estimate

**XL**, phased as above. Phase 1 alone is **L** (new cross-language scrubber
pair with shared test fixture, cross-process consent storage, new settings
panel, two new docs). Phase 2 is **L** (five more Sentry products, several
with genuine platform-specific unknowns — Document-Policy header behavior in
Tauri's webview, IPC trace propagation). Phase 3 is **M–L** depending on how
much per-platform CI build/release infrastructure already exists to attach
to versus needing to be built from scratch.
