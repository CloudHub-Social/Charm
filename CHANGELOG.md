## 0.1.1 (2026-07-31)

### Features

- Add personal, private message bookmarks and a global "Saved Messages" settings panel (Spec 12), gated behind the default-off `bookmarks` feature flag. ([#294](https://github.com/CloudHub-Social/Charm/pull/294) by @Just-Insane)
- Discover homeserver login choices, render provider-specific SSO actions, and support advertised one-time token login behind the registration and recovery flag. ([#331](https://github.com/CloudHub-Social/Charm/pull/331) by @Just-Insane)
- Show a feature-gated room drop target while attachment files are dragged over chat. ([#279](https://github.com/CloudHub-Social/Charm/pull/279) by @Just-Insane)
- Add feature-gated media captions, upload-size preflight, upload cancellation, GIF autoplay, and default EXIF stripping on upload. ([#302](https://github.com/CloudHub-Social/Charm/pull/302) by @Just-Insane)
- Add forward-to-room, view source, report message, edit history viewing, a reaction "who reacted" tooltip/dialog, and a quick-react emoji row, completing Spec 37's message-action parity with Charm 1.0. All gated behind the existing default-off `message_action_parity` feature flag. ([#300](https://github.com/CloudHub-Social/Charm/pull/300) by @Just-Insane)
- Add a feature-gated action for copying a canonical Matrix permalink to a message. ([#275](https://github.com/CloudHub-Social/Charm/pull/275) by @Just-Insane)
- Add a desktop email password-recovery flow behind the registration and recovery flag. ([#332](https://github.com/CloudHub-Social/Charm/pull/332) by @Just-Insane)
- Add a default-off desktop registration-UIA flow that keeps pending Matrix clients and credentials behind the Tauri boundary while supporting terms, automatic dummy, homeserver fallback, cancellation, and onboarding handoff. ([#330](https://github.com/CloudHub-Social/Charm/pull/330) by @Just-Insane)
- Add feature-gated resend and discard actions for messages that failed to send, using the send-queue's own retry/abort primitives. ([#282](https://github.com/CloudHub-Social/Charm/pull/282) by @Just-Insane)
- Add a feature-gated last-message preview with sender label to room list rows. ([#283](https://github.com/CloudHub-Social/Charm/pull/283) by @Just-Insane)
- Add a persisted display preference for ambient unread message counts in room-list rows. ([#278](https://github.com/CloudHub-Social/Charm/pull/278) by @Just-Insane)
- Add feature-gated space rail management: pin/unpin, reorder, and a per-space context menu (Invite, Add Existing, Mark/Unmark Suggested, Remove, Leave), synced across devices via account data. ([#290](https://github.com/CloudHub-Social/Charm/pull/290) by @Just-Insane)
- Add drag-to-nest and un-nest interactions to the space rail, with cycle feedback and hierarchy reconciliation. ([#333](https://github.com/CloudHub-Social/Charm/pull/333) by @Just-Insane)
- Open spaces in the shared settings shell from the space rail with space-specific controls and labels. ([#334](https://github.com/CloudHub-Social/Charm/pull/334) by @Just-Insane)
- Add feature-gated canonical space-parent APIs and a permission-gated Create subspace action for Spec 33. ([#321](https://github.com/CloudHub-Social/Charm/pull/321) by @Just-Insane)
- Start Spec 39 with a typed timeline-item union that preserves Matrix membership, profile, room state, tombstone, and hidden-state classifications for the upcoming renderer. ([#324](https://github.com/CloudHub-Social/Charm/pull/324) by @Just-Insane)
- Show collapsible membership and room-state notices in timelines behind a default-off feature flag, with matching Appearance controls. ([#336](https://github.com/CloudHub-Social/Charm/pull/336) by @Just-Insane)
- Start Spec 36 with user-profile read contracts for desktop and web plus a default-off surface flag, including room-specific identity, best-effort presence, and privacy-minimal mutual-room summaries. ([#323](https://github.com/CloudHub-Social/Charm/pull/323) by @Just-Insane)
- Add browser-bound companion routes for registration UIA, password recovery, login-flow discovery, and advertised token login. ([#339](https://github.com/CloudHub-Social/Charm/pull/339) by @Just-Insane)

### Fixes

- Confirm message deletion and allow an optional Matrix redaction reason when message-action parity is enabled. ([#277](https://github.com/CloudHub-Social/Charm/pull/277) by @Just-Insane)
- Add an optional All or Unread filter to Home, direct-message, and space room lists. ([#276](https://github.com/CloudHub-Social/Charm/pull/276) by @Just-Insane)
- Fix an N+1 request storm on room load: redact-permission checks now fetch once per room instead of once per unique message sender. ([#287](https://github.com/CloudHub-Social/Charm/pull/287) by @Just-Insane)
- Add web (browser) support for link previews (Spec 29), proxying the homeserver's `/preview_url` endpoint through the companion server. Matches the existing desktop implementation and stays behind the default-off `link_previews` feature flag. ([#273](https://github.com/CloudHub-Social/Charm/pull/273) by @Just-Insane)
- Add message pinning (shared, room-state `m.room.pinned_events`) — pin/unpin from the message action menu, a pinned-messages panel, and a header pin-count badge — behind a default-off `message_pinning` feature flag. ([#293](https://github.com/CloudHub-Social/Charm/pull/293) by @Just-Insane)
- Parallelize the room-list snapshot loop (bounded concurrency) and cache feature-flag reads, cutting login and steady-state sync latency for accounts with many rooms. ([#286](https://github.com/CloudHub-Social/Charm/pull/286) by @Just-Insane)
- Add presence and receipt privacy controls (hide read receipts, hide typing indicators, appear offline, auto-idle) behind a default-off `presence_privacy_controls` feature flag. ([#291](https://github.com/CloudHub-Social/Charm/pull/291) by @Just-Insane)
- Add web companion server routes for room alias management (list/check/add/remove local aliases, set/clear canonical alias, remove alt alias), wiring the `charm-web-server` transport to the same `_impl` functions desktop's Spec 32 already uses behind the `room_alias_management` flag. ([#274](https://github.com/CloudHub-Social/Charm/pull/274) by @Just-Insane)
- Add a room-list sort control (default, activity, A-Z, unread-first) and a typing-in-list indicator, both behind default-off flags. ([#301](https://github.com/CloudHub-Social/Charm/pull/301) by @Just-Insane)
- Clarify that Spec 13's outstanding iOS, Android, and Linux live results are hardware-blocked and remove contradictory historical Android closure wording. ([#327](https://github.com/CloudHub-Social/Charm/pull/327) by @Just-Insane)
- Make Spec 28 decision-ready with a dedicated per-account FTS5 index, explicit plaintext-at-rest boundary, lifecycle rules, and a cursor-based desktop/web API contract. ([#325](https://github.com/CloudHub-Social/Charm/pull/325) by @Just-Insane)
- Add deterministic authenticated Synapse evidence for desktop and web link previews, plus an explicit frontend cache-reuse regression test. ([#328](https://github.com/CloudHub-Social/Charm/pull/328) by @Just-Insane)
- Make Spec 55 decision-ready with navigation-only scope, account-isolated recents, complete keyboard behavior, and a clear dependency on Spec 28 for room search. ([#326](https://github.com/CloudHub-Social/Charm/pull/326) by @Just-Insane)
- Gate SpaceRail's Invite, Add existing, Mark/Unmark suggested, and Remove from space context-menu actions behind the room's actual power level, closing Spec 63's known gap. ([#298](https://github.com/CloudHub-Social/Charm/pull/298) by @Just-Insane)
- Prevent unsafe space-removal actions with fresh parent-space permission checks. ([#320](https://github.com/CloudHub-Social/Charm/pull/320) by @Just-Insane)
- Add a default-off user profile card for message senders and mentions with presence and mutual-room navigation. ([#329](https://github.com/CloudHub-Social/Charm/pull/329) by @Just-Insane)

## 0.1.0 (2026-07-14)

Charm 2.0 is still pre-release. This entry is a placeholder for Knope's
release automation (`knope prepare-release`/`knope release`) — real,
user-facing entries will start accumulating here as changesets land and
get released.
