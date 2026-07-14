---
title: Charm 2.0 Spec — Threads
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
---

**Workstream:** likely 2-3 PRs — thread data/rendering, thread drawer/browser UI,
composer-in-thread. Largest Day-2 gap by UI surface area.

## Problem & why now

Threads (`m.thread` relations, MSC3440/spec-stable) let a reply branch off a
message into its own sub-conversation instead of cluttering the main timeline.
Charm 1.0 has full thread support: a `ThreadBrowser` (list of threads in a room) and
`ThreadDrawer` (focused view of one thread). Charm 2.0 has zero thread UI —
`m.thread` relations either render inline in the main timeline (indistinguishable
from a normal reply) or are ignored, depending on how Spec 14's Timeline adoption
handles unrecognized relation types. This is likely the single most-requested Day-2
gap for any active/busy room, since unthreaded high-traffic rooms become
unreadable.

## Non-goals

- Not thread notifications as a wholly separate settings category in this initial
  phase — thread messages participate in existing per-room notification rules
  (Spec 08); a dedicated "notify me on this thread" per-thread subscription is a
  plausible follow-up, not built now.
- Not thread search — covered by Spec 28 (cross-room search) once it exists;
  threaded messages should be indexed the same as any other message, no special
  thread-scoped search UI in this spec.
- Not migrating/backfilling old unthreaded replies into threads — this only
  concerns messages sent with real `m.thread` relations going forward and any
  already in room history.

## High-level design

### Data

- `matrix-sdk-ui`'s `Timeline` (adopted in Spec 14) has first-class thread support
  in newer SDK versions — confirm current matrix-rust-sdk version's thread API
  surface before designing the IPC layer; prefer using the SDK's own thread-list/
  thread-timeline primitives over hand-rolling relation-folding a second time
  (Spec 14 existed specifically to avoid that).
- Thread membership: a root event plus all events with `m.relates_to: { rel_type:
  "m.thread", event_id: <root> }`.

### Main timeline rendering

- A message that is a thread root shows a "N replies, latest by X" summary chip
  below it (matches Charm 1.0's in-timeline thread summary), clicking it opens the
  thread drawer.
- Messages sent *into* a thread do **not** also appear inline in the main timeline
  (per current Matrix client convention — thread replies are thread-only, not
  duplicated into the main flow) — confirm this matches current spec-recommended
  behavior before implementing, since this has evolved across MSC versions.

### Thread drawer

- Side panel (reuse the existing right-panel slot Spec 07 uses for room
  info/member list — thread drawer is another right-panel mode, not a new
  layout primitive) showing: thread root message, then all thread replies in
  order, with its own composer scoped to `m.thread` relation sends.
- Reuses `MessageRow` (all three Spec 27 layout modes) for individual message
  rendering inside the drawer — no separate message-rendering component.

### Thread browser

- A per-room "Threads" list view (all threads in the room, sorted by latest
  activity), entry point likely next to existing room-info/pinned-messages
  affordances in the room header.

## Data flow

New IPC surface for thread-scoped data: `get_room_threads(room_id) ->
ThreadSummary[]`, `get_thread_timeline(room_id, thread_root_id) ->
RoomMessageSummary[]`, `send_thread_reply(room_id, thread_root_id, content)`. Ideally
these thin-wrap SDK-native thread primitives rather than reimplementing
relation-folding logic that already exists for the main timeline.

## API/contract changes

New IPC commands as above with ts-rs bindings. `RoomMessageSummary` (or equivalent)
likely needs a `thread_root_id: string | null` field so the main-timeline renderer
can detect "this is a thread root, show the summary chip" and "this is a thread
reply, don't render inline" without a second data shape.

## Testing strategy

- Rust: thread-list and thread-timeline correctness against fixture events
  including nested edits/redactions inside a thread.
- Frontend: thread summary chip renders on root, click opens drawer with correct
  ordered replies; thread-scoped composer sends with correct `rel_type`.
- Frontend: thread browser lists all threads in a room sorted by recency.
- Manual: cross-client test — reply-in-thread from Charm 1.0 or Element, confirm
  Charm 2.0 renders it as a thread (not inline), and vice versa.

## Trade-offs

- **Reuse right-panel slot vs a dedicated thread-panel layout**: reuse chosen to
  avoid inventing a second side-panel mechanism; if thread-drawer-open-simultaneously
  -with-room-info turns out to be a real need, revisit as a follow-up (likely rare —
  Charm 1.0 doesn't support both open at once either).

## What I'd revisit as this grows

- Per-thread notification subscriptions if requested.
- Thread-aware unread counts (distinguishing "unread in main timeline" from
  "unread in a thread") if the combined badge count proves confusing in practice.
