---
title: Charm 2.0 Spec — Bookmarks and saved messages
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
---

**Workstream:** one PR / one agent.

## Problem & why now

Confirmed via the parity gap analysis as a Charm 1.0 feature Charm 2.0 lacks:
personal, private bookmarks on individual messages ("save this for later"),
distinct from Spec 04's room-pinning (day-2 Spec 04) which is shared/visible to the
whole room. A user wanting to keep a personal reference to a message — a link
someone shared, an important instruction, a joke worth finding again — currently
has no way to do that in Charm 2.0 beyond manually remembering where it was.

## Non-goals

- Not shared/room-visible — bookmarks are private per-user, unlike pinned messages.
  Never send a Matrix event visible to other room members as a side effect of
  bookmarking.
- Not folders/tagging/organization system for bookmarks in Phase 1 — a flat,
  reverse-chronological "Saved messages" list is enough for an initial version;
  organization can be a follow-up if the list grows unwieldy for real users.

## High-level design

- `MessageActions` gets a "Bookmark"/"Save" entry (alongside pin, reply, react,
  edit, redact) — purely local action, no Matrix event sent.
- Storage: local-only, per-account (respecting Spec 15's per-account isolation —
  bookmarks must not leak across accounts in the multi-account switcher scenario
  from day-2 Spec 09). A local table (room_id, event_id, saved_at) in the
  account's existing local store, not synced via Matrix account data in Phase 1
  (keeps this simple and matches "personal, this-device" framing; cross-device
  sync via account data is a plausible richer follow-up, see below).
- Access surface: a "Saved messages" view (global, not per-room — reachable from
  wherever the app's global navigation lives, e.g. near settings/account switcher)
  listing all bookmarked messages across all rooms, newest-saved first, each
  showing room context (which room, sender, timestamp) and a jump-to-message
  action (reuse the same scroll-to mechanism as pins/search/jump-to-date, per the
  established pattern across these specs).
- Removing a bookmark: from either the message's action menu (if still visible in
  its room) or directly from the Saved Messages list.

## Data flow

Entirely local reads/writes against the per-account local store — no new Matrix
sync/send traffic. If a bookmarked event isn't currently loaded in the relevant
room's timeline window when the user jumps to it from the Saved Messages list, this
needs the same "load timeline around an arbitrary event ID" capability that
day-2 Spec 11 (Jump to date) and message-pinning both rely on — implement that
capability once (if it doesn't already exist) and have all three specs share it,
rather than each building its own version.

## API/contract changes

New local-only IPC commands: `add_bookmark(room_id, event_id)`,
`remove_bookmark(event_id)`, `list_bookmarks() -> BookmarkEntry[]`. No Matrix
protocol/event changes.

## Testing strategy

- Frontend: bookmark/unbookmark toggles correctly from message action menu, Saved
  Messages list renders and sorts correctly, jump-to-message from the list works.
- Multi-account isolation test: bookmarks saved under account A never appear when
  account B is active (reuses the same isolation-regression testing pattern as
  day-2 Spec 09).
- Rust: local store CRUD correctness for the new bookmark table.

## Trade-offs

- **Local-only, not synced via account data, for Phase 1**: simpler and avoids
  designing a sync schema/conflict-resolution story before there's evidence users
  want bookmarks to follow them across devices; Charm 1.0's own bookmark feature
  (if it has one — reconfirm the parity analysis's exact scope here) presumably
  set a precedent to match, otherwise default to local-only as the conservative
  starting point.

## What I'd revisit as this grows

- Cross-device sync via Matrix account data if users request bookmarks following
  them between devices — would need a small conflict-resolution design (e.g.
  last-write-wins per bookmark, since bookmark add/remove are simple enough that
  real conflicts should be rare).
- Folders/tags if the flat list becomes unwieldy for heavy users.
