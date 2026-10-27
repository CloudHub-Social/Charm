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
