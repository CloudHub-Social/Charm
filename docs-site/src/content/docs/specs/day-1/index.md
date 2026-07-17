---
title: Charm 2.0 — Day-1 Spec Index
type: index
project: Charm 2.0
created: 2026-07-04
status: active
---

This is the implementation-status index for Charm's primary product specs. The
status of each spec was reconciled against merged pull requests and the current
repository on **2026-07-14**.

Status meanings:

- **Shipped** — the scoped implementation is merged. A default-off rollout flag
  may still keep a newly shipped feature in preview.
- **Follow-up** — a meaningful portion is merged, but at least one acceptance
  criterion or required external verification remains.
- **In progress** — implementation or required verification is active.
- **Planned** — no merged implementation matching the spec was found.

The detailed pages preserve their original problem statements and design rationale.
On shipped pages, a current implementation-status block distinguishes that history
from the code that exists today. The [live roadmap](/product/roadmap/) adds open
GitHub work and refreshes nightly; it does not override reviewed status recorded
here.

## Foundation and core experience

| # | Spec | Status | Evidence |
|---|---|---|---|
| 01 | [Timeline identity and profiles](/specs/day-1/spec-01--timeline-identity-and-profiles/) | **Shipped** | [#22](https://github.com/CloudHub-Social/Charm/pull/22) |
| 02 | [Media and attachments](/specs/day-1/spec-02--media-and-attachments/) | **Shipped** | [#10](https://github.com/CloudHub-Social/Charm/pull/10) |
| 03 | [Message actions](/specs/day-1/spec-03--message-actions-edit-redact-reply-react/) | **Shipped** | [#11](https://github.com/CloudHub-Social/Charm/pull/11) |
| 04 | [Composer upgrade](/specs/day-1/spec-04--composer-upgrade-rich-text-slash-commands-autocomplete/) | **Shipped** | [#15](https://github.com/CloudHub-Social/Charm/pull/15) |
| 05 | [Read receipts, typing, and presence](/specs/day-1/spec-05--read-receipts-typing-and-presence/) | **Shipped** | [#9](https://github.com/CloudHub-Social/Charm/pull/9) |
| 06 | [Spaces and room-list organization](/specs/day-1/spec-06--spaces-and-room-list-organization/) | **Shipped** | [#14](https://github.com/CloudHub-Social/Charm/pull/14) |
| 07 | [Room management and moderation](/specs/day-1/spec-07--room-management-and-moderation/) | **Shipped** | [#21](https://github.com/CloudHub-Social/Charm/pull/21) |
| 08 | [Settings and device management](/specs/day-1/spec-08--settings-and-device-management/) | **Shipped** | [#18](https://github.com/CloudHub-Social/Charm/pull/18) |
| 09 | [Theming and appearance](/specs/day-1/spec-09--theming-and-appearance/) | **Shipped** | [#27](https://github.com/CloudHub-Social/Charm/pull/27) |
| 10 | [Native platform shell](/specs/day-1/spec-10--native-platform-shell/) | **Shipped** | [#28](https://github.com/CloudHub-Social/Charm/pull/28) |
| 11 | [Push notifications](/specs/day-1/spec-11--push-notifications/) | **Shipped** | [#44](https://github.com/CloudHub-Social/Charm/pull/44) |
| 12 | [First-run onboarding](/specs/day-1/spec-12--first-run-onboarding/) | **Shipped** | [#30](https://github.com/CloudHub-Social/Charm/pull/30) |
| 13 | [Voice-video platform spike](/specs/day-1/spec-13--voice-video-platform-spike/) | **In progress** | Code fixes [#229](https://github.com/CloudHub-Social/Charm/pull/229), [#230](https://github.com/CloudHub-Social/Charm/pull/230); Android, iOS, and Linux still need recorded hardware/display verification in the [findings](/specs/day-1/spec-13-findings--voice-video-platform-spike/) |
| 14 | [Adopt matrix-sdk-ui Timeline](/specs/day-1/spec-14--adopt-matrix-sdk-ui-timeline/) | **Shipped** | [#12](https://github.com/CloudHub-Social/Charm/pull/12) |
| 15 | [Per-account store isolation](/specs/day-1/spec-15--per-account-store-isolation/) | **Shipped** | [#13](https://github.com/CloudHub-Social/Charm/pull/13) |
| 16 | [Web client via companion Matrix server](/specs/day-1/spec-16--web-client-via-companion-matrix-server/) | **Shipped** | [#45](https://github.com/CloudHub-Social/Charm/pull/45), [#49](https://github.com/CloudHub-Social/Charm/pull/49), [#55](https://github.com/CloudHub-Social/Charm/pull/55), [#98](https://github.com/CloudHub-Social/Charm/pull/98) |
| 17 | [Room settings IA rework](/specs/day-1/spec-17--room-settings-ia-rework-match-charm-10-structure/) | **Shipped** | [#53](https://github.com/CloudHub-Social/Charm/pull/53) |
| 18 | [Global settings IA rework](/specs/day-1/spec-18--global-settings-ia-rework-match-charm-10-structure/) | **Shipped** | [#57](https://github.com/CloudHub-Social/Charm/pull/57) |
| 19 | [Space hierarchy and room-list rebuild](/specs/day-1/spec-19--space-hierarchy-and-room-list-rebuild-match-charm-10-structure/) | **Shipped** | [#99](https://github.com/CloudHub-Social/Charm/pull/99), [#102](https://github.com/CloudHub-Social/Charm/pull/102), [#150](https://github.com/CloudHub-Social/Charm/pull/150), [#153](https://github.com/CloudHub-Social/Charm/pull/153) |
| 20 | [Structured UIA errors](/specs/day-1/spec-20--structured-uia-error-type-for-settings-commands/) | **Shipped** | [#60](https://github.com/CloudHub-Social/Charm/pull/60) |
| 21 | [Sentry observability](/specs/day-1/spec-21--sentry-observability-error-monitoring-tracing-replay-logs/) | **Shipped** | [#81](https://github.com/CloudHub-Social/Charm/pull/81), [#83](https://github.com/CloudHub-Social/Charm/pull/83), [#85](https://github.com/CloudHub-Social/Charm/pull/85), [#87](https://github.com/CloudHub-Social/Charm/pull/87), [#91](https://github.com/CloudHub-Social/Charm/pull/91), [#93](https://github.com/CloudHub-Social/Charm/pull/93), [#94](https://github.com/CloudHub-Social/Charm/pull/94), [#95](https://github.com/CloudHub-Social/Charm/pull/95), [#96](https://github.com/CloudHub-Social/Charm/pull/96), [#97](https://github.com/CloudHub-Social/Charm/pull/97); later hardening is documented in the [runbook](/operations/sentry/) |
| 22 | [Feedback categorization and GitHub label mapping](/specs/day-1/spec-22--user-feedback-categorization-and-github-label-mapping/) | **Follow-up** | App category/tag shipped in [#165](https://github.com/CloudHub-Social/Charm/pull/165); Sentry-org label mapping and end-to-end verification remain |
| 23 | [Feedback client context](/specs/day-1/spec-23--user-feedback-client-context-capture/) | **Shipped** | [#169](https://github.com/CloudHub-Social/Charm/pull/169) |
| 24 | [Build and release identification](/specs/day-1/spec-24--build-and-release-identification-short-sha-pr-previews/) | **Shipped** | [#166](https://github.com/CloudHub-Social/Charm/pull/166), [#182](https://github.com/CloudHub-Social/Charm/pull/182), [#184](https://github.com/CloudHub-Social/Charm/pull/184) |
| 25 | [Persistent crypto state and recovery verification](/specs/day-1/spec-25--persistent-crypto-state-and-recovery-key-sufficient-verification-web-client/) | **Shipped** | [#172](https://github.com/CloudHub-Social/Charm/pull/172), [#173](https://github.com/CloudHub-Social/Charm/pull/173), [#181](https://github.com/CloudHub-Social/Charm/pull/181), cross-deployment persistence [#247](https://github.com/CloudHub-Social/Charm/pull/247), history recovery [#257](https://github.com/CloudHub-Social/Charm/pull/257) |
| 26 | [Timeline anchoring and bottom-up rendering](/specs/day-1/spec-26--timeline-scroll-anchoring-and-bottom-up-rendering/) | **Shipped** | [#194](https://github.com/CloudHub-Social/Charm/pull/194), [#232](https://github.com/CloudHub-Social/Charm/pull/232); [Phase 2 record](/specs/day-1/spec-26-phase-2--bottom-up-timeline-rendering-follow-up/) |
| 27 | [Chat message layout modes](/specs/day-1/spec-27--chat-message-layout-modes-bubble-discord-irc/) | **Shipped** | [#195](https://github.com/CloudHub-Social/Charm/pull/195) |

## Follow-on product work

| # | Spec | Status | Evidence or boundary |
|---|---|---|---|
| 28 | [Cross-room message search](/specs/day-1/spec-28--cross-room-message-search/) | **Planned** | No matching merged implementation found |
| 29 | [Link previews](/specs/day-1/spec-29--link-previews/) | **Follow-up** | Desktop shipped in [#250](https://github.com/CloudHub-Social/Charm/pull/250); web companion `/preview_url` proxy remains |
| 30 | [Focus mode and DND](/specs/day-1/spec-30--focus-mode-and-do-not-disturb/) | **Shipped** | [#249](https://github.com/CloudHub-Social/Charm/pull/249), default-off flag; manual tray verification remains non-blocking |
| 31 | [Room upgrades](/specs/day-1/spec-31--room-upgrades/) | **Planned** | No matching merged implementation found |
| 32 | [Room alias management](/specs/day-1/spec-32--room-alias-management/) | **Follow-up** | Desktop shipped in [#251](https://github.com/CloudHub-Social/Charm/pull/251); web transport commands remain |
| 33 | [Space nesting and reorganization](/specs/day-1/spec-33--space-nesting-and-hierarchy-reorganization/) | **Planned** | No matching merged implementation found |
| 34 | [Labs settings](/specs/day-1/spec-34--labs-and-experimental-settings-panel/) | **Shipped** | [#253](https://github.com/CloudHub-Social/Charm/pull/253) |
| 35 | [Feature flags](/specs/day-1/spec-35--feature-flags-openfeature--sentry-evaluation-tracking/) | **Shipped** | [#241](https://github.com/CloudHub-Social/Charm/pull/241), [#255](https://github.com/CloudHub-Social/Charm/pull/255), [#256](https://github.com/CloudHub-Social/Charm/pull/256), [#259](https://github.com/CloudHub-Social/Charm/pull/259) |
| 36 | [User profile cards](/specs/day-1/spec-36--user-profile-cards/) | **Planned** | No matching merged implementation found |
| 37 | [Message action parity](/specs/day-1/spec-37--message-action-parity/) | **In progress** | Feature-gated message permalinks and confirmed redaction with optional reasons are implemented; the remaining actions are still planned |
| 38 | [Full emoji picker](/specs/day-1/spec-38--full-emoji-picker/) | **Planned** | No matching merged implementation found |
| 39 | [Timeline state and membership events](/specs/day-1/spec-39--timeline-state-and-membership-events/) | **Planned** | No matching merged implementation found |
| 40 | [Presence and receipt privacy](/specs/day-1/spec-40--presence-and-receipt-privacy-controls/) | **Planned** | No matching merged implementation found |
| 41 | [Voice message recording](/specs/day-1/spec-41--voice-message-recording/) | **Planned** | No matching merged implementation found |
| 42 | [Media send polish](/specs/day-1/spec-42--media-send-polish/) | **In progress** | Feature-gated attachment drag-and-drop target implemented; captions, size preflight, cancellation, GIF controls, and EXIF stripping remain |
| 43 | [Composer parity](/specs/day-1/spec-43--composer-parity/) | **Planned** | No matching merged implementation found |
| 44 | [Crypto backup setup and key import/export](/specs/day-1/spec-44--crypto-key-backup-setup-and-key-import-export/) | **Planned** | Restore exists through Spec 25; setup and import/export remain scoped here |
| 45 | [Registration and password reset](/specs/day-1/spec-45--registration-and-password-reset-flows/) | **Planned** | No matching merged implementation found |
| 46 | [Notification granularity and email pushers](/specs/day-1/spec-46--notification-rule-granularity-and-email-pushers/) | **Planned** | No matching merged implementation found |
| 47 | [Appearance and display parity](/specs/day-1/spec-47--appearance-and-display-parity/) | **Planned** | No matching merged implementation found |
| 48 | [Desktop shell controls](/specs/day-1/spec-48--desktop-shell-and-settings-controls/) | **Planned** | No matching merged implementation found |
| 49 | [Widget support](/specs/day-1/spec-49--widget-support/) | **Planned** | Prerequisite for Day-2 calling |
| 50 | [Cross-device settings sync](/specs/day-1/spec-50--cross-device-settings-sync/) | **Planned** | No matching merged implementation found |
| 51 | [App localization](/specs/day-1/spec-51--app-localization-i18n/) | **Planned** | Stretch / lower priority |
| 52 | [Responsive and mobile-web hardening](/specs/day-1/spec-52--responsive-and-mobile-web-layout-hardening/) | **Shipped** | [#242](https://github.com/CloudHub-Social/Charm/pull/242), [#245](https://github.com/CloudHub-Social/Charm/pull/245); redesign defaults off |
| 53 | [Avatars and presence visuals](/specs/day-1/spec-53--avatars-and-presence-visuals/) | **Planned** | No matching merged implementation found |
| 54 | [Room-list enrichment and sorting](/specs/day-1/spec-54--room-list-row-enrichment-filtering-and-sorting/) | **In progress** | Flag-gated All / Unread filters and optional ambient unread message counts are implemented; sorting and further row enrichment remain |
| 55 | [Command palette and quick switcher](/specs/day-1/spec-55--command-palette-and-quick-switcher/) | **Planned** | No matching merged implementation found |
| 56 | [Room invites](/specs/day-1/spec-56--room-invites-surface/) | **Shipped** | [#243](https://github.com/CloudHub-Social/Charm/pull/243), default-off flag |
| 57 | [Activity and notifications inbox](/specs/day-1/spec-57--in-app-activity-and-notifications-inbox/) | **Planned** | No matching merged implementation found |
| 58 | [Rich message content](/specs/day-1/spec-58--rich-message-content-rendering/) | **Shipped** | [#244](https://github.com/CloudHub-Social/Charm/pull/244), default-off flag |
| 59 | [GIF picker](/specs/day-1/spec-59--gif-picker-klipy/) | **Planned** | No matching merged implementation found |
| 60 | [iOS platform integrations](/specs/day-1/spec-60--ios-platform-integrations/) | **Planned** | No matching merged implementation found |
| 61 | [Android platform integrations](/specs/day-1/spec-61--android-platform-integrations/) | **Planned** | No matching merged implementation found |
| 62 | [Desktop platform integrations](/specs/day-1/spec-62--desktop-platform-integrations-macos-and-windows/) | **Planned** | No matching merged implementation found |
| 63 | [Sidebar and space management](/specs/day-1/spec-63--sidebar-and-space-management-pin-reorder-context-menu-add-existing/) | **Planned** | No matching merged implementation found |

## Cross-cutting rules

- Prefer established libraries for solved parsing, rendering, media, search,
  localization, and formatting problems; document exceptions.
- New user-facing behavior ships behind a default-off [feature flag](/contributing/feature-flags/).
- Update a spec's frontmatter, implementation-status block, and this index in the
  same pull request that changes its completion state.
- Move secondary or power-user scope to the [Day-2 index](/specs/day-2/) only when
  the dependency and sequencing decision is explicit.
