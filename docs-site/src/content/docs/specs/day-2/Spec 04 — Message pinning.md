---
title: Charm 2.0 Spec — Message pinning
type: spec
project: Charm 2.0
created: 2026-07-13
status: shipped
---

**Workstream:** one PR / one agent. Small, sits next to Spec 07's room management
surface.

## Problem & why now

`m.room.pinned_events` lets room members (with sufficient power level) pin
important messages for easy reference — Charm 1.0 has a `RoomPinMenu` for this.
Charm 2.0 has no pin action and no pinned-messages view, so any room relying on
pinned rules/links/announcements loses that context entirely when viewed in Charm
2.0.

## Non-goals

- Not per-user pins (a personal bookmark concept) — that's the separate Bookmarks
  spec (day-2 Spec 12). This is the shared, room-state `m.room.pinned_events`
  concept, visible to everyone in the room.

## High-level design

- `MessageActions` (Spec 03's action menu) gets a "Pin"/"Unpin" entry, gated by the
  power level required for `m.room.pinned_events` (reuse Spec 07's power-level
  check pattern), toggling membership of the event ID in the room's pinned list.
- Room header/info panel gets a "Pinned messages" entry (reuse the right-panel slot
  pattern established for member list/thread drawer) showing all currently pinned
  messages in order, each with a jump-to-message action (reuse the same scroll-to
  mechanism reply-click and search-result-click use).
- A pin count badge on the room header when 1+ messages are pinned, so pinned
  content isn't only discoverable by opening the panel.

## Data flow

Pin/unpin is a single state-event send (`m.room.pinned_events` with updated
`pinned` array) — no new sync-side plumbing since room state already flows through
existing channels. `RoomDetails.pinned_event_ids` is read straight off
`Room::pinned_event_ids()` (already-synced room state, no network round-trip) and
rides the existing `room_details:update` push, so the pinned-messages panel and the
header's pin-count badge update themselves the same way every other `RoomDetails`
field already does — no dedicated `pinned_events:update` event was needed.

There is no pre-existing `get_event_by_id`-style command: reply-preview resolution
(`ReplyRef`) resolves through `matrix-sdk-ui`'s in-memory `TimelineDetails` on an
already-loaded `EventTimelineItem`, which only covers events inside the currently
loaded timeline window. A pinned message is routinely *outside* that window (pinned
long ago, or in a room whose timeline hasn't been scrolled back that far), so this
spec adds a new `get_pinned_messages(room_id)` command that resolves each pinned
event id via `matrix_sdk::Room::load_or_fetch_event()` (checks the local event
cache first, falls back to a homeserver `GET /rooms/{room_id}/event/{event_id}`
on a miss) rather than reusing the reply mechanism. An event id that fails to
resolve (deleted room, network error, history-visibility denial) still comes
back as a row — a placeholder with `is_unresolved: true` — rather than being
dropped from the result: a silently-omitted row would leave a pin the user has
no way to remove, since the Unpin control lives on the row itself.

The pinned-messages panel's jump-to-message action is routed through the same
parent-owned `jumpTarget`/`jumpToEventId` mechanism Spec 12's Saved Messages
bookmark jumps already use, not a `ChatShell`-owned imperative ref (the panel
renders in the separate `rightPanel` layout slot — a sibling of `ChatShell`, not a
child of it, so `ChatShell` itself has no ref for a sibling to call into).
`RoomsScreen` sets `{roomId, eventId}` state on click; `ChatShell` tries
`messages.findIndex` first for a plain in-loaded-window `scrollToIndex`, falling
back to `loadTimelineAroundEvent(room_id, eventId)` (server-side `/context`
pagination) when the target isn't in the currently-loaded window — the common
case for a pin from well before the loaded history. This also means a pinned-
message jump gets the same pagination fallback bookmark jumps do, which the
earlier no-op-outside-the-loaded-window imperative-ref approach never had.

## API/contract changes

Three new IPC commands:

- `pin_event(room_id, event_id)` / `unpin_event(room_id, event_id)` — granular,
  not a single `set_pinned_events(room_id, event_ids[])`. matrix-sdk's own
  `Room::pin_event`/`Room::unpin_event` already do the fetch-current-list-then-
  append read-modify-write internally (falling back to a network fetch if the
  list isn't in local state yet), so a granular command avoids stacking a
  *second*, frontend-driven read-modify-write race on top of that: two clients
  concurrently pinning two different messages won't clobber each other's change
  the way a last-write-wins full-array `set_pinned_events` could, since each
  granular call re-reads the list at send time rather than the frontend computing
  the full desired array ahead of time from a possibly-stale snapshot.
- `get_pinned_messages(room_id)` — resolves `RoomDetails.pinned_event_ids` into
  full `PinnedMessageSummary`s (sender, preview, timestamp, redacted/undecrypted
  flags) for the panel.

`RoomDetails` gained `pinned_event_ids: string[]` and `RoomPermissions` gained
`set_pinned_events: boolean` (the `m.room.pinned_events` power-level check, same
pattern as every other `set_*` permission field).

## Testing strategy

- Frontend: `MessageActions` gates Pin/Unpin on `canPin` and swaps label based on
  `isPinned` (`MessageActions.test.tsx`); `ChatShell` wires the header pin badge,
  drawer toggle, and pin/unpin calls end-to-end against `RoomDetails.can` and
  `pinned_event_ids` (`ChatShell.test.tsx`); `PinnedMessagesPanel` lists resolved
  messages in order, jumps on click, and renders empty/error/redacted states
  (`PinnedMessagesPanel.test.tsx`); `useMessageActions`' `handlePin`/`handleUnpin`
  are unit-tested directly.
- Rust: `pin_event`/`unpin_event` assert the exact PUT body sent for
  `m.room.pinned_events` (append/remove, not a blind overwrite);
  `get_pinned_messages` resolves multiple pinned events in order and drops one
  that fails to resolve rather than failing the whole call (`room_admin.rs`'s
  `#[cfg(test)]` module).

## Trade-offs

- **Granular `pin_event`/`unpin_event` vs a single `set_pinned_events(room_id,
  event_ids[])`**: implemented granular. matrix-sdk 0.18's `Room::pin_event`/
  `Room::unpin_event` already perform the read-modify-write themselves, so a
  granular IPC surface avoids adding a second, coarser race window on top of an
  SDK primitive that already avoids one — see "API/contract changes" above for
  the concurrent-pin scenario this avoids. The corresponding downside (documented
  rather than hit in practice): if a caller ever needed to *reorder* the pinned
  list without adding/removing anything, granular commands can't express that —
  day-1 has no such UI, so this wasn't a real constraint here.

## What I'd revisit as this grows

- None anticipated — this is a small, complete feature at the scope above.

## Related documentation

- [Spec 37: message action parity](/specs/day-1/spec-37--message-action-parity/)
  owns the contextual pin and unpin entry points.
- [Bookmarks and saved messages](../spec-12--bookmarks-and-saved-messages/)
  provides the private, user-scoped counterpart to room-visible pins.
- [Spec 07: room management](/specs/day-1/spec-07--room-management-and-moderation/)
  defines the permissions and moderation context.
