---
title: Charm 2.0 Spec — Room alias management
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
---

**Workstream:** one PR / one agent. Small addition to Spec 07/17's room settings.

## Problem & why now

Charm 2.0 already generates and follows `matrix.to`/`https://matrix.to` permalinks
for mentions and replies (per the parity gap analysis), but has no UI for a room
admin to actually **manage** aliases — publish/unpublish an alias, set the room's
canonical alias, or add alternative aliases. Charm 1.0 has this in its room
settings. Without it, an admin who wants a room discoverable/nicely-linkable via a
human-readable alias (`#team:example.org` instead of an opaque room ID) has no path
to set one up from within Charm 2.0 at all.

## Non-goals

- Not room directory publishing (making a room appear in public room search) — that
  is a related but separate concept (`m.room.canonical_alias` vs
  visibility/directory listing) covered by the Day-2 room-directory spec. This spec
  is alias CRUD only.
- Not alias-based room resolution UI for *joining* a room by typing an alias — if
  that already works via existing join-by-address flow (Spec 19 phase 4 mentions
  "join by address"), this spec doesn't touch it, only publishing/setting aliases
  as an admin.

## High-level design

- In room settings (General or a dedicated "Alias" section, matching Charm 1.0's
  IA), add:
  - A list of the room's current local aliases (`m.room.aliases` per-server state,
    or the canonical-alias-adjacent local aliases the homeserver tracks — confirm
    current Matrix spec mechanism, since the aliases event type has evolved; use
    whatever matrix-rust-sdk currently exposes).
  - "Add alias" — validates the requested alias is available on the user's
    homeserver, creates it via the SDK, and offers to set it as canonical.
  - "Remove alias" per existing alias.
  - A "canonical alias" selector — sets `m.room.canonical_alias`'s `alias` field to
    one of the room's aliases (or clears it).
- Power-level gating: matches whatever level the homeserver/room requires for
  `m.room.canonical_alias`/alias creation (typically a moderator+ action) — reuse
  Spec 07's existing power-level check pattern.
- Display: once a canonical alias exists, prefer showing it over the raw room ID
  anywhere the client currently surfaces room IDs to the user (e.g. room info
  panel, share/copy-link action) — small polish item, not the core of this spec,
  include if low-effort.

## Data flow

Alias creation/deletion goes through matrix-rust-sdk's room-directory/alias API
(PUT/DELETE on `/directory/room/{roomAlias}`) plus a state-event send for
`m.room.canonical_alias`. No new sync-side work — alias state already flows through
existing room-state sync.

## API/contract changes

New IPC commands: `add_room_alias(room_id, alias)`, `remove_room_alias(alias)`,
`set_canonical_alias(room_id, alias | null)`. Standard ts-rs binding regeneration.

## Testing strategy

- Rust: unit tests for each new command against a mocked homeserver response
  (success, alias-already-taken conflict, insufficient permission).
- Frontend: alias list renders current aliases, add/remove/set-canonical actions
  gated by power level, error states surfaced (e.g. "alias already in use").
- Manual: create an alias on a real test room, confirm it resolves via `matrix.to`
  and that Charm 1.0 (if still around for cross-testing) recognizes it the same way.

## Trade-offs

- **Scoped to alias CRUD, not directory visibility**: keeps this spec small and
  reviewable; directory listing has its own UX surface (search/browse) that belongs
  with the Day-2 room-directory spec rather than bolted onto settings here.

## What I'd revisit as this grows

- Combine with the Day-2 room-directory spec's "publish to directory" toggle once
  both exist, if the settings UI ends up feeling fragmented across two specs' work.
