---
title: Charm 2.0 Spec — Room upgrades
type: spec
project: Charm 2.0
created: 2026-07-13
status: shipped
---

**Workstream:** one PR / one agent. Moderation-adjacent, sits next to Spec 07's
room management surface.

## Problem & why now

Matrix rooms occasionally need a "room upgrade" — a protocol-level operation that
creates a new room on a newer room version and tombstones the old one
(`m.room.tombstone` + `m.room.create` with `predecessor`), used when a room's
version needs bumping for a feature or security fix the server/spec requires.
Charm 1.0 has a `RoomUpgrade.tsx` flow for this (surfaced to room admins). Charm now
provides the same essential path behind the default-off `room_upgrades` feature
flag: authorized admins can explicitly upgrade a room, and members landing in the
old room are directed to its replacement. The rollout is native-only: browser builds
keep the feature disabled until the web transport can provide the same authoritative
current-state guarantees as the Tauri path.

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
- Confirmation dialog explains the consequence: Matrix creates a replacement room,
  tombstones the old room, and members continue manually through the replacement
  link.
- On confirm, Charm calls ruma's typed Matrix room-upgrade endpoint through
  matrix-rust-sdk's `Client::send`, targeting the homeserver capability's default
  room version. Charm does not reproduce the upgrade with custom state-event writes.
  Both the settings surface and native command reject an already-tombstoned room,
  preventing a second replacement from superseding the original upgrade path. The
  native guard and `RoomDetails` refresh both read current homeserver state rather
  than trusting an SDK state cache that may not have received another admin's upgrade.
  Charm also compares the room's current version with the advertised target: rooms
  already at that version hide the action, and the command rejects a stale direct
  invocation with a no-upgrade-needed error. If the SDK cannot resolve the room's
  create content, both paths fail closed instead of disagreeing about eligibility.

### Landing in a tombstoned room

- When a room's state includes `m.room.tombstone`, render a persistent banner in
  the timeline (similar treatment to a read-only-room banner, see non-goal overlap
  with the room-directory/announcement-room area — reuse the same banner component
  if one already exists from that work, otherwise this spec introduces it first)
  with a "Go to upgraded room" action using the tombstone's `replacement_room`
  field.
- The composer is replaced by the persistent read-only explanation in a tombstoned
  room, and its drop, paste, picker, and staged-attachment paths are closed with it.
  The asynchronous native picker and attachment size/configuration preflight recheck
  the live write barrier immediately before transport, and any upload already in flight
  is cancelled when the barrier closes, so a tombstone received during any of those
  paths cannot send into the stale room. Attachments, slash
  commands, and ordinary messages therefore cannot be sent from the stale
  conversation surface. Server-mutating message actions are closed too: reactions,
  edits, redactions, retries, reports, and room pin/unpin actions cannot target the
  tombstoned room, while stable read-only and local actions such as copy, copy link,
  forward, view source, and bookmarks remain available. Room settings and the members
  drawer follow the same boundary: profile, access, membership,
  alias, encryption, and power-level mutations are disabled while state is unresolved
  and after a tombstone is present. Native avatar picking and alias-availability checks
  recheck that live write barrier after their asynchronous work completes, including
  alias-state cleanup that would otherwise race a completed directory removal. When
  the barrier closes, Charm pauses the SDK room send queue while authoritative state is
  unresolved, preserving offline messages, and aborts pending local echoes only after a
  tombstone is confirmed. This prevents queued messages from reaching the old room after
  connectivity returns without discarding them during an ordinary refresh. That queue
  ownership survives navigation remounts within one
  account, but logout clears it and invalidates pending transitions so it cannot affect
  a later signed-in session. Failed native queue transitions retain safety ownership
  and retry, since an IPC error alone cannot prove whether the SDK queue changed. Native
  sync applies the same barrier to every affected room, including rooms
  that are not currently open, and serializes barrier changes with queue insertion so a
  send already entering the SDK cannot slip in after the confirmed-tombstone drain.

## Data flow

The new `upgrade_room(room_id) -> replacement_room_id` IPC command resolves the
server-recommended room version from `/capabilities`, verifies the current user's
`m.room.tombstone` power level, and invokes Matrix's typed upgrade endpoint. Existing
timeline state parsing remains useful for in-context notices, while the read-only
decision comes from the room's authoritative current `m.room.tombstone` state in
`RoomDetails`; it therefore remains correct when the tombstone is outside the loaded
timeline window. Room activation always refetches those details and keeps the
composer and room-state mutations fail-closed until the current-state request succeeds;
a failed refetch cannot trust a still-fresh cache entry from before a remote upgrade.
Enabling `room_upgrades` also holds that barrier closed until the persisted flag version
has triggered and completed a fresh authoritative room-details read. The live homeserver
tombstone read is enabled only with `room_upgrades` and uses the keyed tombstone state
endpoint rather than downloading the room's full state on every sync update, preserving
the existing cached/offline behavior while the default-off feature is disabled without
serially amplifying busy sync batches. Sync-driven authoritative refreshes publish the
unresolved barrier before their homeserver requests, and room settings remain blocked
while native feature-flag persistence or the matching authoritative refresh is
outstanding.
The backend includes
timeline state items when either
`timeline_state_events` or `room_upgrades` is enabled, so the upgrade flag remains
self-contained. Following the replacement explicitly joins it when necessary,
refreshes the room list, and retains a pending selection until sync publishes it. If
that follow step fails after the server has upgraded the room, settings stays open and
shows an actionable access error and replacement-room retry instead of closing silently;
that retry remains visible after the tombstone refresh hides the original upgrade action.

## API/contract changes

- New IPC command for initiating an upgrade (admin action).
- New native queue-barrier IPC command pauses/resumes a room send queue and drains
  pending local echoes when the room becomes read-only. Its destructive pause path
  enforces the persisted `room_upgrades` flag; resume remains available for kill-switch
  cleanup.
- The native IPC command enforces `room_upgrades` itself, so a stale webview or
  direct invoke cannot bypass the rollout kill switch.
- `RoomDetails` exposes the current tombstone body and replacement room id so the
  composer gate does not depend on a bounded timeline page.

## Testing strategy

- Frontend coverage verifies the tombstone banner, read-only composer replacement,
  replacement-room navigation, confirmation/error dialog behavior, message-mutation
  gating, power-level gating, native-only feature boundary, and queue-barrier wiring.
- Rust integration coverage upgrades a deliberately older-version room against the
  CI homeserver, hides/rejects an already-current room, rejects a low-power member
  before issuing the endpoint request, and verifies pending local echoes are aborted.
- Remote GitHub Actions remains the verification authority; local Charm checks are
  intentionally not run under the repository policy.

## Trade-offs

- **Composer disabled vs replaced in tombstoned room**: replaced-with-explanation
  was chosen so every sending path is absent while the old room still clearly says
  why it is closed and where the conversation moved.

## Shipped implementation

- Default-off `room_upgrades` feature flag for staged rollout.
- Permission-gated, confirmed room-settings action using the server's recommended
  room version.
- Persistent tombstone handling with replacement-room navigation and a read-only
  old-room surface. The replacement action joins or refreshes before selection and
  reports access failures rather than silently doing nothing.

## What I'd revisit as this grows

- Auto-join-on-tombstone (silently joining the replacement room when a tombstone is
  seen) if that turns out to match user expectations better than a manual click-
  through — start manual/explicit, tighten later only if requested.
