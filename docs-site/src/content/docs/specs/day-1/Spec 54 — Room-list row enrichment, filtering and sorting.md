---
title: Charm 2.0 Spec — Room-list row enrichment, filtering and sorting
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
sidebar:
  label: "Room-list row enrichment"
---

**Workstream:** one PR / one agent (or split rows vs filter/sort). New spec from the
UI-parity deep-dive (2026-07-13). Includes the owner's explicit request: **filter
Home/DMs/Spaces by unread/activity (esp. DMs).**

## Problem & why now

Charm 2.0's room-list rows are information-thin vs Charm 1.0, and the list offers no
filtering or sorting control:

1. **Unread / activity filter (owner's headline request).** Charm 1.0 filters each
   list to unread-only via a category-collapse gesture (`Home.tsx:358-372`,
   `Direct.tsx:322-331`, `Space.tsx:657-678`) — collapsing a section switches to
   unread-first sort and filters to `hasUnread(rId) || selected`. Charm 2.0 has no
   unread/activity filter anywhere (`RoomList.tsx` has only "Show all rooms" and
   "Search everywhere" checkboxes; collapsing sections is visibility-only). Owner
   especially wants "only unread DMs."
2. **Last-message preview + sender label in rows.** Charm 1.0 shows a compact last
   message with sender label (`CompactMessagePreview`, `RoomNavItem.tsx:714-721`;
   on-by-default for DMs). Charm 2.0's `RoomListItem.tsx` shows none — just the room
   name. This is the single biggest information gap in the list.
3. **Typing-in-list indicator.** Charm 1.0 shows a typing badge on the room row
   (`RoomNavItem.tsx:723-727`); Charm 2.0 doesn't.
4. **Ambient unread *message* count.** Charm 1.0's row can show the ambient unread
   message total (not just mentions), honoring a `showUnreadCounts` setting. Charm
   2.0's row shows only `unread_count` (mentions/notifications) as a number or a
   plain dot — even though the backend already carries `unread_messages`
   (`rooms.rs:17`), the row never renders it.
5. **Sort toggle.** Charm 1.0 lets the user switch activity / A-Z / unread-first
   (same category gesture; `utils/sort.ts`). Charm 2.0 has no user-facing sort
   control (ordering is fixed backend-side).
6. **Minor:** room-topic preview alternative; sidebar width resize (`SidebarResizer`
   in 1.0; 2.0 is fixed `w-[280px]`).

## Non-goals

- Not room-list *sectioning* or manual drag-reorder or favourite/low-priority
  tagging — those are confirmed at parity/ahead (prior audit); untouched.
- Not cross-room message search (Spec 28) — the "unread filter" is distinct from
  search.
- Not the group-DM composite avatar / presence ring — Spec 53.

## High-level design

### Filtering + sorting

- Add an **unread/activity filter** control to each list (Home, DMs, Spaces) — a
  toggle/segment ("All" vs "Unread") that filters rows to unread (plus the currently
  selected room, matching 1.0 so the open room doesn't vanish). Especially wire it
  for the DM list.
- Add a **sort control** — activity (recency) / A-Z / unread-first. Charm 1.0
  entangles filter+sort in one gesture; Charm 2.0 can expose them as a small
  filter/sort menu on the list header. Sorting can stay backend-computed (the Rust
  side already sorts) — add a sort-mode parameter the UI sets, or sort frontend-side
  over the summaries; pick per where `roomSections.ts` currently orders.
- Persist the chosen filter/sort (local or synced per Spec 50).

### Row enrichment

- **Last-message preview + sender label**: render a compact preview line under the
  room name. Needs the last message's text + sender in the room summary — confirm
  the `RoomSummary` DTO carries (or can carry) a `last_message` preview; if not,
  extend it (Rust). Truncate properly (`min-w-0`/`truncate`).
- **Typing-in-list**: reuse the typing data (Spec 05) keyed by room to show a typing
  badge on the row.
- **Ambient unread count**: render `unread_messages` (already in the DTO) per a
  `showUnreadCounts` setting, distinct from the mention/highlight badge.
- **Room-topic preview / sidebar resize**: minor, include if cheap.

## Data flow

- Filter/sort are frontend view-state over the existing room summaries (or a
  sort-mode param to the Rust room-list builder). No new sync.
- Last-message preview likely needs a `RoomSummary` extension (last event's
  sender + text snippet) from Rust — the summary is already computed per room, so
  add the preview fields there.
- Typing + ambient unread already exist (typing from Spec 05; `unread_messages` in
  the DTO) — just surfaced.

## API/contract changes

- `RoomSummary` gains `last_message_preview` (sender + snippet) if not present
  (ts-rs regen).
- Optional sort-mode parameter on the room-list read.
- No change for typing/ambient-unread (already available).

## Testing strategy

- Frontend: unread filter hides read rows (keeps selected); DM list "unread" works;
  sort toggle reorders (activity/A-Z/unread-first); rows render last-message preview
  + sender, typing badge, ambient count per setting.
- Rust: room summary carries the last-message preview; sort mode orders correctly.
- Manual: with many rooms, filter to unread DMs (owner's use case) and confirm only
  unread DMs show; confirm previews update live as messages arrive.

## Trade-offs

- **Expose filter/sort as explicit controls vs 1.0's overloaded collapse gesture**:
  explicit controls are clearer than 1.0's "collapsing a section also filters+sorts"
  (which is non-obvious); match the *capability*, improve the *affordance*.
- **Last-message preview in the summary vs a separate per-room fetch**: put it in the
  summary — it's computed per room already and avoids N extra reads for the list.

## What I'd revisit as this grows

- Draft indicator on rows (neither client has it today) if drafts become
  persistent.
- Per-row activity timestamp (neither has it) if requested.
