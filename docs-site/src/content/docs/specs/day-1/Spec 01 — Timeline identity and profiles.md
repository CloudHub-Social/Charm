---
title: "Charm 2.0 Spec — Timeline identity and profiles"
type: spec
project: Charm 2.0
created: "2026-07-04"
status: shipped
---
**Workstream:** one PR / one agent. **Tier:** Day-1 launch-critical.

## Problem & why now
Every human-facing surface currently shows raw Matrix IDs instead of people and
rooms. In `src/features/rooms/ChatShell.tsx` the sender label renders
`message.sender` verbatim (`@alice:example.org`) and the avatar is an
initials-on-color square keyed off that MXID. In `RoomListItem.tsx` the room
avatar is likewise initials-only, and `roomDisplay.ts#displayName` falls back to
the bare `room_id` when `RoomSummary.name` is `null`. There is no notion of the
signed-in user's own profile anywhere. This reads as a developer tool, not a
messenger, and it's the single most visible gap for a Day-1 build. The Rust side
already holds everything needed (matrix-rust-sdk keeps room members and profiles
in the synced state store) — the IPC contract just doesn't carry it yet.

## Current state (in repo)
- `src-tauri/src/matrix/timeline.rs` — `RoomMessageSummary { event_id, sender,
  body, timestamp_ms }`. `events_to_summaries()` populates `sender` from
  `original.sender.to_string()` only; no display name / avatar.
- `src-tauri/src/matrix/mod.rs` — `RoomSummary { room_id, name: Option<String>,
  unread_count }`; `snapshot_rooms()` builds it from `room.name()` +
  `room.unread_notification_counts()`. Emitted on `room_list:update`; live
  timeline events emit `timeline:update` (`RoomTimelineUpdate`).
- `src/lib/matrix.ts` — hand-authored TS mirror of these structs (a comment flags
  that ts-rs generation into `src-tauri/src/bindings/` isn't wired to the
  frontend yet; today the frontend imports from `matrix.ts`, not `bindings/`).
- `src/features/rooms/roomDisplay.ts` — `displayName`, `initials`, `avatarColor`
  (deterministic hash → token color). No image support.
- `src/components/ui/avatar.tsx` — Radix avatar with `AvatarImage` available but
  only `AvatarFallback` is used at both call sites.

## Scope (in)
1. Sender **display name + avatar** in the timeline (per-message, resolved from
   room membership at the event's sender).
2. Room **display name + avatar** in the room list (`RoomSummary` extended).
3. The signed-in user's **own profile**: display name, avatar, and a
   presence/status indicator, surfaced via a new command + event for the app
   chrome (room-list header / future account switcher).
4. A per-room **member profile cache** in Rust and **live profile-change
   updates** pushed to the frontend when a member's name/avatar changes.
5. mxc→local-file avatar resolution wired through the media cache from Spec 02,
   with an **initials fallback that works with zero image plumbing** (so this
   spec is shippable before Spec 02 lands).

## Non-goals (out)
- Full member-list UI / room-info panel (later).
- Rich presence (typing, last-active timestamps, custom status text beyond
  online/unavailable/offline).
- Cross-account / multi-account profile handling (single account for Day-1).
- Editing your own profile (display name / avatar upload) — read-only here.
- Avatar image *fetching/caching* internals — owned by Spec 02; this spec only
  consumes the mxc→local-path resolver it exposes.

## Design & approach

### Rust: new/changed modules, matrix-rust-sdk APIs
- **New module `src-tauri/src/matrix/profiles.rs`** owning member/profile
  resolution and the per-room member cache.
- **Member resolution:** for a given room + sender, use
  `room.get_member(user_id)` → `matrix_sdk::room::RoomMember` and read
  `member.display_name()` (falls back to `None`), `member.avatar_url()`
  (`Option<&MxcUri>`), and disambiguation via `member.name()`. Prefer the async
  `room.get_member(...)` (hydrates from store) over `get_member_no_sync` on the
  first miss; cache the result thereafter.
- **Own profile:** `client.account().get_profile()` (or the cached
  `client.account().get_cached_avatar_url()` / `client.user_id()`), plus
  `client.account().get_display_name()`. Presence via the sync response's
  `presence` events (`ruma::events::presence::PresenceEvent`,
  `PresenceState::{Online, Unavailable, Offline}`).
- **mxc→local path:** call the Spec 02 resolver
  (`media::resolve_avatar_thumbnail(mxc, size)` → `Option<PathBuf>`) to turn an
  `avatar_url()` mxc into a cached local file path for a small (e.g. 96px)
  thumbnail. If Spec 02 isn't merged yet, this returns `None` and the frontend
  uses initials — no hard dependency for first ship.
- **Per-room member cache:** `HashMap<OwnedRoomId, HashMap<OwnedUserId,
  MemberProfile>>` guarded by a `Mutex`, stored on `MatrixState` (extend the
  struct in `mod.rs`). Populated lazily on timeline summarization and on demand.
- **Live updates:** register an event handler in `spawn_sync_loop`
  (`client.add_event_handler(...)` for `SyncRoomMemberEvent` /
  `ruma::events::room::member::RoomMemberEventContent`). On a membership/profile
  change, invalidate the cache entry and emit a new **`profile:update`** event.
  Room avatar/name changes (`m.room.avatar`, `m.room.name`) already flow through
  `room_list:update`; extend `snapshot_rooms()` to include the new fields there.

### Changed: `events_to_summaries` (timeline.rs)
Enrich each `RoomMessageSummary` with resolved sender identity. Because
`events_to_summaries` is a sync (non-async) helper today and is called from both
`get_timeline_page` and the sync callback, pass in a resolved
`&HashMap<OwnedUserId, MemberProfile>` snapshot (built once per page/sync-batch
via `profiles.rs`) rather than doing an async lookup per event.

### IPC types (ts-rs bindings to add — `src-tauri/src/bindings/`)
- Extend `RoomMessageSummary` (timeline.rs):
  `sender_display_name: Option<String>`, `sender_avatar_url: Option<String>`
  (the mxc, so the frontend can key its own cache), `sender_avatar_path:
  Option<String>` (resolved local file path, `None` until Spec 02).
- Extend `RoomSummary` (mod.rs): `avatar_url: Option<String>`,
  `avatar_path: Option<String>`, `is_direct: bool` (so DMs can show the peer's
  name/avatar instead of a room name).
- New `OwnProfile { user_id, display_name: Option<String>, avatar_url:
  Option<String>, avatar_path: Option<String>, presence: PresenceStatus }` where
  `PresenceStatus` is a `#[serde(rename_all="snake_case")]` enum
  `{ Online, Unavailable, Offline }`.
- New `ProfileUpdate { room_id: String, user_id: String, display_name:
  Option<String>, avatar_url: Option<String> }` for the `profile:update` event.
- **New command `get_own_profile() -> OwnProfile`** (registered in
  `lib.rs#invoke_handler`). Own-profile changes also re-emit via a
  **`profile:self`** event from the sync loop.
- Mirror all of the above by hand in `src/lib/matrix.ts` (matching the existing
  pattern) until ts-rs → frontend generation is wired.

### Frontend: components/hooks/atoms, surfaces changed
- `src/features/rooms/roomDisplay.ts` — keep initials/color helpers; add a
  `resolveAvatar(path, mxc)` helper returning a `convertFileSrc(path)` URL (Tauri
  asset protocol) when a local path exists, else `undefined` (→ fallback).
- `ChatShell.tsx` — render `sender_display_name ?? sender` as the name label and
  feed `AvatarImage src={resolveAvatar(...)}` with the existing `AvatarFallback`
  underneath. Message-grouping logic (5-min window per the design system) stays.
- `RoomListItem.tsx` — same `AvatarImage`/fallback treatment for room avatars;
  use `is_direct` to pick peer identity for DM display.
- New `useOwnProfile()` hook (TanStack Query over `get_own_profile`, invalidated
  by `profile:self`) feeding a profile chip in the `RoomList` header (currently
  just the static "Charm" wordmark) — avatar + display name + presence dot.
- New Jotai atom-family `memberProfileAtomFamily` keyed by `roomId:userId`,
  updated from `profile:update` events, so re-resolution is O(1) and shared.

## Acceptance criteria
1. A timeline message from a room member with a set display name renders that
   name (not the MXID) as the sender label; a member with no display name falls
   back to the MXID.
2. A member with a set avatar renders their image once Spec 02's resolver returns
   a path; with no avatar (or Spec 02 absent) the deterministic initials avatar
   renders — no broken image.
3. The room list shows each room's avatar image when set, initials otherwise, and
   its human name; a `null`-named DM shows the peer's name, not the room ID.
4. `get_own_profile` returns the signed-in user's display name, avatar, and a
   presence value in `{online, unavailable, offline}`; the room-list header shows
   all three.
5. When a member changes their display name or avatar, an open timeline for that
   room updates the sender label/avatar without a manual refetch (via
   `profile:update`).
6. Member profiles are resolved from cache on repeat access — no redundant
   `get_member` network/store round-trip per message render.
7. All new/changed IPC structs have ts-rs exports in `src-tauri/src/bindings/`
   and matching hand-mirrored types in `src/lib/matrix.ts`.

## Testing
- **cargo test** (`src-tauri/tests/`, mirroring `alias_resolution.rs` pattern
  against local Synapse in `dev/synapse/`): create two accounts, set display
  names/avatars, join a shared room, assert `RoomMessageSummary` carries the
  resolved `sender_display_name`/`sender_avatar_url`; assert `RoomSummary` carries
  room name/avatar. Unit-test the member-cache invalidation logic (pure) with a
  synthetic `RoomMemberEventContent` the way `sso_state_tests` unit-tests pure
  helpers inline.
- **cargo test** for `get_own_profile` shape and presence mapping.
- **vitest + RTL** — `ChatShell` renders display name over MXID and falls back
  correctly; `RoomListItem` renders image vs. initials by presence of
  `avatar_path`; `useOwnProfile` updates on a mocked `profile:self` event;
  `roomDisplay.resolveAvatar` returns fallback for `null` path.
- **Playwright** — against the web build with a mocked IPC layer: room list and
  an open room show names + avatars; assert no raw `@user:server` strings leak
  into the sender label when a display name exists.
- **Storybook + axe** — a `SenderIdentity` / room-list-item story with/without
  avatar; contrast check on presence dot.

## Dependencies & sequencing
- **Soft-depends on Spec 02 (Media & attachments)** only for real avatar images:
  it provides `media::resolve_avatar_thumbnail` (mxc→local thumbnail path) and
  the LRU media cache. Ship order: this spec can merge first with initials-only
  avatars; wire `avatar_path` once Spec 02's resolver exists (additive, no schema
  change — the field is already `Option`).
- Depends on the existing sync-loop / `room_list:update` / `timeline:update`
  wiring already in `mod.rs` (present).

## Risks & open questions
- **Per-message resolution cost:** resolving members inside the sync callback
  must stay cheap; the snapshot-map approach avoids per-event async calls but
  needs a cache-warm step. Risk of a first-render flash of MXIDs before the map
  populates — acceptable, but confirm.
- **Disambiguation:** two members with the same display name should get
  disambiguated (`member.name()` gives the disambiguated form) — decide whether
  to disambiguate in Rust or frontend.
- **Presence reliability:** many homeservers disable/limit presence (Synapse
  often does). `Offline`/`Unavailable` may be the common case; confirm the dev
  Synapse (`dev/synapse/`) has presence enabled for testing, else stub.
- **Avatar path vs. mxc in bindings:** carrying both `sender_avatar_url` (mxc)
  and `sender_avatar_path` (local) is mild redundancy; keep both so the frontend
  can cache-key on mxc and Spec 02 can be wired independently.

## Effort estimate
**M.** Mostly additive IPC-field plumbing plus one new module and one event; the
member cache + live-update handler is the only genuinely new subsystem, and the
image path is deferred to Spec 02.

## Status update (2026-07-06)

Implemented and PR opened: [CloudHub-Social/Charm#22](https://github.com/CloudHub-Social/Charm/pull/22) (branch `feat/spec-01-timeline-identity`). Delivered sender display name/avatar in the timeline via matrix-sdk-ui's `sender_profile()` (no bespoke cache needed — made redundant by Spec 14 landing first), room display name/avatar in the room list (`Room::heroes()`/`avatar_url()`, plus a new `dm_peer_user_id` field), `get_own_profile`/`profile:self` for the signed-in user's own profile, and un-gated the ChatShell/RoomListItem presence dots for DM rooms via a new shared `PresenceDot` component.

**Open follow-up:** reconcile with Spec 08's own `ProfileSummary` (08 shipped before 01 merged) — see the Day-1 spec index and Charm 2.0's Active Tasks (2026-07-06 addition).
