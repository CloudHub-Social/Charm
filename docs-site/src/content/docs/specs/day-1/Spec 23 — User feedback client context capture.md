---
title: "Charm 2.0 Spec — User feedback client context capture"
type: spec
project: "Charm 2.0"
created: "2026-07-10"
status: draft
---

**Workstream:** single PR. **Tier:** fast-follow to [Spec 21 — Sentry observability](/specs/day-1/spec-21--sentry-observability-error-monitoring-tracing-replay-logs/) (owner request, 2026-07-10).

## Problem & why now

When a user submits feedback via the Sentry widget today
(`src/observability/instrument.ts`), the only structured context attached is
`charm.feedback.surface` and `charm.feedback.screenshot` (both set in
`beforeSendFeedback`). Build/version, platform/OS, and any related recent
errors or logs are not attached. Triaging a report today requires asking the
user follow-up questions for basic facts (what version, what platform, was
this near a crash) that the client already knows at submission time.

## Current state (verified 2026-07-10)

- `src-tauri/src/lib.rs:179` sets Sentry `release` via
  `sentry::release_name!()` (Cargo-version-derived) on the Rust side;
  `vite.config.ts:41` sets JS-side release from `SENTRY_RELEASE` env or
  `npm_package_version` at **build time** — but neither is exposed to the
  running app's JS layer as a readable value the feedback flow can attach as
  a tag today (they configure the SDK's own `release` field, which Sentry
  already associates with every event including feedback — so version is
  arguably already captured implicitly via the event's release field, not
  duplicated as a separate visible tag).
- No explicit `platform`/`os` tag exists yet (Spec 21 planned one — check
  whether it shipped in Phase 1 before assuming it's still missing; if it
  shipped, feedback events already inherit it for free since tags set at
  `Sentry.init` apply to every event type unless overridden).
- No "attach recent logs" option — Spec 21's Phase 2 (logs) may or may not
  have shipped; if it has, `enableLogs`-collected breadcrumbs/logs are not
  currently surfaced to the user as an attachable artifact on feedback
  specifically (Sentry does correlate feedback with recent breadcrumbs
  automatically via session context, but confirm this is actually true for
  the feedback product specifically, not just error events, before treating
  it as already solved).
- `AboutPanel.tsx` shows `packageJson.version` only — no build/commit
  identifier at all (see [Spec 24 — Build and release identification](/specs/day-1/spec-24--build-and-release-identification-short-sha-pr-previews/),
  which this spec depends on for a human-meaningful build tag).

**Re-verified 2026-07-10 (later same day)** — resolving the hedges above:
- The `platform` tag **did** ship (Spec 21 Phase 1), but only as a fixed
  string: `Sentry.setTag("platform", "webview")` in `instrument.ts`. It does
  **not** distinguish OS (macOS/Windows/Linux/Android/iOS) — no
  `std::env::consts::OS` or Tauri OS-plugin tag exists on the Rust side
  either. Genuinely still open work, not just "check if it shipped."
- `associatedEventId` **is** already wired at the one error-adjacent entry
  point that exists: `ErrorFallback.tsx:26-27` passes
  `associatedEventId: sentryEventId`. `ObservabilityPanel.tsx`'s manual
  "Send feedback" button correctly does *not* pass one (it isn't
  error-adjacent). So item 3 of [Scope summary](#scope-in--summary) is effectively
  already done — no other call sites exist to audit.
- Version *is* already implicitly on every event via Sentry's `release`
  field (confirmed both sides wire a release: `instrument.ts`'s `release()`
  reads `VITE_SENTRY_RELEASE` at runtime, and `src-tauri/src/lib.rs` uses
  `sentry::release_name!()`), but there's no explicit `charm.build.version`
  tag as a separate, more-discoverable field — still open as scoped.

## Non-goals

- **Building a new logs UI or log viewer** — if logs need to be attached,
  reuse whatever Spec 21 Phase 2 already captures (breadcrumbs/Sentry Logs),
  don't build a separate in-app log buffer.
- **User-facing display of the captured metadata before submission** beyond a
  simple confirmation ("this report includes: version X, platform Y") — not a
  full editable/redactable preview UI. If the team later decides users should
  be able to review/strip attached context before sending, that's a separate,
  larger consent-UX spec, not silently folded in here.
- **Capturing anything Spec 21's PII scrubbing already excludes** (Matrix
  IDs, tokens, secrets) — this spec attaches *more* client metadata, not a
  bypass of existing scrub rules. Any new field goes through the same
  `beforeSendFeedback`/scrub pipeline as everything else.

## Design & approach

### What to attach

| Field | Source | Notes |
|---|---|---|
| App version | `packageJson.version` (JS) / `CARGO_PKG_VERSION` (Rust, already used for `release_name!()`) | Already implicit via Sentry's `release` field on the event; add as an explicit `charm.build.version` tag anyway so it's visible without cross-referencing the release dropdown in Sentry's UI |
| Build identifier (short SHA / PR number) | Whatever [Spec 24 — Build and release identification](/specs/day-1/spec-24--build-and-release-identification-short-sha-pr-previews/) lands as the canonical build-time constant | Depends on Spec 24 shipping first — see [Dependencies & sequencing](#dependencies--sequencing) |
| Platform/OS | Tauri's `@tauri-apps/plugin-os` (or equivalent already-used API — check what Spec 21's `platform` tag used, reuse the same source) | `macos`/`windows`/`linux`/`android`/`ios` |
| Environment | Existing `environment` tag from Spec 21 (`dev`/`preview`/`production`) | Already set at init; feedback events inherit it, no new work if confirmed |
| Recent related error, if any | `associatedEventId` (already a supported option on `openSentryFeedbackDialog`, per `SentryFeedbackDialogOptions` in `instrument.ts`) | **Done, verified 2026-07-10.** `ErrorFallback.tsx` (the only error-adjacent entry point) already passes it; `ObservabilityPanel.tsx`'s manual entry point correctly doesn't. No remaining work here. |
| Recent logs/breadcrumbs | Sentry's automatic breadcrumb-on-feedback correlation, if confirmed working (see [Current state](#current-state)) | No new capture code if Sentry already does this; otherwise scope an explicit "attach last N breadcrumbs" step reading from whatever ring buffer Spec 21's logs work introduced |

### Implementation shape

Extend the `beforeSendFeedback` hook in `instrument.ts` (same place
`charm.feedback.surface`/`charm.feedback.screenshot` are already set) to add
`charm.build.version`, `charm.build.id` (from Spec 24), and `charm.platform`
tags. No new UI needed for automatically-attached fields — they're invisible
metadata, same as the existing two tags. Add one line of confirmation text to
the feedback form ("Includes your app version and platform") so the capture
isn't silent to the user, matching the spirit of Spec 21's screenshot-caption
precedent (`ObservabilityPanel.tsx`'s existing description text about
screenshots not being scrubbed).

## Scope (in) — summary

1. `charm.build.version`, `charm.build.id`, and a real per-OS
   `charm.platform` tag (replacing the current fixed `"webview"` value)
   added in `beforeSendFeedback`.
2. `environment` already flows onto feedback events (set at `Sentry.init`,
   confirmed 2026-07-10) — no work needed. The existing `platform` tag also
   already flows through, but needs replacing per item 1, not just
   confirming.
3. ~~Audit existing `openSentryFeedbackDialog(...)` call sites for
   `associatedEventId` usage~~ — **done, verified 2026-07-10**:
   `ErrorFallback.tsx` already passes it, `ObservabilityPanel.tsx` correctly
   doesn't. No remaining work; kept here only for traceability.
4. One-line disclosure text update in the feedback form/`ObservabilityPanel.tsx`.
5. Verify (manually, against a real Sentry project) whether breadcrumb/log
   correlation on feedback events already happens automatically; if not,
   scope a minimal "attach last N breadcrumbs" step as a fast-follow rather
   than blocking this spec on it.

## Acceptance criteria

1. A submitted feedback item's Sentry event contains `charm.build.version`,
   `charm.build.id`, `charm.platform` tags with correct values for the build
   it was submitted from (manual verification against a real/test Sentry
   project).
2. Unit test asserting `beforeSendFeedback` sets these tags given known env
   inputs.
3. Feedback opened from `ErrorFallback.tsx` (or any other error-adjacent
   entry point) includes `associated_event_id` linking to the originating
   error.
4. `pnpm lint`, `pnpm fmt:check`, `pnpm typecheck`, `pnpm test:coverage`,
   `pnpm knip`, `pnpm build` all pass per `CLAUDE.md`'s quality gate.

## Dependencies & sequencing

- **Depends on [Spec 24 — Build and release identification](/specs/day-1/spec-24--build-and-release-identification-short-sha-pr-previews/)**
  for `charm.build.id` — implement Spec 24 first, or land this spec's other
  tags first and add `charm.build.id` once Spec 24's constant exists (don't
  block the whole spec on Spec 24 if it's more convenient to sequence the
  other way).
- Builds on Spec 21 (shipped) — extends the same `beforeSendFeedback` hook,
  no new infrastructure.
- Complements [Spec 22 — User feedback categorization and GitHub label mapping](/specs/day-1/spec-22--user-feedback-categorization-and-github-label-mapping/)
  — the richer context this spec adds is useful on the same GitHub issues
  Spec 22 labels, but neither spec blocks the other.

## Effort estimate

**S.** Mostly tag additions to an existing hook — the `associatedEventId`
audit is already confirmed complete (2026-07-10), so that's off the plate
entirely. The only genuine unknown left is confirming Sentry's automatic
breadcrumb-on-feedback behavior, which is a manual verification step, not
implementation work.
