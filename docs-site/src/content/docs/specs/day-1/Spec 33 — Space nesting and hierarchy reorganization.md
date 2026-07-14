---
title: Charm 2.0 Spec — Space nesting and hierarchy reorganization
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
sidebar:
  label: "Space nesting & hierarchy"
---

**Workstream:** one PR / one agent. Addendum to Spec 19 (space hierarchy and
room-list rebuild) — closes a sub-feature that spec's 4 phases scoped out.

## Problem & why now

A deep parity audit (2026-07-13) confirmed a real regression: Charm 2.0's
`SpaceRail.tsx` (`childSpacesByParent`/`parentSpaceIdsByChild`) renders the space
hierarchy but is **read-only navigation only** — there is no way for a user to
actually build or edit that hierarchy from within the client. Charm 1.0 supports
both:

- **Creating a space already nested under a parent** —
  `CreateSpace.tsx:126` passes an explicit `parent: space` param when the "create
  space" action is invoked from inside an existing space.
- **Dragging an existing space into another space to nest it** —
  `Lobby.tsx`'s `draggingItem`/`onDragging`/`draggingOutsideSpace` state implements
  drag-and-drop re-parenting of spaces.

Charm 2.0's `CreateJoinSpaceDialog.tsx` has zero `parent` parameter support, and
`SpaceRail.tsx` has no drag handlers at all. This means any Charm 1.0 user who
organized their spaces hierarchically (e.g. a top-level "Work" space containing
"Engineering" and "Design" subspaces) cannot reproduce or modify that structure in
Charm 2.0 — they can only view whatever hierarchy already exists from another
client.

## Non-goals

- Not a rebuild of the hierarchy *display* logic — Spec 19's recursive hierarchy
  walk and badge-rollup stay as-is; this spec only adds the ability to change the
  hierarchy, not how it's read/rendered.
- Not drag-and-drop room reordering (already covered, confirmed working, per the
  parity audit — `DraggableRoomRow`/`computeManualOrder` in `RoomList.tsx`). This
  spec is specifically about **space-into-space** nesting, a different drag target
  and different underlying state mutation (space parent/child relationship via
  `m.space.parent`/`m.space.child` state events, not the room-list's fractional
  manual-order key).
- Not arbitrary depth-limit changes — nesting depth follows whatever
  `m.space.child` traversal already supports/limits per Spec 19's existing walk;
  don't introduce new depth restrictions or removals without checking what Spec
  19's walk currently assumes.

## High-level design

### Create-nested-space

- When "Create space" is invoked from within an existing space's context (e.g.
  from that space's rail entry or its room-list header), pass that space as the
  new space's parent.
- On creation: send `m.space.child` on the parent space's state (pointing at the
  new space) and `m.space.parent` on the new space's state (pointing back at the
  parent, `canonical: true` if this is meant to be its primary parent) — mirror
  whichever exact event shape Spec 19's existing hierarchy walk already expects,
  since this write path needs to produce state that walk can immediately read back
  correctly.
- If "Create space" is invoked from the top-level (not from within a space
  context), no parent is set — unchanged existing behavior.

### Drag-to-nest

- `SpaceRail.tsx` gains drag handlers (reuse the same `@use-gesture/react`
  dependency `RoomList.tsx`'s `DraggableRoomRow` already uses, for consistency
  rather than introducing a second drag library/pattern).
- Dragging a space entry onto another space entry in the rail re-parents it: sends
  the same `m.space.child`/`m.space.parent` state-event pair as the create-nested
  flow above, removing any prior parent relationship being replaced (or adding an
  additional parent if Charm 2.0's model supports multi-parent spaces — confirm
  against Spec 19's walk before deciding whether re-parenting replaces or adds).
- Dragging a space out to the top level (out of any parent) removes its
  `m.space.parent` relationship — mirrors Charm 1.0's `draggingOutsideSpace` state,
  which explicitly detects "dropped outside any space" as the un-nest action.
- Visual feedback during drag (valid-drop-target highlight, invalid-target
  rejection e.g. can't nest a space inside itself or inside its own descendant —
  guard against cycles explicitly, since the recursive hierarchy walk would loop or
  behave unpredictably on a cyclic parent/child graph).
- Power-level gating: re-parenting sends state events, so it needs whatever power
  level the room/space requires for state-event sends — reuse Spec 07's existing
  power-level check pattern; a user without sufficient permission in either the
  parent or child space should see the drag rejected with a clear reason, not a
  silent failure.

## Data flow

New IPC commands (or extensions to existing space-creation/space-state commands):
`create_space(name, ..., parent_space_id?)`, `set_space_parent(space_id,
parent_space_id | null)`. Both are state-event sends against already-synced
spaces/rooms — no new sync-side machinery, since Spec 19's hierarchy walk already
consumes `m.space.child`/`m.space.parent` state, this spec just adds write paths
for that same state.

## API/contract changes

- Extend `create_space` (introduced in Spec 19 phase 4, PR #153) with an optional
  `parent_space_id` param.
- New `set_space_parent` command for the drag-to-nest re-parent action.
- No changes to hierarchy-read commands.

## Testing strategy

- Rust: `create_space` with a parent sends correct `m.space.child`/
  `m.space.parent` state; `set_space_parent` correctly adds/replaces/removes
  parent relationships including the cycle-prevention check (attempt to nest a
  space inside its own descendant, confirm rejected before any state event is
  sent).
- Frontend: create-space dialog carries context correctly when invoked from within
  a space vs at top level; drag-to-nest on `SpaceRail` triggers the correct IPC
  call with correct source/target; invalid drop targets (self, descendant) are
  visually rejected without triggering a send.
- Manual: build a 3-level nested hierarchy via drag-and-drop, confirm Spec 19's
  existing badge-rollup and hierarchy walk correctly reflect the new structure
  after a resync/restart (confirms the write path produces state the existing read
  path actually expects — the most likely integration bug given this spec writes
  to state a different spec's code reads).

## Trade-offs

- **Reuse `@use-gesture/react` vs a dedicated space-tree drag library**: matches
  the existing room-list drag implementation's dependency choice, avoiding a
  second drag-and-drop library in the codebase for what is conceptually a similar
  interaction (reordering/reparenting items in a list-like UI).

## UI-parity addition (from the 2026-07-13 UI deep-dive)

- **Space settings surface.** Charm 2.0 has room settings (Specs 17) but **no space
  settings** — the wide-net UI audit confirmed only *room* settings exists (grep
  `spacesetting` → 0; Charm 1.0 has `features/space-settings/`). A space is a room,
  so it needs an equivalent settings surface: edit a space's name/topic/avatar,
  visibility/join rules, and permissions, plus manage its child rooms/spaces (which
  ties into this spec's nesting work). Reuse Spec 17's room-settings shell/IA rather
  than building a parallel one — a space's settings are room-settings plus the
  child-management this spec already covers.

## What I'd revisit as this grows

- Multi-parent space support (a space nested under two different parents
  simultaneously) if Spec 19's walk turns out to already assume single-parent and
  real users want multi-parent — confirm current assumption before this spec ships
  rather than guessing.
