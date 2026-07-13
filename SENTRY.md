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

### Frontend transport on desktop/Android (IPC tunnel)

`src-tauri/tauri.conf.json`'s CSP (`connect-src: 'self' ipc: http://ipc.localhost`)
blocks the webview from reaching Sentry's ingest host directly, so on Tauri
builds `instrument.ts` configures `Sentry.init` with a custom `transport`
(`makeTauriIpcTransport`) instead of the SDK's default fetch-based one. Every
outgoing envelope (errors, sessions, replays, logs, transactions, feedback) is
base64-encoded and sent through the `forward_sentry_envelope` Tauri command,
which re-parses `SENTRY_DSN` on the Rust side and makes the real HTTP request
there — Rust isn't subject to the webview's CSP. The CSP itself is left
unchanged; no `connect-src` allowlist entry for Sentry's ingest host was added.
This only applies `if (isTauri())`; the plain-browser web build (Spec 16, no
CSP) still uses the SDK's normal transport straight to Sentry.

`forward_sentry_envelope` re-checks `observability.json` consent itself
(belt-and-suspenders — the frontend only calls it after its own `Sentry.init`
already checked `settings.sentryEnabled`) and errors if `SENTRY_DSN` is unset,
so a build without Sentry configured never attempts the HTTP request.

### Crash-recovery prompt (opt-in nudge, not a crash report)

Because Sentry itself is consent-gated, a crash before a user ever opts in
produces no report at all — there's nothing to retroactively send. To close
that gap without capturing anything pre-consent, Rust writes a marker file in
the app data directory at process start (`take_previous_session_crash_flag`,
`src-tauri/src/lib.rs`) and removes it on a clean `RunEvent::Exit`
(`mark_clean_exit`). If the marker is still there at the *next* launch, the
previous process crashed or was killed. The frontend (`crashRecovery.ts`,
`CrashRecoveryPrompt.tsx`, wired in `main.tsx`) checks this once at boot via
`had_unclean_previous_session` and, only if Sentry is currently disabled,
shows a one-time dialog inviting the user to turn crash reporting on for next
time. It never claims to send a report for the crash that just happened —
there's no stack trace or event data behind this signal, only "did the last
process exit cleanly."

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

`.github/workflows/release-builds.yml` runs on `v*` tags and manual
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
`SENTRY_ORG`, `SENTRY_PROJECT`, and `VITE_SENTRY_DSN`. `VITE_SENTRY_DSN` is set
on every platform's actual `pnpm tauri build`/`pnpm tauri ios build`/
`pnpm tauri android build` step too (not just the frontend-sourcemap build),
now that the IPC tunnel above means the desktop CSP no longer needs loosening
for the shipped webview bundle to have a working Sentry client — iOS gets it
set as well even though the simulator debug build doesn't consume it yet, so
the frontend build there matches every other platform's env. Manual runs can
override the Sentry release name and environment; tag runs default the release
name to the tag, and manual runs without a release input default to the
commit SHA.

Manual dispatch is safe only after the repository owner has configured the four
required secrets above. A dry repo-side check can validate workflow syntax,
release/env propagation, and build wiring, but it cannot prove Sentry accepted
the sourcemaps, debug files, Android mappings/native symbols, or Size Analysis
build without those secrets and a real workflow run.

Suggested owner-side dispatch for a release candidate:

```sh
gh workflow run release-builds.yml \
  --ref main \
  -f release=charm@2.0.0-rc.1 \
  -f environment=production
```

For a tag release, prefer running from the tag ref and omit `release` so the
workflow uses the tag name:

```sh
gh workflow run release-builds.yml \
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
custom transport or external logging path. The desktop `makeTauriIpcTransport`
(see "Frontend transport on desktop/Android" above) doesn't violate this: it
only forwards envelope bytes the SDK already produced *after* `beforeSend`/
`beforeBreadcrumb`/etc. ran, exactly like the default fetch transport would —
it changes how the bytes leave the process, not what's in them.

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

### Feedback category and GitHub label mapping (Spec 22)

Sentry's GitHub integration auto-creates a GitHub issue from every feedback
submission (and every new error issue), and as configured at the org level it
applied a single fixed `bug` label regardless of content — see
[issue #162](https://github.com/CloudHub-Social/Charm/issues/162), a UX nit
that landed mislabeled `bug`. The installed `@sentry/react` build's
`feedbackIntegration` form has no custom-field support (only
name/email/message/screenshot — confirmed against the bundled widget source,
not just the public docs), so Charm can't add the category as a native Sentry
form field. Instead:

- Both feedback entry points — `ObservabilityPanel`'s "Send feedback" button
  and `ErrorFallback`'s crash-screen button, both routed through
  `openSentryFeedbackDialog` in `src/observability/instrument.ts` — render a
  required Bug / Feature request selector
  (`src/observability/FeedbackCategoryField.tsx`) before the button is
  enabled. There is no way to submit feedback without picking one.
- The selection is threaded through `SentryFeedbackDialogOptions.category` and
  tagged as `charm.feedback.category: "bug" | "feature_request"` in the same
  `beforeSendFeedback` hook that already sets `charm.feedback.surface` and
  `charm.feedback.screenshot`, plus on the `createForm` call's default tags.

**What still needs Sentry-org-side configuration** (cloudhubsocial.sentry.io,
outside this repo, not app code): the `charm.feedback.category` tag exists on
every feedback event once this ships, but nothing on the Sentry side maps it
to a GitHub label yet. Per Spec 22's escalation path:

1. Check the GitHub integration's alert-rule action that creates the issue
   from feedback (Project Settings → Alerts, and Integrations → GitHub) — the
   fixed `bug` label from issue #162 most likely comes from that action's
   configured label, not from Sentry inferring anything from content.
2. If the alert-rule action supports templating the label from a tag value
   (e.g. `{{ tags.charm.feedback.category }}`), configure one templated rule
   (or two rules keyed on the tag) mapping `bug` → GitHub `bug`,
   `feature_request` → GitHub `enhancement`.
3. If per-item dynamic labeling isn't supported, use two separate alert rules
   filtered on `charm.feedback.category = bug` vs. `= feature_request`, each
   creating an issue with a different fixed label — but first confirm the
   filter condition actually evaluates against feedback-event tags in this
   Sentry plan/version (feedback events and error events aren't always exposed
   identically to alert-rule conditions).
4. Only as a last resort — if neither works for feedback events specifically —
   consider a Sentry-side webhook/serverless relabeling step after issue
   creation. This adds new infrastructure to maintain and should not be built
   unless 1–3 are confirmed impossible.

The `enhancement` label already exists on `CloudHub-Social/Charm`, so no
repo-side label creation was needed for this spec. Verify end-to-end by
submitting one test feedback item of each category and checking the resulting
GitHub issue's label — this can't be automated from the app repo.

## Distributed Tracing

Three independent Sentry clients exist in this repo — web frontend
(`src/observability/instrument.ts`), Tauri desktop
(`src-tauri/src/lib.rs`), and `charm-web-server`
(`crates/charm-web-server/src/observability.rs`) — each with its own
`tracesSampleRate`/`traces_sample_rate`. Two of the three legs now share
trace context so a slow or failing operation can be followed end-to-end in
Sentry's trace view instead of appearing as unlinked events:

- **Web frontend → `charm-web-server` (HTTP).** `instrument.ts`'s
  `tracePropagationTargets` includes `VITE_CHARM_WEB_API_BASE_URL` (or
  same-origin when that's unset — the web build's relative-path fallback,
  see `src/lib/matrixTransport.ts`'s `apiBase()`) alongside `localhost`.
  `browserTracingIntegration()` auto-attaches `sentry-trace`/`baggage` to
  every `fetch` call within that origin list — no per-call code needed.
  `charm-web-server`'s axum router (`routes::router()`) layers
  `sentry_tower::SentryHttpLayer::new().enable_transaction()` +
  `NewSentryLayer`, which automatically continues those headers into a
  transaction per request. Layer ordering matters: axum applies `.layer()`
  calls in the opposite order `tower::ServiceBuilder` would, so
  `SentryHttpLayer` is applied _before_ `NewSentryLayer` in the router's
  `.layer()` chain — reversing it silently leaks memory instead of failing
  loudly (per `sentry-tower`'s own docs). `SentryHttpLayer` attaches the raw
  request URL to its transaction (and, as a fallback, to any error event
  captured during the request) — since Matrix room/event/user IDs in a path
  like `/api/rooms/{room_id}/events/{event_id}/edit` are percent-encoded on
  the wire, and `observability_scrub`'s `MATRIX_ID_PATTERN` only matches a
  literal `:`, those IDs would otherwise reach Sentry unredacted despite
  every other Sentry payload in this codebase going through that scrubber.
  `routes.rs`'s `redact_request_uri_for_sentry` middleware rewrites the
  request's URI (path and query) to the matched route template — via
  `MatchedPath`, the same mechanism `record_request_metrics` already uses to
  avoid per-room cardinality — before `SentryHttpLayer` ever reads it,
  fixing both the transaction and the event fallback at their single shared
  source rather than patching each payload after the fact. It must be
  layered as the "outer" neighbor of `SentryHttpLayer` (added _after_ it in
  the `.layer()` chain, given the reversed ordering above) so the rewrite
  happens before `SentryHttpLayer`'s `Service::call` reads the URI —
  `axum`'s `Path`/`Query` extractors are unaffected by this rewrite since
  they read from a separately pre-captured `UrlParams` extension, not from
  `request.uri()` itself, confirmed against `axum`'s own extractor source.
- **Web/desktop frontend → Tauri Rust backend (IPC, not HTTP).** Tauri's
  invoke channel isn't `fetch`/`XHR`, so the browser SDK can't
  auto-instrument it. `src/observability/ipc.ts`'s `invoke()` — the single
  choke point every Tauri command call already flows through for the
  `x-charm-operation-id` header — now also attaches `Sentry.getTraceData()`'s
  `sentry-trace`/`baggage` values as headers on every call. On the Rust
  side, `src-tauri/src/observability_trace.rs`'s `continue_ipc_trace` parses
  those headers back out of a command's `tauri::ipc::Request` and returns a
  `sentry::TransactionContext` to bind for the duration of that command
  (see `matrix::send::send_attachment` for the first wiring). Coverage here
  is intentionally incremental, matching this codebase's existing
  per-command rollout pattern (e.g. `ipc_operation_id`) — not every
  `#[tauri::command]` is wired yet; extend it command-by-command as each is
  touched, prioritizing ones that do real backend work (homeserver calls,
  crypto) over pure local reads.

**Synapse and Sygnal are out of scope for now.** Both run their own
Sentry-instrumented deployments (same Sentry org, separate projects, set up
via the `matrix-docker-ansible-deploy` MDAD playbook) — but reading their
upstream source directly confirms neither configures
`traces_sample_rate`/performance tracing:
`sentry_sdk.init(dsn=..., release=..., environment=...)` in Synapse's
`setup_sentry()` (`synapse/app/_base.py`), and the even more minimal
`sentry_sdk.init(sentrycfg["dsn"])` in Sygnal's `sygnal.py`. Neither is set
up to continue a distributed trace today, so forwarding `sentry-trace`/
`baggage` to them from `charm-web-server` would currently be inert — those
headers would just be ignored. If tracing into Synapse/Sygnal is ever
picked up, it needs upstream changes on their side first (enabling
`traces_sample_rate` and continuing incoming trace headers at their HTTP
entrypoint, which for both means an explicit `continue_trace()`-style call
since they use Twisted directly rather than a framework `sentry_sdk`
auto-instruments) — that's a separate effort against those projects (and,
for the MDAD-managed deployment config, against
`matrix-docker-ansible-deploy-spec16-mdad`), not this repo.

**No Postgres/DB tracing here.** `charm-web-server` has no direct database
of its own — session persistence is an encrypted-object store
(`crates/charm-web-server/src/persistence.rs`), and the only "database"
anywhere in this repo is `matrix-sdk-sqlite`'s internal crypto store, opaque
to our code. Postgres is Synapse's, external to this repo, and covered by
the same "upstream tracing isn't configured yet" gap as the rest of Synapse
above.

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

Spec 22 added the required Bug / Feature request feedback category described
above; the Sentry-org-side GitHub label mapping it depends on is tracked as an
owner follow-up, not shipped in that PR.

Broader Rust tracing/log bridges, NDK/native Android crash capture, Android
Mobile Vitals, and signed iOS device-release dSYMs remain separate follow-up
phases from Spec 21.
Broader per-command Rust instrumentation is still intentionally incremental;
new producers should stay Charm-targeted and avoid raw Matrix identifiers, file
paths, and secrets.
