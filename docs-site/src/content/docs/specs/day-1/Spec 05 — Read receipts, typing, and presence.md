---
title: "Charm 2.0 Spec — Read receipts, typing, and presence"
type: spec
project: Charm 2.0
created: "2026-07-04"
status: shipped
---

**Workstream:** one PR / one agent. **Tier:** Day-1 launch-critical.

## Problem & why now

The sync loop in `src-tauri/src/matrix/mod.rs` currently pushes `room_list:update` and
`timeline:update` and nothing else. Every ephemeral/receipt signal a real Matrix client
shows is missing: you cannot see whether anyone has read your message, whether someone is
typing, or whether a contact is online, and Charm never tells the homeserver that *you*
have read a room. That last gap is the load-bearing one — without an outgoing read
receipt + fully-read marker, `RoomSummary.unread_count` (fed by
`room.unread_notification_counts().notification_count` in `snapshot_rooms`) never clears,
so the room list's unread badge (`RoomListItem.tsx`) is permanently stuck once a
notification count is non-zero. The room-list-organization spec's "jump to unread"
invariant depends entirely on the fully-read marker being written correctly from here.
This is table-stakes presence-of-mind signalling and it must ship Day 1.

## Current state (in repo)

- `src-tauri/src/matrix/mod.rs` — `spawn_sync_loop` consumes `response.rooms.joined` only
  for `timeline.events`; `response.ephemeral` (receipts, typing) and `response.presence`
  are dropped on the floor. `snapshot_rooms` reads `unread_notification_counts()` but
  nothing ever sends a receipt to decrement it.
- `src-tauri/src/matrix/timeline.rs` — `RoomMessageSummary {event_id, sender, body,
  timestamp_ms}`; no read state attached.
- `src/features/rooms/ChatShell.tsx` — renders a flat message list, no read-receipt
  avatars, no typing row, no presence dot on the header.
- `src/features/rooms/RoomListItem.tsx` — unread badge driven solely by
  `room.unread_count`.
- `src/lib/matrix.ts` — hand-mirrored bindings; events wired via `listen(...)` helpers
  (`onTimelineUpdate`, `onRoomListUpdate`, `onSyncState`). No `src/bindings/` dir exists
  yet — ts-rs export is not wired into a build step (noted in the file header), so this
  spec must both add the Rust `#[ts(export)]` types **and** their hand-mirror until the
  export step lands.
- `src-tauri/src/lib.rs` — `invoke_handler![...]` registers each command explicitly; new
  commands must be added there.

## Scope (in)

1. **Outgoing read receipts + read marker** — on room view / scroll-to-bottom, send
   `m.read` (public) or `m.read.private` (per a privacy setting) plus the `m.fully_read`
   marker to the latest visible event.
2. **Incoming read receipts** — individual and aggregated `m.receipt`, rendered as an
   avatar stack anchored at each user's last-read event in `ChatShell`.
3. **Typing** — send own `m.typing` while composing; render "X is typing…" for others.
4. **Presence** — broadcast own presence (online / unavailable / offline + status
   message); display other users' presence (header dot + room-list, DM-relevant).
5. New commands, typed events, and ts-rs IPC types for all of the above.

## Non-goals (out)

- Threaded receipts / per-thread read state (main timeline thread only;
  `ReceiptThread::Main`). Threads are a later spec.
- Read-receipt *privacy UI* beyond a single public/private toggle default.
- Presence aggregation heuristics / "last active N minutes ago" formatting polish beyond a
  basic relative string.
- Server-side presence on homeservers that disable it (Synapse `presence.enabled: false`)
  — degrade gracefully, do not error.
- Typing-driven UI animations; a plain text row is sufficient Day 1.

## Design & approach

### Rust modules / matrix-rust-sdk APIs

New module `src-tauri/src/matrix/ephemeral.rs` (receipts + typing + read markers) and
`src-tauri/src/matrix/presence.rs`, both `mod`-declared in `matrix/mod.rs` and registered
in `lib.rs`.

**Receipts & read marker** (`matrix_sdk::Room`):
- Send: `room.send_single_receipt(ReceiptType::Read, ReceiptThread::Main, event_id)` and
  `ReceiptType::ReadPrivate`; batch the read+fully-read case with
  `room.send_multiple_receipts(Receipts::new().public_read_receipt(id).fully_read_marker(id))`
  (`matrix_sdk::room::Receipts`). `ReceiptType`/`ReceiptThread` from
  `matrix_sdk::ruma::events::receipt`.
- Read *own* current markers on load: `room.load_user_receipt(ReceiptType::Read,
  ReceiptThread::Main, user_id)` → `Option<(OwnedEventId, Receipt)>`.
- Incoming: in the `sync_with_callback` closure, iterate `update.ephemeral` and match
  `AnySyncEphemeralRoomEvent::Receipt(ev)`; `ev.content` is a `ReceiptEventContent`
  (`BTreeMap<EventId, BTreeMap<ReceiptType, BTreeMap<UserId, Receipt>>>`). Flatten to
  per-event `{user_id, receipt_type, ts}` and emit.
- Unread clearing: `snapshot_rooms` already surfaces `unread_notification_counts()`; after
  a successful receipt send the next sync updates it, so no manual decrement — but also
  read `room.num_unread_messages()` / `room.is_marked_unread()` so the room-list spec can
  cross-reference (kept in this spec's `RoomSummary` extension only if that spec hasn't
  landed first; otherwise defer the struct change there to avoid a merge collision).

**Typing** (`matrix_sdk::Room`):
- Send: `room.typing_notice(true)` / `room.typing_notice(false)` (SDK debounces/refreshes
  the EDU timeout internally). Drive from `ChatShell` textarea `onChange` (throttled) and
  clear on send/blur.
- Incoming: match `AnySyncEphemeralRoomEvent::Typing(ev)` in the sync closure;
  `ev.content.user_ids: Vec<OwnedUserId>`. Filter out our own user id before emit.

**Presence** (partial SDK support — use ruma request + sync field):
- Broadcast: build `ruma::api::client::presence::set_presence::v3::Request::new(user_id,
  PresenceState::{Online,Unavailable,Offline})` with optional `status_msg`; send via
  `client.send(request).await`. `PresenceState` from `matrix_sdk::ruma::presence`.
- Incoming: `response.presence` is a `Vec<Raw<PresenceEvent>>` on the sync response;
  deserialize each `PresenceEvent`, read `content.presence`, `content.status_msg`,
  `content.last_active_ago`, `content.currently_active`. Also register a
  `client.add_event_handler(|ev: PresenceEvent| ...)` as the ongoing feed rather than
  re-scanning every sync response manually.
- Auto-away is out of scope; own-presence is set explicitly via command (and once on
  login to `Online`).

### New commands

Registered in `src-tauri/src/lib.rs`:
- `ephemeral::send_read_receipt(room_id, event_id, private: bool)` → sends read +
  fully-read marker (private toggles `Read` vs `ReadPrivate`; fully-read always sent).
- `ephemeral::send_typing(room_id, typing: bool)`.
- `ephemeral::mark_room_read(room_id)` — convenience: resolve latest event id, send
  receipts + fully-read (used by the room-list "mark read" action too).
- `presence::set_presence(state: PresenceStateDto, status_msg: Option<String>)`.
- `presence::get_presence(user_id)` — one-shot read for a header/DM (best-effort;
  `Ok(None)` when the server disables presence).

### New emitted events (narrow, one per concern)

- `receipts:update` → `ReceiptUpdate { room_id, receipts: Vec<EventReceipt> }` where
  `EventReceipt { event_id, user_id, receipt_type: "read"|"read_private", ts_ms }`.
- `typing:update` → `TypingUpdate { room_id, user_ids: Vec<String> }` (full replace, not
  delta — `m.typing` is already a full set).
- `presence:update` → `PresenceUpdate { user_id, presence: "online"|"unavailable"|
  "offline", status_msg: Option<String>, last_active_ago_ms: Option<u64> }`.

### ts-rs IPC types

All `#[derive(TS)] #[ts(export, export_to = "../src/bindings/")]`:
`ReceiptUpdate`, `EventReceipt`, `TypingUpdate`, `PresenceUpdate`, `PresenceStateDto`
(enum, `#[serde(rename_all = "snake_case")]` to match the `SyncStateEvent` tagging style).
Hand-mirror each in `src/lib/matrix.ts` with `onReceiptsUpdate`, `onTypingUpdate`,
`onPresenceUpdate` `listen(...)` helpers plus `sendReadReceipt`, `sendTyping`,
`markRoomRead`, `setPresence`, `getPresence` `invoke(...)` wrappers, following the exact
pattern already in that file.

### Frontend components / hooks / atoms + surfaces changed

- New `src/features/rooms/useReadReceipts.ts` (or Jotai atom-family keyed by `room_id`)
  holding `Map<event_id, user_id[]>` fed by `onReceiptsUpdate`; a derived
  `lastReadByUser` selector places each avatar at that user's newest read event.
- New `src/features/presence/presenceAtoms.ts` — atom-family keyed by `user_id`, fed by
  `onPresenceUpdate`.
- `ChatShell.tsx`:
  - Send read receipt when a room becomes active and when the scroll container is at the
    bottom (IntersectionObserver on the last message), calling `markRoomRead`/
    `sendReadReceipt`. Debounce to the newest rendered `event_id`.
  - Render a right-aligned avatar stack (reuse `Avatar`/`AvatarFallback`,
    `roomDisplay.initials/avatarColor`) beneath the last event each user has read.
  - Add a typing row above the composer ("Alice is typing…" / "Alice and Bob are
    typing…"), driven by the typing atom; call `sendTyping(true/false)` from the textarea
    `onChange` (throttled ~4s refresh) and on send/blur/unmount.
  - Header: presence dot next to `displayName` for DM rooms.
- `RoomListItem.tsx` — optional small presence dot for DM rooms (behind the DM detection
  the profiles/room-list spec provides; gate so it no-ops until then).

## Acceptance criteria

1. Opening a room with a non-zero unread badge sends `m.read` + `m.fully_read` to the
   latest event; after the next sync `RoomSummary.unread_count` for that room is `0` and
   the `RoomListItem` badge disappears.
2. With the privacy toggle on "private", `send_read_receipt(private=true)` sends
   `m.read.private` (verifiable via the account's receipt state) and no public `m.read`.
3. A read receipt from another user for event E causes their avatar to render at E in
   `ChatShell`; a later receipt for event F moves that single avatar to F (never
   duplicated across E and F).
4. Aggregated receipts (multiple users on one event) render as a stacked avatar cluster,
   capped with a "+N" overflow.
5. Typing in the composer emits `m.typing true`, stops emitting `false` on send/blur, and
   another client observing the room sees the typing state appear and clear.
6. An incoming `m.typing` for other users renders the typing row; our own user id never
   appears in it.
7. `set_presence("online", "at keyboard")` broadcasts; another user's client reading
   presence sees `online` + the status message via `presence:update`.
8. On a homeserver with presence disabled, `get_presence` returns `Ok(None)` and
   `set_presence` does not surface an error to the UI.
9. All new IPC payloads are ts-rs `#[ts(export)]` types and their `src/lib/matrix.ts`
   hand-mirror is byte-compatible (field names/casing match the serde output).

## Testing

- **Rust (`cargo test`, network-gated against local Synapse, mirroring the `pub fn` +
  `tests/` pattern used for `resolve_alias`)**: `tests/ephemeral.rs` — two clients in a
  shared room; client A sends a message, client B calls `send_read_receipt`, assert A's
  `room.load_event_receipts(Read, Main, event_id)` includes B. `mark_room_read` clears
  `num_unread_messages`. Typing: B `typing_notice(true)`, assert A's sync ephemeral
  carries B's user id. Presence round-trip (skipped/`#[ignore]` when server presence
  off).
- **Rust unit**: pure mappers (`ReceiptEventContent` → `Vec<EventReceipt>`, presence enum
  ↔ `PresenceStateDto`) tested in-module like `extract_sso_callback_state`.
- **Vitest + RTL** (`ChatShell.test.tsx`, `useReadReceipts.test.ts`): feed synthetic
  `receipts:update` / `typing:update` events, assert avatar placement moves with the
  latest read event, typing row text pluralizes, own-user filtering. Coverage floor
  enforced.
- **Storybook + axe**: read-receipt stack and typing row stories; contrast/labels pass.

## Dependencies & sequencing

- Independent of Spec 06 except the shared `RoomSummary` extension for unread/marked-read
  fields — coordinate which PR lands the struct change first (whichever merges first owns
  it; the second rebases). The fully-read-marker write here is the *producer* of Spec 06's
  "jump to unread" invariant.
- No new crates; all APIs are in the pinned `matrix-sdk`. Uses the existing
  `sync_with_callback` closure and `add_event_handler` — no sync-loop rearchitecture.
- ts-rs export step is still manual; this spec keeps the hand-mirror discipline.

## Risks & open questions

- **Presence is weakly supported server-side and in the SDK.** Many homeservers disable
  it; must fail soft. Open question: broadcast own presence on an interval, or only on
  explicit change + login? (Proposed: on change + login only, Day 1.)
- **Receipt spam / battery** from firing a receipt on every scroll tick — must debounce to
  the newest settled event id, not per-frame.
- **Fully-read vs. read divergence**: sending only `m.read` without `m.fully_read` breaks
  Spec 06's unread invariant. Always send both from `mark_room_read`.
- **Aggregated receipt volume** in large rooms could bloat `receipts:update`; may need to
  cap to receipts for events currently in the loaded timeline window.
- Own-echo suppression for typing relies on knowing our `user_id` in Rust — available via
  `client.user_id()`; confirm it is filtered server-side or client-side (client-side to be
  safe).

## Effort estimate

**M** — three self-contained signal types over the existing sync closure and command/
event patterns; the fiddly parts are receipt-avatar placement in `ChatShell` and
debounced outgoing receipts, not the Rust plumbing.
