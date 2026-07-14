---
title: Charm 2.0 Spec — Room upgrades
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
---

**Workstream:** one PR / one agent. Moderation-adjacent, sits next to Spec 07's
room management surface.

## Problem & why now

Matrix rooms occasionally need a "room upgrade" — a protocol-level operation that
creates a new room on a newer room version and tombstones the old one
(`m.room.tombstone` + `m.room.create` with `predecessor`), used when a room's
version needs bumping for a feature or security fix the server/spec requires.
Charm 1.0 has a `RoomUpgrade.tsx` flow for this (surfaced to room admins). Charm 2.0
has no UI for it at all — an admin hitting a room that needs upgrading currently has
no in-client path to do it, and any Charm 2.0 user landing in an already-tombstoned
room has no "continue to the new room" affordance either.

## Non-goals

- Not a general room-version-migration tool for bulk/admin use across many rooms —
  single-room, single-admin-action UI matching Charm 1.0's scope.
- Not automatic/silent upgrades — always an explicit admin action with a
  confirmation step (upgrades are disruptive: members must follow the tombstone to
  the new room, so this should never happen silently).

## High-level design

### Initiating an upgrade

- In room settings (Spec 07/17's IA), an admin-only "Upgrade room" action, gated by
  the same power-level check Spec 07 already uses for other admin-only actions.
- Confirmation dialog explains the consequence: a new room is created, this room
  becomes read-only with a pointer to the new one, and members need to manually (or
  automatically, depending on client behavior — clarify against current Matrix spec
  behavior for auto-join-on-tombstone-follow) join the new room.
- On confirm: call the SDK's room-upgrade operation (matrix-rust-sdk should expose
  this — confirm the exact API surface before implementing; if the SDK doesn't
  expose a high-level helper, this may need to be composed from lower-level
  send-state calls) targeting a specified new room version (default: the server's
  recommended/latest stable version).

### Landing in a tombstoned room

- When a room's state includes `m.room.tombstone`, render a persistent banner in
  the timeline (similar treatment to a read-only-room banner, see non-goal overlap
  with the room-directory/announcement-room area — reuse the same banner component
  if one already exists from that work, otherwise this spec introduces it first)
  with a "Go to upgraded room" action using the tombstone's `replacement_room`
  field.
- Composer is disabled (or hidden) in a tombstoned room, matching the semantics
  that the room is now read-only history — sending into a tombstoned room is
  pointless since active conversation has moved.

## Data flow

New IPC command, e.g. `upgrade_room(room_id, new_version) -> new_room_id`, plus
reading existing `m.room.tombstone` state (already synced, no new sync-side work,
just new frontend handling of an event type that currently probably renders as an
unhandled/generic state event or not at all).

## API/contract changes

- New IPC command for initiating an upgrade (admin action).
- No changes needed for reading tombstone state if room state events already flow
  through the existing timeline/room-state IPC surface — just add explicit handling
  for `m.room.tombstone` type in the state-event renderer, and a check for its
  presence in `ChatShell`'s composer-enablement logic.

## Testing strategy

- Frontend: tombstone banner renders when room state includes `m.room.tombstone`,
  composer is disabled, "Go to upgraded room" navigates to `replacement_room`.
- Frontend: upgrade action only visible/enabled for sufficient power level (reuse
  Spec 07's existing power-level-gating test pattern).
- Rust/IPC: `upgrade_room` command test against a mocked SDK response, including
  the failure path (insufficient permission server-side, room version unsupported).
- Manual: perform a real upgrade against a test homeserver room, confirm both the
  initiating client and a second client (as a regular member) see the tombstone
  banner and can follow it.

## Trade-offs

- **Composer disabled vs hidden in tombstoned room**: disabled-with-explanation
  chosen over fully hidden so the room doesn't look broken — a grayed-out composer
  with the banner above it communicates "this room is closed, here's why" more
  clearly than an empty space where the composer used to be.

## What I'd revisit as this grows

- Auto-join-on-tombstone (silently joining the replacement room when a tombstone is
  seen) if that turns out to match user expectations better than a manual click-
  through — start manual/explicit, tighten later only if requested.
