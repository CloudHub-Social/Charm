---
title: "Charm 2.0 Spec — User feedback categorization and GitHub label mapping"
type: spec
project: "Charm 2.0"
created: "2026-07-10"
status: in-progress
sidebar:
  label: "User feedback categorization"
---

## Implementation status

**Follow-up required.** [PR #165](https://github.com/CloudHub-Social/Charm/pull/165)
shipped the required Bug / Feature request selector and the
`charm.feedback.category` Sentry tag. The acceptance criterion that maps those
categories to GitHub labels is still an owner-operated Sentry organization change;
the PR explicitly records that no end-to-end label mapping was configured or
verified. This spec is therefore not complete yet.

:::note[Historical baseline]
The repository-state analysis below predates PR #165. Keep it as design history,
not as a statement of current UI behavior.
:::

**Workstream:** single PR. **Tier:** fast-follow to [Spec 21 — Sentry observability](/specs/day-1/spec-21--sentry-observability-error-monitoring-tracing-replay-logs/) (owner request, 2026-07-10, prompted by [issue #162](https://github.com/CloudHub-Social/Charm/issues/162)).

## Problem & why now

Spec 21 shipped a Sentry User Feedback widget (`src/observability/instrument.ts`,
`ObservabilityPanel.tsx`) that is an undifferentiated free-text form. Sentry's
GitHub integration auto-creates a GitHub issue for every feedback item and every
new error issue, always labeled `bug` — visible on
[issue #162](https://github.com/CloudHub-Social/Charm/issues/162), which is a UX
nit ("persistent emoji bar wastes space"), not a bug, but landed labeled `bug`
with `author: sentry` and no way to tell at a glance which of the two it is.

This makes the GitHub issue tracker noisy: triage can't distinguish "something
is broken" from "please add/change this" without opening every issue. Fixing it
requires two things working together: the app must let the user say which kind
of feedback this is, and that signal must actually reach the GitHub issue's
label — which depends on Sentry's own GitHub integration config, not just app
code.

## Current state (verified 2026-07-10)

- `src/observability/instrument.ts` wires `Sentry.feedbackIntegration` (the
  floating widget) and a manual `openSentryFeedbackDialog()` path (used by
  `ObservabilityPanel.tsx`'s "Send feedback" button). Both create Sentry's
  default form: name/email/message/screenshot, no category field.
  `beforeSendFeedback` already tags every submission with
  `charm.feedback.surface` (`settings` | `manual` | widget default) and
  `charm.feedback.screenshot: "optional"` — so there's precedent for adding a
  category the same way.
- GitHub issue creation is Sentry's "Notify via GitHub" integration, configured
  at the Sentry organization level, not in this repo. Issue
  #162 shows it fires for feedback items (not just error issues) and applies a
  fixed `bug` label with no observed per-item variation.

**Re-verified 2026-07-10 (later same day)**: no category field, tag, or
label-mapping code exists anywhere in the repo (grepped `category`,
`bug_report`, `feature_request`, `label` across `src/observability/` and
`.github/`) — this spec's "Current state" above was accurate and remains
fully unimplemented, unlike Specs 23/24 which turned out partially built.

**Shipped 2026-07-11** — merged via
[PR #165](https://github.com/CloudHub-Social/Charm/pull/165) ("Add required
feedback category and GitHub label mapping"). Touched `SENTRY.md`,
`ErrorFallback.tsx`(+test), `ObservabilityPanel.tsx`(+test),
`instrument.ts`(+test), new `FeedbackCategoryField.tsx`, and
`e2e/settings.spec.ts`. Not yet re-diffed against this spec's acceptance
criteria in detail — worth a follow-up pass to confirm the GitHub-side label
mapping (criterion 3, the Sentry-org config step) was actually completed and
not just the in-app category field/tag.

## Non-goals

- **Free-text-to-category inference.** The user picks the category explicitly;
  no NLP/heuristic classification of the message text.
- **Changing what triggers GitHub issue creation** (e.g. filtering out
  low-signal feedback from auto-creating an issue at all) — separate concern
  from labeling, not in scope here.
- **A general-purpose custom label taxonomy.** Two categories only (Bug,
  Feature request) for v1 — a third bucket (e.g. "Question") is a future
  consideration if data shows real demand, not designed in now.
- **Retroactively relabeling existing Sentry-created issues** (like #162) —
  this spec only changes behavior for feedback submitted after it ships.

## Design & approach

### Category field

Add a required single-select to the feedback form: **Bug** / **Feature
request**. Sentry's `feedbackIntegration` supports custom form fields via
`formConfig`/tags — confirm exact API against the installed `@sentry/react`
version (check `instrument.ts`'s current integration options object) rather
than assuming the same shape as vanilla Sentry docs, since the form is also
opened programmatically via `createForm()` for the manual path and both entry
points need the same field.

Store the selection as a tag, following the existing pattern:
`charm.feedback.category: "bug" | "feature_request"`, set in the same
`beforeSendFeedback` hook alongside `charm.feedback.surface`.

### GitHub label mapping

**Open question, engineering — verify before implementing the mapping.**
Investigate exactly how Sentry's GitHub integration decides which label(s) to
apply when auto-creating an issue from feedback:

1. Check the Sentry project settings → Integrations → GitHub,
   and any associated Alert Rules (issue #162's fixed `bug` label likely comes
   from a default alert-rule action, e.g. "When feedback is received → Create
   a GitHub issue with label `bug`" — alert rules can reference issue
   tags/fields as label inputs on some Sentry plans, but this needs confirming
   against the org's actual plan/integration version, not assumed).
2. If Sentry's alert-rule action supports templating the label from a tag
   value (e.g. `{{ tags.charm.feedback.category }}` → `bug` or
   `enhancement`), configure two alert rules (or one templated rule) mapping
   `charm.feedback.category` → GitHub label — **this is Sentry org
   configuration, not app code**, done directly in the Sentry UI once the tag
   exists, mirroring how Spec 21 scoped "Sentry Dev Toolbar" / GitHub triage
   config as owner-side setup rather than repo work.
3. If Sentry's integration does *not* support per-item dynamic labeling (e.g.
   it only supports one fixed label per alert rule action, full stop), the
   fallback is two separate alert rules filtered on
   `charm.feedback.category = bug` vs `= feature_request`, each creating an
   issue with a different fixed label. Still owner-side Sentry config, not
   app code, but confirm the filter condition is actually evaluable against a
   feedback-event tag (vs. only error-event tags) before assuming this works —
   feedback events and error events aren't always exposed identically to
   alert-rule conditions across Sentry versions.
4. If neither mechanism works for feedback events specifically (only for
   error issues), the last resort is a Sentry-side webhook/integration (e.g.
   a small serverless function relabeling the created GitHub issue after the
   fact) — **treat this as an explicit escalation, not the default plan**; it
   adds a new piece of infrastructure to maintain and should only be built if
   1–3 are confirmed impossible.

Confirm which of 2/3/4 applies by testing against a scratch feedback
submission and observing the resulting GitHub issue before writing this up as
done — don't assume based on Sentry's general docs, since GitHub-integration
label behavior has changed across Sentry versions and plans.

Target GitHub labels: reuse the repo's existing `bug` label for Bug category;
use `enhancement` for Feature request (confirm this label exists in
`CloudHub-Social/Charm`'s label set — create it if not, as part of this
spec's setup, not as a silent assumption).

## Scope (in) — summary

1. Add category field (Bug / Feature request) to both feedback entry points
   (widget + `openSentryFeedbackDialog()` manual path).
2. Tag submissions with `charm.feedback.category`.
3. Confirm and configure Sentry-org-side GitHub label mapping per
   [GitHub label mapping](#github-label-mapping) (owner-side Sentry config, documented here for
   traceability, not a code change).
4. Ensure `enhancement` label exists on `CloudHub-Social/Charm`.
5. Update `SENTRY.md` (from Spec 21) with a short note on the category tag and
   where the Sentry-side mapping lives, so a future contributor doesn't have
   to rediscover the org config from scratch.

## Acceptance criteria

1. Both feedback entry points require picking Bug or Feature request before
   submission; no way to submit without a category.
2. A test (Vitest/RTL) asserts `beforeSendFeedback` sets
   `charm.feedback.category` correctly for each selection.
3. Manually submitted test feedback of each category produces a GitHub issue
   labeled `bug` or `enhancement` respectively (manual verification against a
   real Sentry project — not automatable without a live GitHub integration).
4. `pnpm lint`, `pnpm fmt:check`, `pnpm typecheck`, `pnpm test:coverage`,
   `pnpm knip`, `pnpm build` all pass per `CLAUDE.md`'s quality gate.

## Dependencies & sequencing

- Depends on Spec 21's feedback flow (shipped) — pure extension, no
  conflicting files expected.
- Independent of [Spec 23 — User feedback client context capture](/specs/day-1/spec-23--user-feedback-client-context-capture/) and
  [Spec 24 — Build and release identification](/specs/day-1/spec-24--build-and-release-identification-short-sha-pr-previews/),
  though Spec 23's richer context (platform, version) is useful supporting
  information on the same GitHub issues this spec labels — fine to land in
  either order.

## Effort estimate

**S.** Form field + tag + a Sentry-org config step; no new infrastructure
unless step 4 of [GitHub label mapping](#github-label-mapping) is required (escalate scope then).
