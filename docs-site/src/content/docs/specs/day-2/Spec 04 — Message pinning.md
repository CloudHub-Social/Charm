---
title: Charm 2.0 Spec — Message pinning
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
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
existing channels. Reading the pinned-messages panel resolves each pinned event ID
against already-synced timeline/event-fetch machinery (may need a
`get_event_by_id` IPC call if pinned events aren't already in the locally loaded
timeline window — confirm whether this already exists for reply-preview
resolution, likely does, reuse it).

## API/contract changes

New IPC command `set_pinned_events(room_id, event_ids[])` (or `pin_event`/
`unpin_event` if finer-grained is cleaner given potential concurrent-edit races on
the array). No changes to existing timeline commands.

## Testing strategy

- Frontend: pin/unpin action gated correctly by power level, pinned panel lists
  correct events in correct order, jump-to-message works.
- Rust: `set_pinned_events` sends correct state-event content; concurrent-pin race
  (two clients pinning different messages near-simultaneously) doesn't silently
  drop one — confirm expected last-write-wins semantics match Matrix spec
  expectations and don't surprise users.

## Trade-offs

- **Single set-array command vs pin/unpin granular commands**: granular avoids a
  read-modify-write race client-side (fetch current list, append, send) that the
  single-array approach requires; lean toward granular if the SDK/homeserver
  round-trip cost is acceptable, otherwise document the race explicitly if going
  with array-replace.

## What I'd revisit as this grows

- None anticipated — this is a small, complete feature at the scope above.
