---
title: "Charm 2.0 Spec — Adopt matrix-sdk-ui Timeline"
type: spec
project: Charm 2.0
created: "2026-07-05"
status: shipped
---

**Workstream:** one PR / one agent. **Tier:** foundational refactor — run *after* the
02/03/05 wave merges and *before* Wave B (composer) and threads (Phase 4).

## Problem & why now

Spec 03 hand-rolled relation-folding in `timeline.rs#events_to_summaries` because
`matrix-sdk-ui` wasn't a dependency. That was a reasonable per-spec scoping call, but it
is a **local optimization that creates global debt**: reimplementing Matrix event
aggregation is a deep, bug-prone problem, and the hand-rolled fold already shipped with
two correctness bugs (duplicate/stuck-"pending" local echoes; relation updates to
already-loaded-but-out-of-batch messages silently dropped). That debt compounds with
every relation-shaped feature — read receipts (Spec 05), edits-of-edits, redacted
reactions, decryption retries, and especially **threads (Phase 4), which are impractical
to hand-roll well.**

`matrix-sdk-ui`'s `Timeline` is the SDK team's supported answer — it does aggregation,
local-echo/send-state, ordering, out-of-order/backfill handling, decryption retries,
pagination, and read receipts, and tracks spec changes upstream. Charm 2.0's *original*
Spec 03 said "strongly prefer adopting the SDK's `Timeline` API", so this is a **return
to the intended architecture**, not a new bet. Do it before Wave B and threads deepen the
dependency on the hand-rolled fold and make the migration more expensive.

## Current state (in repo)

- `src-tauri/src/matrix/timeline.rs` — hand-rolled `events_to_summaries()` (two-pass fold
  over `room.messages()` output), `get_timeline_page()` (`MessagesOptions::backward()` +
  `response.end` cursor), and the `RoomMessageSummary`/`TimelinePage`/`RoomTimelineUpdate`
  DTOs (Spec 03's shape; Spec 02 adds `media: Option<MediaContent>`).
- `src-tauri/src/matrix/mod.rs` — sync loop calls `events_to_summaries()` per batch and
  emits `timeline:update`; `spawn_send_queue_listener` emits `send_queue:update`.
- `src-tauri/src/matrix/actions.rs` — edit/redact/react/reply via `room.send_queue()` /
  `room.redact()`.
- `src/features/rooms/ChatShell.tsx` — holds a **client-invented optimistic echo**
  (`local-${Date.now()}`) and reconciles by id; this is the source of the echo bug.
- `src-tauri/Cargo.toml` — depends on plain `matrix-sdk` (sqlite + e2e-encryption)
  **only; `matrix-sdk-ui` is not a dependency.**

## Scope (in)

1. Add the **`matrix-sdk-ui`** dependency (timeline feature), version-matched to the
   pinned `matrix-sdk`.
2. Replace `events_to_summaries` + `room.messages()` pagination + the hand-rolled echo
   with a **per-room `matrix-sdk-ui` `Timeline`**: hold one per open room, subscribe to
   its diff stream, and re-snapshot its items into `Vec<RoomMessageSummary>` to drive the
   existing `timeline:update`.
3. Back `get_timeline_page` with `Timeline::paginate_backwards`.
4. Map `EventTimelineItem` → `RoomMessageSummary` **keeping the DTO shape stable** (incl.
   Spec 02's `media` field and Spec 03's action/state fields).
5. **Delete the frontend optimistic-echo hack** — local echoes now come from the
   Timeline's `send_state` items, pushed via `timeline:update`.
6. Keep the **IPC contract stable** (`RoomMessageSummary`, `timeline:update`,
   `get_timeline_page`) so Specs 02/05/06 are not disrupted — the one allowed tweak is the
   `get_timeline_page` paging sentinel (see Design).
7. Decide the fate of `send_queue:update` (Timeline surfaces `send_state` per item, making
   it redundant for the message list — keep only if a global outbox UI needs it).

## Non-goals (out)

- **Changing the `RoomMessageSummary` DTO / IPC contract** beyond the documented
  `get_timeline_page` paging tweak — explicitly stable so downstream specs don't churn.
- New timeline *features* (thread UI, read-receipt rendering, day dividers, jump-to-date)
  — those are their own specs; this is a like-for-like engine swap that *enables* them.
- Reworking the action commands' Matrix semantics (edit/redact/react/reply keep their
  `send_queue`/`redact` calls; only the *echo/render* path changes).
- Event-cache/persistence tuning beyond what `Timeline` needs; multi-account.

## Design & approach

### Dependency & per-room Timeline lifecycle
- Add `matrix-sdk-ui` (same workspace release as `matrix-sdk` — pin exactly).
- Build a `Timeline` via `room.timeline().await` (the `TimelineBuilder`). Hold live
  timelines on `MatrixState` in a bounded map `RoomId → Arc<Timeline>` (LRU / explicit
  teardown), built lazily when a room is first opened (`get_timeline_page` / room
  selection). Bounding keeps memory from growing with every room visited — this is the
  main new statefulness the hand-rolled model didn't have.

### Subscription → frontend
- `Timeline::subscribe().await` yields the current `Vector<Arc<TimelineItem>>` plus a
  `Stream<VectorDiff<Arc<TimelineItem>>>`. Spawn a task per live timeline that, on each
  diff (batched), snapshots the current items → `Vec<RoomMessageSummary>` (filtering out
  virtual items like day dividers / read markers) and emits `timeline:update`. Whole-vector
  re-snapshot per batch is O(n) and fine at Day-1 room sizes; pushing `VectorDiff`s
  directly is a later optimization for very large rooms (noted, not required).

### Pagination
- `get_timeline_page` calls `timeline.paginate_backwards(limit)` and returns the current
  snapshot. Timeline pagination is **stateful** (no opaque cursor), so `TimelinePage`'s
  `next_cursor` changes meaning: keep the field but treat it as a **sentinel** (`Some("")`
  / a token = "more available", `None` = start reached), or switch to `has_more: bool`.
  This is the single allowed IPC-contract tweak; the frontend passes `next_cursor` back
  opaquely today, so the change is small — document it.

### EventTimelineItem → RoomMessageSummary mapping
- `event_id` ← `item.event_id()`; `transaction_id` ← `item.transaction_id()` (**this is
  what fixes the echo bug — the local echo and its remote event share the txn**).
- `sender`/`timestamp_ms` ← `item.sender()` / `item.timestamp()`.
- `body`/`formatted_body`/`media` ← `item.content()` (`TimelineItemContent::Message` →
  msgtype; text → body/formatted; media msgtypes → Spec 02's `media` field).
- `edited` ← content edited flag; `redacted` ← `TimelineItemContent::RedactedMessage`.
- `reactions` ← `item.reactions()` aggregated into `ReactionGroup` (`key`, `count`,
  `reacted_by_me` via own user).
- `in_reply_to` ← content in-reply-to detail → `ReplyRef` (target resolved from the
  timeline).
- `send_state` ← `item.send_state()` (`NotSentYet` → `Pending`, `Sent` → `Sent`,
  `SendingFailed{error}` → `Error{message}`).
- Encrypted/UTD items → a placeholder body; Timeline retries decryption when keys arrive
  and re-emits.

### Echo path deletion
- Remove `ChatShell`'s `local-${Date.now()}` optimistic echo and its bespoke reconcile.
  `handleSend` just calls the send command; the Timeline emits the echo as an item with
  `send_state = Pending`, which arrives via `timeline:update` and is replaced in place by
  the remote event on ack. This deletes frontend complexity and resolves both the echo and
  out-of-batch-relation bugs. Reaction toggle may optionally use `Timeline::toggle_reaction`.

### `send_queue:update`
- With per-item `send_state` on the timeline, the separate `send_queue:update` event is
  redundant for the message list. Recommend removing it from the ChatShell path (Timeline
  drives send state) and keeping it only if a future global "outbox" UI needs cross-room
  send-queue status. Decide and document.

## Acceptance criteria

1. `matrix-sdk-ui` is a dependency; a per-room `Timeline` backs both `get_timeline_page`
   and the live `timeline:update`.
2. Sending a message shows **exactly one** bubble that transitions `pending → sent` (no
   duplicate, no stuck "pending") — verified against the local Synapse.
3. Reacting to / editing / redacting a message that's already loaded but **older than the
   current sync batch** updates it in place.
4. The `RoomMessageSummary` / `timeline:update` IPC shape is unchanged (bindings
   diff-clean apart from the documented `get_timeline_page` paging tweak); `ChatShell`'s
   optimistic-echo code is deleted.
5. Backward pagination via `get_timeline_page` works and correctly reports start-reached.
6. Edits, reactions, redactions, and replies render with parity to Spec 03's behaviour,
   now sourced from `Timeline`.
7. Encrypted/UTD events render a placeholder and update once keys arrive (decryption
   retry).
8. Live timelines are bounded (LRU/teardown) — memory doesn't grow unbounded with rooms
   visited.
9. Full gate green: `cargo fmt`/`clippy`/`test`, `pnpm` gate, and the bindings drift check.

## Testing

- **cargo integration (local Synapse):** send → single echo → `sent`; react to an old
  (out-of-batch) message → updates in place; edit/redact parity; pagination reaches start;
  a two-client decrypt/UTD case.
- **cargo unit:** `EventTimelineItem → RoomMessageSummary` mapping over fixture items
  (send_state, edited, redacted, reactions aggregation, reply ref, media variant).
- **vitest:** `ChatShell` renders purely from `timeline:update` (no client-side echo);
  sending shows one bubble via the pushed echo; the reconcile replaces the echo with the
  remote event.
- Retire Spec 03's `events_to_summaries` folding tests (that function is deleted); move
  the equivalent behavioural assertions to the Timeline-mapping layer. Storybook stories
  are unaffected.

## Dependencies & sequencing

- **Runs after the 02/03/05 wave merges** — it builds on their merged DTO shape (Spec 02's
  `media` field, Spec 05's `RoomSummary`/receipt work) and replaces Spec 03's
  `events_to_summaries`/`get_timeline_page` internals + retires the frontend echo hack.
- **Before Wave B (composer) and threads (Phase 4)** — threads are impractical to
  hand-roll, so land the engine swap first.
- **Synergy with Spec 05:** `Timeline` also exposes per-item read receipts, so Spec 05's
  receipt rendering can later source from `Timeline` too (not required here, but note it so
  05 isn't re-hand-rolled on top of this).

## Risks & open questions

- **Stateful per-room Timeline lifecycle + memory bounding** is the main new complexity
  (the "second subsystem" Spec 03 was wary of). Mitigate with a small cap on live
  timelines + explicit teardown on room close.
- **`get_timeline_page` paging semantics change** (stateful pagination, not an opaque
  cursor) — the one allowed IPC tweak; keep `next_cursor` as a sentinel or switch to
  `has_more: bool`.
- **Version pinning:** `matrix-sdk-ui` must match the pinned `matrix-sdk` release exactly
  (same workspace version) or the shared types won't line up.
- **Whole-vector re-snapshot per diff** is O(n) per update — fine at Day-1 sizes; revisit
  with direct `VectorDiff` push for very large rooms.
- **`send_queue:update` fate** — keep-for-global-outbox vs. remove; decide during
  implementation.
- Coordinate the `RoomMessageSummary` **media mapping** with whoever merged Spec 02.

## Effort estimate

**M–L** — the item→DTO mapping and command reuse are moderate; the genuinely new work is
the per-room `Timeline` lifecycle/subscription bridge and its memory bounding, plus
deleting/rewiring the echo path and migrating Spec 03's tests. Contained because the IPC
DTO stays stable, so no downstream spec has to change.
