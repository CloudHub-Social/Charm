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
- Reveal actions through pointer hover, keyboard focus, or a normal text tap.
  Preserve long-press and add keyboard/pointer context-menu entry to the existing menu.
- Preserve existing Matrix action permissions, local-echo rules, and menu dismissal.

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
