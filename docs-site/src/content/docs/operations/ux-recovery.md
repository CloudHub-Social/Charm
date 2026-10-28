---
title: "Conversation UX recovery — implementation evidence"
---

# Conversation UX recovery

This ledger continues Specs 52 and 64 and issues #539/#526. It is not a replacement roadmap.

## Baseline

Research baseline: `e08884843c387c34559c0a1f6a1d30d6cadd3bd1`.
Initial regression commit: `627d53331af3dfe559218acfc13910dd08456e1b`.
[PR #601](https://github.com/CloudHub-Social/Charm/pull/601) owns this bounded repair.

The initial [Quality run](https://github.com/CloudHub-Social/Charm/actions/runs/40586378988)
reproduced geometry assertion failures in Bubble, Modern, and IRC at 320, 375,
390, and 430 CSS pixels. For example, the 320px Bubble case had 72px of row
overflow and its right edge exceeded the viewport by 12px. Document overflow
alone was zero, demonstrating why a page-only assertion would miss the failure.
The initial test also needed formatting and the existing snapshot capture hook;
those test-integration failures are distinct from the reproduced geometry defect.

## Current scope

- Move timeline gutters into measured item content instead of the virtualizer viewport.
- Constrain message rows and Bubble sender/content widths without clipping prose.
- Keep IRC reactions below the text rather than competing for horizontal space.
- Use one bounded, out-of-flow action surface for the three message layouts.
- Reveal actions through pointer hover, native-button keyboard focus, or a normal text tap.
  Preserve long-press and pointer context-menu entry to the existing menu.
- Preserve existing Matrix action permissions, local-echo rules, and menu dismissal.

## Interaction correction and verification

The first action implementation used focusable message containers. Accessibility
lint rejected that markup. The correction keeps messages non-interactive and
focuses the native menu button after a short text tap. Keyboard users reach the
existing action buttons with Tab and activate their native menu behavior.
Cancelled, scrolling, multi-touch, embedded-control, and selection gestures must
not reveal actions or steal focus. A long press that already opened a menu must
not move focus back to its trigger on release.

At `4aa37da6a587d53f40a7920bf0db81251a5411c2`, the
[Quality run](https://github.com/CloudHub-Social/Charm/actions/runs/40593093063)
passed accessibility lint and the browser job, including the geometry matrix,
existing reaction journeys, and new keyboard-entry/focus-return journey.
Storybook build/accessibility also passed. The frontend job stopped at an IRC
formatting difference; typecheck, unit coverage, dead-code checking, and build
were not verified by that run. The
[documentation run](https://github.com/CloudHub-Social/Charm/actions/runs/40593093595)
passed content, build, and site-graph checks after the ledger links were corrected.
These are revision-specific results, not a claim that a later head is qualified.

## Picker and gesture regression follow-up

Exact logs from the 51cc4673 merge run identify two unit failures in
ChatShell.test.tsx and messageActionSurface.test.tsx, not the previously
suspected MessageRow.test.tsx. The integration fixture now supplies a real
one-touch start; the selection fixture clears an existing range and verifies
selected text before asserting that touch release preserves focus.

Test-first commit 3b6c17910f4ae82b6d81f2ba787174aeb1eb5c74, in
[Quality run 40599079756](https://github.com/CloudHub-Social/Charm/actions/runs/40599079756),
passes those two tests and 2,233 unit cases overall; its only unit failure is
the new compact-picker dismissal assertion. Browser regressions separately
show the picker remaining mounted after selection and the action surface
having pointer-events disabled while the portalled picker owns focus.

The repair makes selection dismiss either picker variant and retains action
surface visibility and pointer access for an open Radix trigger. The
cross-popover journey still requires a normal More-actions click to open its
menu and dismiss the picker. No forced clicks, removed journey assertions,
relaxed timeouts, disabled rules, or lowered coverage gates are used.
Record qualification against the subsequent implementation head in PR #601;
the test-first run above is intentionally failing, not release evidence.

## Scroll-boundary review follow-up

Review comment 4395287876 identified that the above-row toolbar can be
clipped at the timeline top or when the start of a tall message has scrolled
out of view. Test-only head c7c6ed6cdf5f74a6582593f52c57e414bfe1d7af,
in [Quality run 40603216306](https://github.com/CloudHub-Social/Charm/actions/runs/40603216306),
reproduced boundary failures while the 126 existing browser cases passed.
Ten cases demonstrated actual clipping; two IRC tall-message fixtures were
subsequently enlarged because IRC collapses newlines and the original body
was not consistently taller than the viewport. The initial fixture iteration was corrected for signed-zero
scroll coordinates and input capability before relying on that evidence.

A shared positioning hook now owns timeline/visual-viewport containment for
the existing action surface. Unit cases cover placement, active scrolling,
resize, portal focus, cleanup, and CSS fallback. The 12 browser cases retain
actual hit testing and ordinary menu clicks. Exact-head CI must qualify the
implementation before the finding is closed.

Eight gallery images changed by the earlier geometry repair were visually
reviewed and copied from the CI-produced feature-docs candidate for 5c2db696.
The feature-docs comparison thresholds are unchanged, and no gallery build
or browser checks were run locally on the owner's Mac.

## Native-content and header review follow-up

Test-only head 5d25a1c4bd952a44cf8b7fca35efb005163a38e6, in
[Quality run 40605792376](https://github.com/CloudHub-Social/Charm/actions/runs/40605792376),
had 2,243 passing unit tests and four expected failures: native summary and
React-portal touches were consumed, and both header states lacked gutters.
The repair excludes native disclosure controls and out-of-row portal targets
from message gestures, and restores header-owned padding without doubling
first-item spacing. Browser cases also exercise real disclosure taps in all
three layouts, in addition to pointer/touch scroll-boundary placement.

The formatter available in the shared checkout was 0.61.0, while this branch
pins 0.71.0. Explicit file edits now use the pinned formatter in write mode;
project manifests and lockfiles are unchanged and checks still run in CI.

## Acceptance and remaining work

Implementation is not release or physical-device acceptance. Record current-head
CI results in PR #601. Its tests cover compact geometry, visible action entry,
and the existing reply/edit/reaction/delete journeys. Native phone/iPad keyboard,
long-press, screen-reader, and multitasking acceptance remain required under #526.

The full reaction-detail redesign, unified composer/voice states, medium layout,
profile rollout, durable drafts, notifications/recovery, threads, and calls remain
separate packages from the approved implementation plan. None is marked complete
by this PR. Do not close #539 or #526 when this bounded repair merges.

All automated verification is performed in GitHub Actions; no local verification
commands are run on the owner's Mac. No dependencies, credentials, production
settings, real-message test data, or Sable resources are changed.
