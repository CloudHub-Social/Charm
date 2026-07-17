---
title: "Charm 2.0 Spec — Sidebar and space management (pin, reorder, context
  menu, add existing)"
type: spec
project: Charm 2.0
created: "2026-07-16"
status: in-progress
sidebar:
  label: "Sidebar & space management"
---

## Implementation status

**Phase 1 in progress.** Pin/unpin, drag-free reorder (Move up/down), and a
per-space context menu (Open Lobby, Invite, Pin/Unpin, Move up/down) landed on
`SpaceRail.tsx`, with pinned order and unpinned state persisted client-side via
a new `spaceRailPrefs` atom. Unpinned spaces stay visible below a divider
rather than disappearing, since there is not yet another space-browsing
surface to keep them reachable from once hidden — a deliberate deviation from
this spec's original "remains reachable via Home/search" framing, revisit once
a real space browser exists.

Not yet built: `Settings`, `Leave`, `Set/Unset Suggested`, `Remove`, and `Add
Existing` (phase 2) — these depend on Spec 33's `m.space.child` write path
and/or the not-yet-built space-settings surface, per the phasing below.
Account-data sync (vs. today's local-only persistence) is also still open.

**Workstream:** likely 2 PRs (see Effort estimate). Addendum to Spec 19 (space
hierarchy and room-list rebuild) and Spec 33 (space nesting and hierarchy
reorganization) — closes a sub-feature both specs scoped out.

## Problem & why now

Spec 19 shipped `SpaceRail.tsx`: a dedicated vertical rail with Home, DMs, and
one entry per top-level/pinned space, recursive folders, and badge rollup
(confirmed in code — `src/features/rooms/SpaceRail.tsx`). Spec 33 (draft)
covers *building* the hierarchy — creating a nested space, dragging a space
into another space to re-parent it — and flags the missing space-settings
surface.

Neither spec covers **managing what appears in the rail and how each entry
behaves once it's there**. This is a distinct, and distinctly missing,
capability: the rail today is a pure read-only projection of "every space
you're joined to, in whatever order the room list returns them" — there is no
user-facing control over it at all. Confirmed by reading `SpaceRail.tsx`
(2026-07-16): `topLevelSpaces` is derived straight from `rooms` with no
persisted ordering, pinning, or visibility state, and no entry (space avatar
or folder) has a context menu or any affordance beyond a single click that
navigates to it.

Charm 1.0/Sable (both Element-family clients — the owner's reference
screenshots show Element's actual sidebar/space-list UI, which Cinny-derived
Charm 1.0 broadly follows) exposes this as ordinary space-list management:

- **Per-space right-click context menu** (screenshotted from the reference
  client): `Pin to Sidebar` / `Unpin from Sidebar`, `Open Lobby`, `Invite`,
  `Settings`, `Leave`, `Set Suggested` / `Unset Suggested`, `Remove`. This menu
  is available both on a top-level rail entry and on a room/sub-space row
  inside a space's lobby view.
- **`Add Existing` dialog**: from a space's lobby (its "Rooms" section
  header's `⋮` menu → `Add Room` / `Add Space` in the reference UI, or a
  dedicated `+ Add Room` / `+ Add Space` action), a searchable picker of the
  user's *already-joined* rooms/spaces lets them add an existing room/space as
  a child of the current space — distinct from creating a brand-new one.
  Confirmed absent in Charm 2.0: `create_space`/`CreateJoinSpaceDialog.tsx`
  only create-new or join-by-address; there is no "take a room I'm already in
  and file it under this space" flow anywhere in the codebase (grep for
  `add_room_to_space`/`AddExisting`/`add_child` in `src/` and `src-tauri/src/`
  returns no matches).
- **Pin/unpin controls what's in the rail vs. what's reachable only through
  "Home"/search.** A user with many joined spaces doesn't want all of them
  permanently occupying rail real estate; unpinning removes the rail entry
  without leaving the space.
- **Per-space/room visibility toggle within a space's lobby** ("Suggested"
  rooms are highlighted for new joiners; this is the `m.space.child`
  `suggested` field, which Charm 2.0's `create_space`/hierarchy walk doesn't
  currently read or write at all).

Without this, a Charm 2.0 user can view whatever hierarchy already exists
(via Spec 19) and edit its parent/child *shape* (via Spec 33, once shipped),
but cannot curate their own rail, add an already-joined room to a space
they're organizing, leave a space from the rail, or reach that space's
settings at all (space settings are entirely absent — flagged in Spec 33 but
not yet built).

## Scope (in)

1. **Pin/unpin.** A boolean per space (persisted client-side account data,
   e.g. a new `m.charm.pinned_spaces` — or equivalent — account-data event,
   mirroring how Charm 1.0/Element persist sidebar pins) controlling whether
   a joined top-level space shows a permanent rail entry. Unpinning a space
   does not leave it — the space remains reachable via Home/search, just not
   pinned to the rail. New default: spaces the user creates or explicitly
   joins are pinned by default (matches current implicit behavior, so no
   regression for existing users on upgrade).
2. **Reorder pinned spaces.** Drag-to-reorder (or up/down context-menu
   actions as a non-drag fallback) among pinned rail entries, persisted in
   the same account-data structure as an ordered list, not just a set.
3. **Per-space context menu**, available via right-click on desktop and
   long-press on mobile/touch, on both the rail entry and the corresponding
   row inside a space's lobby/scoped view:
   - `Open Lobby` — navigates into the space's scoped view (the same action
     as a left click; included in the menu for consistency with the reference
     client and touch users who reach the menu before a plain tap).
   - `Invite` — opens the existing room-invite flow (Spec 07/Spec 56) scoped
     to this space.
   - `Settings` — opens the new space-settings surface (see dependency on
     Spec 33 below); until that surface ships, this item can be omitted or
     disabled rather than shipping a broken link.
   - `Pin to Sidebar` / `Unpin from Sidebar` — toggles item 1.
   - `Leave` — existing leave-room flow, applied to the space (confirm
     whether leaving a space with children prompts about orphaned child
     rooms, matching whatever Charm 2.0's existing room-leave confirmation
     pattern does for non-space rooms with dependents).
   - `Set Suggested` / `Unset Suggested` — writes the `suggested: true/false`
     field on this space's `m.space.child` edge from its parent (only shown
     when the entry has a parent space and the user has sufficient power
     level in that parent to edit its state).
   - `Remove` — removes this space as a child of its parent (deletes the
     parent's `m.space.child` edge) without leaving the space itself or
     affecting its other parents if multi-parented; only shown when the entry
     has a parent. This is the "detach from hierarchy" counterpart to Spec
     33's re-parenting drag — reuse whatever state-event write path Spec 33
     introduces for parent/child edges rather than building a second one.
4. **Add Existing.** A new action (from a space's lobby view, e.g. next to
   the existing room-list header or the space's context menu) opening a
   searchable picker over the user's already-joined rooms and spaces (exclude
   rooms/spaces already children of this space, and this space itself and
   its ancestors, to prevent immediate cycles). Selecting an item sends the
   `m.space.child` state event on the current space pointing at it — same
   underlying write path as Spec 33's create-nested/drag-to-nest, just a
   third entry point (pick from existing membership rather than create new
   or drag). Needs a new or extended Rust command, e.g.
   `add_existing_child(space_id, child_room_id)` in `spaces.rs` (currently
   169 lines with no such command — confirmed via the Spec 19 audit and a
   fresh read on 2026-07-16).
5. **Rail-entry visual treatment for muted/loud unread** on pinned spaces —
   already exists (Spec 19's badge rollup); this spec doesn't change that,
   just makes sure pin/unpin/reorder don't regress it (badge computation
   already keys off `room_id`, independent of pin state).

## Non-goals (out)

- Space *settings* itself (name/topic/avatar/join-rules/permissions editing)
  — that's Spec 33's "space settings surface" addendum. This spec's
  `Settings` menu item is a link into that surface once it exists; building
  the surface's contents is out of scope here.
- Space nesting/re-parenting mechanics (create-nested, drag-to-nest,
  cycle-guarding, multi-parent semantics) — fully owned by Spec 33. This
  spec's `Remove` action and `Add Existing` flow reuse Spec 33's
  `set_space_parent`-style write path rather than duplicating it; if Spec 33
  hasn't shipped yet when this spec starts, land the minimal shared
  `m.space.child` write helper as part of whichever spec starts first and
  have the other consume it.
- Folder/group-level pin-and-reorder for Discord-style collapsible folders
  of *grouped* spaces — Spec 19's folder concept is for auto-derived
  parent/child groupings, not a user-defined custom grouping feature; if the
  owner wants arbitrary custom folders (independent of the real
  `m.space.child` hierarchy) that's a separate future spec, not implied by
  the reference screenshots (which show real space hierarchy, not custom
  folders).
- DM/direct-message pinning and reordering — out of scope; this spec is
  spaces-only. (DM pinning, if wanted, is closer in spirit to Spec 54's
  room-list row/ordering work.)
- Public-space directory/"explore recommended spaces" browsing — flagged as
  a nice-to-have in Spec 19's original scope item 8 and still not built;
  stays out of scope here too.

## Design & approach

- **Phase this** into two PRs:
  1. Pin/unpin + reorder + context menu skeleton (`Open Lobby`, `Invite`,
     `Leave` — all backed by existing flows, no new Rust surface beyond the
     account-data read/write for pin state).
  2. `Add Existing`, `Set Suggested`/`Unset Suggested`, `Remove`, and the
     `Settings` menu item — these depend on either new Rust commands
     (`add_existing_child`) or Spec 33's parent/child write path landing
     first. Sequence phase 2 after Spec 33 if Spec 33 is being worked
     concurrently, to avoid two specs independently inventing
     `m.space.child` write helpers.
- Persist pin state and ordering as account data so it syncs across the
  user's devices (matching how Charm 1.0/Element persist sidebar
  customization) rather than local-only client storage.
- Reuse the existing room-list context-menu component/pattern if Charm 2.0
  already has one for regular rooms (check `RoomList.tsx`/`DraggableRoomRow`
  before building a new context-menu primitive from scratch) — the
  interaction model (right-click desktop, long-press touch, keyboard
  equivalent) should be consistent between room rows and rail entries.
- Follow this repo's git-worktree-isolation convention (`CLAUDE.md`).

## Acceptance criteria

1. A user can pin a joined space to the rail and unpin it without leaving
   the space; unpinned spaces remain reachable via Home/search.
2. A user can reorder pinned rail entries, and the order persists across
   restart and across devices (synced via account data).
3. Right-clicking (desktop) or long-pressing (touch) a rail entry or a
   space's lobby row opens a context menu with at minimum `Open Lobby`,
   `Invite`, `Pin`/`Unpin`, and `Leave`; `Settings`, `Set/Unset Suggested`,
   and `Remove` appear when their preconditions (settings surface shipped;
   entry has a parent; sufficient power level) are met.
4. From a space's lobby, a user can add an already-joined room or space as a
   child via a searchable "Add Existing" picker, without creating a
   duplicate room/space.
5. `Remove` detaches a space from its parent without leaving the space or
   affecting other parent relationships (if multi-parented).
6. Cycle prevention: `Add Existing` excludes the current space, its
   ancestors, and existing children from the picker's results.
7. `pnpm test:coverage`, `pnpm build`, Storybook a11y, and existing e2e specs
   touching the room list/spaces all still pass — update/add coverage for
   both phases.

## Testing

- Rust: pin-state account-data read/write round-trip; `add_existing_child`
  sends correct `m.space.child` state and rejects cycle-forming targets
  before any state event is sent; `Remove`'s child-edge deletion.
- Vitest/RTL: context menu renders the correct item set per precondition
  (has-parent, power-level, settings-surface-available); reorder persists
  and re-renders in the new order; `Add Existing` picker correctly excludes
  self/ancestors/existing-children from results.
- Manual: pin/unpin/reorder across a restart and (if a second test device is
  available) confirm sync via account data; add an existing room to a space
  and confirm Spec 19's hierarchy walk and badge rollup pick it up correctly
  after resync.
- Storybook stories for the context menu's states and the `Add Existing`
  dialog, running through the existing blocking-a11y CI gate.

## Dependencies & sequencing

- Builds on Spec 19 (shipped) — extends `SpaceRail.tsx`, does not replace it.
- Shares a write path with Spec 33 (draft) for `m.space.child` mutations
  (`Remove`, `Add Existing`) — coordinate sequencing per the phasing note
  above rather than both specs independently building `set_space_parent`-
  equivalent logic.
- `Settings` context-menu item depends on Spec 33's "space settings surface"
  UI-parity addition; can ship disabled/omitted until that surface exists.
- Independent of Spec 11/16 (push, web client) and Specs 17/18 (room/global
  settings IA) beyond the Spec 17 shell reuse called out in Spec 33.

## Effort estimate

**M–L** — phase 1 (pin/unpin/reorder/context-menu skeleton) is mostly
frontend plus one new account-data structure; phase 2 (`Add Existing`,
`Set/Unset Suggested`, `Remove`) needs new Rust command surface and is best
sequenced after or alongside Spec 33 to share the parent/child write path
rather than duplicating it.
