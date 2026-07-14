---
title: "Charm 2.0 Spec — Space hierarchy and room-list rebuild (match Charm 1.0
  structure)"
type: spec
project: Charm 2.0
created: "2026-07-07"
status: in-progress
sidebar:
  label: "Space hierarchy & room-list rebuild"
---

**Workstream:** likely multi-PR — recommend phasing (see Effort estimate).
**Tier:** post-Day-1 UX rework.

## Problem & why now

Charm 2.0's space/room-list organization (Spec 06) explicitly shipped as
"Day-1 scope: a collapsed grouped list (space → child rooms), not a nested
tree" (per `spaces.rs`'s own module doc — confirmed intentional, not an
oversight). The owner prefers Charm 1.0's space-hierarchy information
architecture — not its visual styling (Charm 2.0 keeps its own design system/
tokens from Spec 09), but its structure: a dedicated space rail, true
recursive nesting, badge rollup, and discoverable space creation/joining.
This is the **largest of the three IA-rework gaps** identified (verified
directly against both codebases; Charm 1.0 confirmed to be a **Cinny fork**,
not classic Element/matrix-react-sdk — component names below are Cinny's
actual names).

## Current state (in repo, verified 2026-07-07)

**Charm 1.0** (legacy Cinny-derived codebase):
- **Three-pane layout**, routed via `Router.tsx`: a dedicated vertical
  **space rail** (`SidebarNav.tsx`: HomeTab → DirectDMsList →
  `SpaceTabs.tsx` → a persistent "+" `CreateTab`), a scoped room-list pane
  per route (`Home.tsx` / `Direct.tsx` / `Space.tsx`), and a separate content
  pane.
- `SpaceTabs.tsx`: one avatar per top-level/pinned space, plus Discord-style
  collapsible "folders" of grouped spaces (`ClosedSpaceFolder`).
- Clicking a space avatar does a **real navigation** (`useSelectedSpace()`/
  URL) to `Space.tsx`/`Lobby.tsx` — a dedicated view scoped to that space's
  hierarchy, not a modal or dialog.
- **True recursive tree**: `useSpaceJoinedHierarchy`/`getHierarchySpaces`
  (recursive, cycle-guarded) walks `m.space.child` to arbitrary depth,
  rendered virtualized with per-depth indentation + SVG connector lines
  (`getConnectorSVG`); a `subspaceHierarchyLimit` user setting (default 3)
  turns deeper levels into clickable nav links rather than inline expansion
  once exceeded. Categories (space branches) are individually collapsible.
- **Badge rollup**: `SpaceTab` recursively sums all descendant rooms'
  unread/highlight (`useRecursiveChildRoomScopeFactory`/`getRoomsUnread`),
  with a loud-vs-muted distinction (counts vs. dot); `ClosedSpaceFolder`
  rolls up across every space in a folder. Home/Direct tabs aggregate only
  their own scope.
- **Home vs space vs DM are three distinct modes**: `HomeTab` shows only
  "orphan" rooms (no parent space) via `useOrphanRooms`, with a "Show All
  Rooms" toggle; `Direct.tsx` is its own third mode with a dedicated
  always-visible pinned-DM avatar strip (`DirectDMsList`, capped at 3
  unread).
- **No** Element-style favourite/low-priority tag sections — Cinny lineage
  replaced that with an activity/priority sort toggle
  (`factoryRoomIdByPriority`) plus a separate "Bookmarks" feature that is
  actually saved messages/reminders, not room tags.
- **Search**: `home/Search.tsx` and `space/Search.tsx` are near-identical
  components scoped to their context (orphan rooms vs. recursive space
  descendants) with an `allowGlobal` escape hatch to search everything.
- **Space creation/join**: persistent "+" `CreateTab` at the rail bottom →
  menu (Create a New Space / Join Community via Address / Explore
  Recommended Spaces). Adding a room to a space happens via drag-and-drop in
  `Lobby.tsx` or via space settings.

**Charm 2.0** (this repository):
- **No space rail exists.** `AppShell.tsx` renders `[roomList, content,
  rightPanel]` — one flat `RoomList.tsx` combining everything. Mobile
  bottom-nav has Chats/People/Settings only, no Spaces tab.
- Clicking a space's section header opens `SpaceBrowser.tsx`, a **modal
  dialog** listing that space's direct children via `listSpaceChildren`,
  with Join/Request-to-join buttons — a one-shot join picker, not navigation
  or view-scoping. No persistent "you are inside space X" state exists.
- **Explicitly one level only, by design**: `src-tauri/src/matrix/spaces.rs`
  module doc states "Day 1 scope is a collapsed grouped list (space → child
  rooms), not a nested tree, so `list_space_children` only fetches the first
  hierarchy page." Frontend `roomSections.ts` groups by direct
  `parent_space_ids` membership only — no sub-space concept anywhere.
- **No badge rollup at all**: `BadgeState` has only a flat
  `total_unread`/`total_highlight` across every room; no per-space or
  per-folder aggregation exists.
- **No Home/space mode distinction**: `RoomList.tsx` always renders
  everything (favourites, all space groups, ungrouped rooms, low-priority)
  in one continuous scroll. A separate `peopleList` (DM-only filter) exists
  in `RoomsScreen.tsx`/`AppShell`, but there's no dedicated DM rail/strip.
- **Does** have real Favourites and Low-priority tag sections
  (`groupRoomsIntoSections`, per-room `onToggleFavourite`/
  `onToggleLowPriority`) — Charm 1.0 doesn't have this; flagged as a place
  Charm 2.0 is already ahead (see Non-goals).
- **No room-list search/filter exists anywhere** in `src/features/rooms/` —
  confirmed via grep, not just unfound.
- **No space creation or join-by-address/discovery UI exists at all** —
  confirmed via grep for `createSpace`/`create_space`/`joinSpace`/
  `CreateSpace`, no matches. The only space-related action is
  `SpaceBrowser`'s per-room join for rooms inside an *already-known* space.
  No add-room-to-space UI either.

## Scope (in)

1. **Space rail**: a new dedicated vertical rail component, separate from
   the room list — Home entry, DM entry, one item per top-level/pinned
   space (with Discord-style collapsible folders for grouped spaces), and a
   persistent create/join entry point at the bottom.
2. **Real space-scoped navigation**: replace `SpaceBrowser`'s join-dialog
   role with an actual navigation/view-scoping mechanism — selecting a space
   in the rail shows a room list scoped to that space's hierarchy, not a
   one-shot join picker. (Joining a room *within* a space you're viewing can
   still use a lightweight join affordance inline in that scoped list —
   that part of `SpaceBrowser`'s behavior is reasonable to keep, just not as
   the *only* thing clicking a space does.)
3. **Recursive sub-space tree**: this is the core structural rework.
   - Rust side: `spaces.rs`'s `list_space_children` currently fetches only
     the first hierarchy page by design — extend it (or add a new command)
     to walk the full `m.space.child` hierarchy recursively, cycle-guarded,
     to arbitrary depth (matching 1.0's `getHierarchySpaces`).
   - Frontend: recursive tree rendering with per-depth indentation (SVG
     connector lines are a nice-to-have, not required for parity — evaluate
     whether Charm 2.0's design system wants an equivalent visual, but the
     *data structure and depth support* is the actual requirement, not the
     specific connector-line rendering).
   - A depth-limit setting (mirroring `subspaceHierarchyLimit`) is a
     reasonable inclusion but not strictly required for a first version —
     consider deferring if it adds significant scope.
4. **Badge rollup**: new aggregation logic, keyed by `parent_space_ids`,
   summing descendant room unread/highlight up into each space's own badge
   (and folder-level rollup across grouped spaces), with a loud-vs-muted
   distinction matching 1.0.
5. **Home vs space mode**: a dedicated Home view showing orphan rooms (no
   parent space) by default, with a "Show All Rooms" toggle — distinct from
   being inside a specific space's scoped view.
6. **DM handling**: add a dedicated, always-visible DM entry point/strip in
   the rail (matching 1.0's `DirectDMsList`), independent of whatever
   space/Home view is active. Decide whether to keep DMs inside the existing
   `peopleList`/section-based approach as well, or fully replace it —
   recommend keeping both is unnecessary; consolidate onto the rail-based DM
   entry point.
7. **Room-list search**: build this from scratch (it doesn't exist in Charm
   2.0 today at all) — scoped-by-default to the current Home/space context,
   with a global-search escape hatch, matching 1.0's `Search.tsx` pattern.
8. **Space creation/join discoverability**: build a create/join entry point
   in the rail (Create a New Space / Join via address-or-ID / a lightweight
   "explore" if feasible) and an add-room-to-space flow. Check what
   Rust-side support already exists (`spaces.rs` is only ~169 lines per the
   audit, no `create_space` command was found) before assuming this is
   purely a frontend task — creating/joining spaces almost certainly needs
   new `#[tauri::command]`s backed by `matrix-rust-sdk`'s space-creation
   APIs.

## Non-goals (out)

- Any visual/token/color change — Charm 2.0's design system (Spec 09) stays
  as-is; only structure/navigation changes.
- **Do not remove Charm 2.0's Favourites/Low-priority tag sections** — Charm
  1.0 doesn't have these (it uses a different priority-sort model instead),
  but they're a genuine, already-shipped feature and a net improvement over
  1.0 in this one respect. Decide how they compose with the new space rail
  (e.g. Favourites as a pinned section within Home, or its own rail entry)
  rather than dropping them to match 1.0 exactly.
- Drag-and-drop room-to-space assignment — 1.0 has this via
  `pragmatic-drag-and-drop`; a simpler explicit "add to space" action/menu
  is an acceptable first version, drag-and-drop can be a follow-up.
- SVG tree-connector-line rendering specifically — the recursive data
  structure and depth support is the real requirement; the exact visual
  treatment of nesting (indentation alone vs. connector lines) is a Spec 09
  design-system decision, not mandated by this spec.

## Design & approach

- **Phase this** given the size (see Effort estimate) — recommend:
  (1) Rust-side recursive hierarchy walk + badge-rollup data, (2) the space
  rail + real space-scoped navigation (replacing `SpaceBrowser`'s current
  role), (3) room-list search, (4) space creation/join UI. Each phase is
  independently mergeable and testable, similar to how Spec 16 was phased.
- Confirm before starting whether `matrix-rust-sdk` already exposes
  space-creation/hierarchy-walk primitives cleanly, or whether `spaces.rs`
  needs meaningful new Rust code — this affects how the phases above should
  be scoped and sequenced.
- Follow this repo's git-worktree-isolation convention (`CLAUDE.md`).

## Acceptance criteria

1. A dedicated space rail exists, separate from the room list, with Home,
   DM, and per-space/folder entries.
2. Selecting a space navigates to a scoped view of that space's room
   hierarchy, not a one-shot join dialog.
3. Sub-spaces nest to arbitrary depth (not capped at one level), verified
   against a real multi-level space hierarchy in the dev Synapse harness.
4. Each space's badge reflects the summed unread/highlight of all descendant
   rooms, with a loud/muted distinction.
5. A Home view shows orphan (no-parent-space) rooms by default, with a
   toggle to show everything.
6. Room-list search exists, scoped to the current context by default with a
   global option.
7. A user can create a new space and join an existing space by address/ID
   from a discoverable UI entry point.
8. Favourites/Low-priority sections still work, composed sensibly with the
   new rail (not dropped).
9. `pnpm test:coverage`, `pnpm build`, Storybook a11y, and existing e2e specs
   touching the room list/spaces all still pass — update/add coverage for
   every phase.

## Testing

- Rust integration tests (extending the existing `room_org.rs`/`spaces.rs`
  test patterns) against a real multi-level space hierarchy in the dev
  Synapse harness — recursive walk correctness, cycle handling, badge-rollup
  math.
- Vitest/RTL for the rail, space-scoped navigation, search scoping, and
  create/join flows.
- Update `e2e/room-list-org.spec.ts` (or equivalent) for the new rail-based
  navigation if it currently asserts against the flat-list shape.
- Storybook stories for the rail and its collapsed-folder states, running
  through the existing blocking-a11y CI gate.

## Dependencies & sequencing

- Independent of Spec 11/16 (push, web client) and of Specs 17/18 (room
  settings, global settings) — separate surface, can run concurrently.
- Builds on Spec 06's existing `RoomSummary`/`parent_space_ids` data model —
  extends it (recursive hierarchy, badge rollup) rather than replacing it.
- The create/join-space work may need new `matrix-rust-sdk` API surface in
  `spaces.rs` — confirm SDK support before committing to a phase timeline.

## Effort estimate

**L–XL** — genuinely the largest of the three IA-rework specs: a new rail
component, a real recursive-hierarchy data model and rendering (not present
in any form today), new badge-aggregation logic, room-list search built from
scratch, and space creation/join UI that likely needs new Rust-side
`matrix-rust-sdk` integration. Strongly recommend phasing into the four
sub-PRs outlined above rather than attempting it as one PR.
