---
title: "Charm 2.0 Spec — Spaces and room-list organization"
type: spec
project: Charm 2.0
created: "2026-07-04"
status: shipped
---

**Workstream:** one PR / one agent. **Tier:** Day-1 launch-critical.

## Problem & why now

`snapshot_rooms` in `src-tauri/src/matrix/mod.rs` emits a flat, unsorted `Vec<RoomSummary
{room_id, name, unread_count}>` straight from `client.rooms()`, and `RoomList.tsx` renders
it in whatever order the SDK returns. There is no spaces awareness, no favourites /
low-priority separation, no manual ordering, no mute, no mark-read/mark-unread, and — most
importantly — no correct notion of "unread" beyond a raw notification count. On any real
account (which is organized into spaces with dozens of rooms) the current list is unusable.
The roadmap collapses spaces to a simple grouped list initially, but the *grouping and the
unread invariant* are Day-1: getting "genuine unread must always win" wrong is a bug that's
extremely expensive to retrofit because half the UI ends up keyed off the wrong signal.
Build it correctly now.

## Current state (in repo)

- `src-tauri/src/matrix/mod.rs` — `RoomSummary {room_id, name: Option, unread_count}`;
  `snapshot_rooms` maps `client.rooms()` → summaries using
  `unread_notification_counts().notification_count`; `list_rooms` returns them unsorted;
  the sync loop emits `room_list:update` with the same snapshot.
- `src/features/rooms/RoomList.tsx` — fixed 280px `<aside>`, maps `rooms` to
  `RoomListItem` in array order, "No rooms yet" empty state. No sections, no headers.
- `src/features/rooms/RoomListItem.tsx` — avatar + name + numeric unread badge; bold when
  `unread_count > 0`.
- `src/features/rooms/RoomsScreen.tsx` — holds `rooms` state, auto-selects `rooms[0]`,
  handles deep-link room selection.
- `src/lib/matrix.ts` — hand-mirrored `RoomSummary`, `listRooms`, `onRoomListUpdate`.
- No `src/bindings/` dir; ts-rs export not yet wired to a build step.

## Scope (in)

1. **Spaces** — detect space rooms, render the space hierarchy as a **collapsed simple
   list grouped by space** (roadmap: spaces-as-sections, not the full nested tree),
   browse a space's child rooms, and **join** a suggested/child room from a space.
2. **Room ordering** — favourites and low-priority sections, alphabetical within a
   section, and **manual drag reordering** with persisted order.
3. **Room categories / sections** — Favourites / Rooms / Low priority (+ per-space
   groups), collapsible.
4. **Per-room actions** — mute, mark read, mark unread.
5. **"Jump to unread" invariant** — a single authoritative `has_unread` signal where
   genuine unread (unread messages **or** an explicit mark-unread flag) always wins over a
   muted/zeroed notification count.
6. **Knock-to-join** rooms.

## Non-goals (out)

- Full nested space tree UI (expandable sub-spaces within sub-spaces) — collapsed grouped
  list only for Day 1.
- Room *avatars* from `m.room.avatar` / MXC fetching — that lives in the profiles/avatars
  spec; `roomDisplay.ts` keeps its hash-color fallback here.
- Creating spaces / editing `m.space.child` ordering / space admin.
- Cross-account / multi-account room merging.
- Search / filter box over the room list (later).
- Notification *rule* editing beyond a per-room mute toggle.

## Design & approach

### Rust modules / matrix-rust-sdk APIs

Extend `src-tauri/src/matrix/mod.rs` and add `src-tauri/src/matrix/rooms.rs` (org
commands) + optionally `spaces.rs`; register new commands in `src-tauri/src/lib.rs`.

**Extend `RoomSummary`** (the org signals; avatar ref intentionally omitted — profiles
spec):
```
RoomSummary {
  room_id, name, unread_count,          // existing
  unread_messages: u64,                 // room.num_unread_messages()
  is_marked_unread: bool,               // room.is_marked_unread()
  is_muted: bool,                       // notification mode == Mute
  is_favourite: bool,                   // m.favourite tag present
  is_low_priority: bool,                // m.lowpriority tag present
  manual_order: Option<f64>,            // TagInfo.order for the section
  is_space: bool,                       // room.room_type() == RoomType::Space
  parent_space_ids: Vec<String>,        // via m.space.parent / child linkage
  is_direct: bool,                      // room.is_direct() (DM grouping)
}
```
Cross-references Spec 05's `unread_messages`/`is_marked_unread` — coordinate ownership of
the struct change (see Sequencing).

**Tags / favourites / low-priority** (`matrix_sdk::Room`, room account data `m.tag`):
- Read: `room.tags().await` → `Option<Tags>` (`BTreeMap<TagName, TagInfo>`). `TagName`
  from `matrix_sdk::ruma::events::tag`: `TagName::Favorite` (`"m.favourite"`),
  `TagName::LowPriority` (`"m.lowpriority"`), `TagName::User(...)` for custom categories.
  `TagInfo.order: Option<f64>` drives manual ordering.
- Write: `room.set_tag(TagName, TagInfo)`, `room.remove_tag(TagName)`.

**Mute** (`matrix_sdk::NotificationSettings`, push rules):
- `client.notification_settings().await.set_room_notification_mode(room_id,
  RoomNotificationMode::Mute)` and `RoomNotificationMode::AllMessages` to unmute;
  read via `get_user_defined_room_notification_mode(room_id)`.
  `RoomNotificationMode` from `matrix_sdk::notification_settings`.

**Mark read / unread**:
- Mark unread: `room.set_unread_flag(true/false).await` (MSC2867 `m.marked_unread` room
  account data).
- Mark read: delegate to Spec 05's `mark_room_read` (send `m.read` + `m.fully_read` to the
  latest event). If Spec 05 hasn't merged, implement the receipt send here and let Spec 05
  reuse it — one of the two owns it.

**Unread invariant** (`snapshot_rooms`, the single source of truth):
```
has_unread = is_marked_unread
          || (!is_muted && unread_messages > 0)
          || unread_count > 0        // notification count (mentions in muted rooms)
```
Muted rooms with only ambient unread messages don't count; an explicit mark-unread or a
real mention/notification always does. This is the invariant every UI unread indicator and
"jump to unread" reads from — computed once in Rust, never re-derived per-component.

**Spaces / hierarchy** (`m.space.child` / `m.space.parent` state):
- Detect: `room.room_type()` → `Some(RoomType::Space)`. Membership: read `m.space.child`
  state events on each space (child room ids) and `m.space.parent` on rooms; build
  `parent_space_ids`.
- Browse / join-from-space: call the room hierarchy endpoint
  `ruma::api::client::space::get_hierarchy::v1::Request::new(space_id)` via
  `client.send(request)` → children with `room_id`, `name`, `topic`, `num_joined_members`,
  `join_rule`; new command returns them as `SpaceChild` DTOs.
- Join: `client.join_room_by_id(room_id)` (or `join_room_by_id_or_alias`) for a public /
  invited child.

**Knock-to-join** (`ruma` membership):
- `client.knock(room_id_or_alias, reason, server_names)` if the pinned SDK exposes it;
  otherwise `ruma::api::client::knock::knock_room::v3::Request` via `client.send`. Surface
  join-rule `Knock` from the hierarchy response so the UI offers "Request to join".

**Ordering strategy**: sort in Rust in `snapshot_rooms`/`list_rooms` so the frontend
renders a ready list — section (Favourite → Rooms → Low priority), then `manual_order`
(`TagInfo.order`, ascending, `None` last), then alphabetical by `displayName`. (Optionally
adopt `matrix_sdk_ui::room_list_service::RoomListService` with `new_sorter_recency`/
`new_sorter_name` + `new_filter_*` later; not required Day 1 and adds a subscription
surface, so keep the manual snapshot for this PR.)

### New commands (registered in `lib.rs`)

- `rooms::set_room_favourite(room_id, favourite: bool)` (set/remove `m.favourite`).
- `rooms::set_room_low_priority(room_id, low: bool)`.
- `rooms::set_room_muted(room_id, muted: bool)`.
- `rooms::set_room_marked_unread(room_id, unread: bool)`.
- `rooms::set_room_manual_order(room_id, order: f64)` (writes `TagInfo.order`).
- `rooms::mark_room_read(room_id)` (shared with Spec 05).
- `spaces::list_space_children(space_id)` → `Vec<SpaceChild>`.
- `spaces::join_room(room_id_or_alias)` and `spaces::knock_room(room_id_or_alias, reason)`.

### New / changed emitted events

- Reuse existing `room_list:update` (now carries the enriched, pre-sorted `RoomSummary`).
- `space_hierarchy:update` (optional) → re-emit when `m.space.child` state changes; else
  the frontend re-calls `list_space_children` on demand.

### ts-rs IPC types

`RoomSummary` (extended), `SpaceChild {room_id, name, topic, num_joined_members, join_rule:
"public"|"knock"|"invite"|"restricted", is_space}`, all `#[ts(export, export_to =
"../src/bindings/")]`, hand-mirrored in `src/lib/matrix.ts` alongside new `invoke`
wrappers (`setRoomFavourite`, `setRoomLowPriority`, `setRoomMuted`,
`setRoomMarkedUnread`, `setRoomManualOrder`, `markRoomRead`, `listSpaceChildren`,
`joinRoom`, `knockRoom`).

### Frontend components / hooks / atoms + surfaces changed

- `RoomList.tsx` — render **sections**: a space switcher/header row per space plus
  Favourites / Rooms / Low priority collapsible groups (Radix `Collapsible`). Group by the
  Rust-provided fields; do not re-sort in JS (Rust owns order).
- New `src/features/rooms/SpaceSection.tsx` and `SpaceBrowser.tsx` (dialog listing
  `SpaceChild`s with Join / Request-to-join buttons wired to `joinRoom`/`knockRoom`).
- `RoomListItem.tsx` — right-click / kebab context menu (Radix `DropdownMenu`) with
  Favourite, Low priority, Mute, Mark read, Mark unread; a mark-unread dot and a muted
  (bell-off, Lucide `BellOff`) indicator; unread styling now keyed off the single
  `has_unread` field (add it to `RoomSummary`, or derive in Rust) — **not** re-derived
  from `unread_count` in the component.
- **Manual drag reorder** via `@use-gesture/react` (noted in the brief): dragging a room
  within its section calls `setRoomManualOrder` with an interpolated `order` between
  neighbours (fractional-index style, `f64` midpoint), optimistic reorder in a Jotai
  atom-family keyed by `room_id`, reconciled on the next `room_list:update`.
- `RoomsScreen.tsx` — thread the enriched summaries; auto-select logic keeps working
  (first *visible* room). "Jump to unread" affordance reads `has_unread`.

## Acceptance criteria

1. Favouriting a room sets the `m.favourite` tag; it moves into the Favourites section and
   the change survives reload (read back from `room.tags()`).
2. Low-priority tagging moves a room to the Low priority section; a room can't be both (UI
   clears the other tag).
3. Muting a room sets `RoomNotificationMode::Mute`; the room stops contributing ambient
   unread to `has_unread` (mentions still do), and shows a muted indicator.
4. Marking a room unread sets the `m.marked_unread` flag; `has_unread` is true and the
   mark-unread dot shows even with zero unread messages. Marking read clears it and sends
   read + fully-read markers.
5. **Unread invariant**: a muted room with only ambient messages is *not* flagged; the
   same room with an explicit mark-unread *is*; a mention in a muted room *is*. Verified by
   a table-driven test over all combinations.
6. Space rooms render as sections/groups; their child rooms are listed and reflect
   `m.space.child` membership.
7. `list_space_children` returns a space's children with correct `join_rule`; joining a
   public child via `joinRoom` adds it to the room list on the next sync.
8. A `knock`-join-rule child offers "Request to join"; `knockRoom` sends the knock without
   erroring.
9. Manual drag reorders a room within its section and persists via `TagInfo.order`
   (survives reload); reorder does not leak across sections.
10. `list_rooms` / `room_list:update` payloads are pre-sorted by (section, manual order,
    name); the frontend performs no sorting.

## Testing

- **Rust (`cargo test`, local-Synapse-gated, `pub fn` + `tests/` pattern)**:
  `tests/room_org.rs` — set/remove favourite & low-priority tags and read back via
  `room.tags()`; `set_unread_flag` round-trip via `room.is_marked_unread()`; mute via
  `get_user_defined_room_notification_mode`; create a space with a child, assert
  `list_space_children` returns it and `join_room` joins.
- **Rust unit (in-module, like `extract_sso_callback_state`)**: the `has_unread`
  invariant as a pure function over `(is_marked_unread, is_muted, unread_messages,
  unread_count)` — exhaustive truth table; the section/order comparator.
- **Vitest + RTL** (`RoomList.test.tsx`, `RoomListItem.test.tsx` already exists — extend):
  sectioning renders correct groups; context-menu actions invoke the right commands;
  muted/mark-unread indicators; `has_unread` styling. Drag reorder: simulate a
  `@use-gesture` drop, assert `setRoomManualOrder` called with a midpoint order and
  optimistic reorder applied. Coverage floor enforced.
- **Playwright (web build) + tauri-driver**: end-to-end favourite → section move →
  reload persistence; open Space browser → join a room.
- **Storybook + axe**: RoomList with all sections populated, empty, and collapsed states;
  context menu; keyboard reachability of drag (a11y fallback for reorder).

## Dependencies & sequencing

- Shares the `RoomSummary` struct extension and `mark_room_read` with **Spec 05**.
  Whichever PR merges first owns the struct change and the read-marker command; the second
  rebases onto it. Recommend landing Spec 05 (or at least its `mark_room_read` +
  `unread_messages`/`is_marked_unread` fields) first, since this spec's unread invariant
  consumes them.
- No new crates for tags/mute/unread (all in pinned `matrix-sdk`). `@use-gesture/react` is
  a new frontend dep for drag. Space hierarchy uses ruma requests already vendored via
  `matrix-sdk`.
- ts-rs export remains manual; keep the `src/lib/matrix.ts` hand-mirror in sync.

## Risks & open questions

- **Unread invariant is the highest-risk item** — getting it wrong (muted rooms flagged,
  or genuine unread hidden) undermines the whole list. Locked down by an exhaustive Rust
  truth-table test; the invariant lives in exactly one place (`snapshot_rooms`).
- **Manual order collisions**: fractional-index midpoints can exhaust `f64` precision after
  many reorders; open question whether to renormalize orders periodically (proposed:
  renormalize a section's orders when two neighbours are within an epsilon).
- **Space hierarchy pagination / size**: `get_hierarchy` paginates; large spaces need
  `from`/`limit` handling — Day 1 fetch first page only, note "load more".
- **`client.knock` availability** in the pinned SDK version is uncertain; fall back to the
  raw ruma `knock_room::v3` request if the wrapper is absent (verify against the actual
  pinned version before implementing).
- **Sorting in Rust vs. RoomListService**: manual snapshot re-sort on every sync is simple
  but O(n log n) per sync; fine at Day-1 room counts, revisit with `RoomListService` if it
  becomes a bottleneck.
- Room being both muted and favourited is legal in Matrix — confirm the section
  precedence (favourite wins placement; mute is an orthogonal indicator).

## Effort estimate

**L** — spans tag/mute/unread account-data plumbing, space hierarchy + join/knock, a
non-trivial `RoomList` restructure into sections, and drag-reorder with persisted
fractional ordering; the unread invariant and manual-order persistence are the parts most
likely to churn.
