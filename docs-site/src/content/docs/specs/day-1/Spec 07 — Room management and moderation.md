---
title: "Charm 2.0 Spec — Room management and moderation"
type: spec
project: Charm 2.0
created: "2026-07-04"
status: shipped
---

**Workstream:** one PR / one agent. **Tier:** Day-1 launch-critical.

## Problem & why now

Charm 2.0 can list rooms (`list_rooms` → `RoomSummary`), render timelines, and send
messages, but it exposes **no room administration whatsoever**. A user can't rename a
room, change its topic/avatar, adjust who can join, toggle encryption, promote a
moderator, or invite/kick/ban anyone. Every room the user creates or manages elsewhere
is read-only for governance in Charm. There is also no **right panel** — the chat is a
two-column shell (`RoomList` + `ChatShell`), so there's nowhere to surface room info or
the member list. This is table-stakes for a Matrix client and blocks dogfooding any room
where the user is an admin/mod. Do it now because the state-event and member APIs are a
self-contained slice that doesn't depend on Day-2 timeline features.

## Current state (in repo)

- `src-tauri/src/matrix/mod.rs` — `MatrixState { client: Mutex<Option<Client>> }`,
  `require_client()`, `snapshot_rooms()`, and the sync loop emitting `room_list:update`.
  `RoomSummary { room_id, name: Option<String>, unread_count }` is the only room binding.
- `list_rooms` reads `client.rooms()` from the local store (no network). No per-room
  detail command exists.
- Commands registered in `src-tauri/src/lib.rs` `invoke_handler![…]`.
- IPC types derive `#[ts(export, export_to = "../src/bindings/")]`; the frontend mirror
  in `src/lib/matrix.ts` is **hand-authored** (documented as "keep in sync manually
  until a build step wires ts-rs export"). New types must be added in both places.
- Frontend shell: `src/features/rooms/RoomsScreen.tsx` renders
  `<RoomList/> <ChatShell/> <VerificationOverlay/>` inside `flex h-screen`. Display
  helpers live in `src/features/rooms/roomDisplay.ts` (`avatarColor`, `initials`,
  `displayName`). UI primitives in `src/components/ui/`: dialog, dropdown-menu, popover,
  tabs, tooltip, input, label, button, avatar.
- No Jotai/TanStack Query wiring exists yet in the rooms feature (local `useState`);
  this spec introduces the first `useRoom()`-style hook + query usage there.

## Scope (in)

1. **Room settings**: view/edit name, topic, avatar; join rules; history visibility;
   E2EE toggle (enable-only, one-way).
2. **Power levels**: view current PLs; edit a specific member's PL; edit the PL required
   for key actions (invite, kick, ban, redact, send state, and the default event PL).
3. **Member management**: member list (with membership + PL), invite by MXID, kick, ban,
   unban.
4. **Right panel**: a third column (`RoomInfoPanel`) with two sub-tabs — **Info** (room
   settings entry points) and **Members** — toggled from the chat header.
5. **Permission gating**: every mutating control is disabled (with tooltip reason) when
   the signed-in user's PL is insufficient for that action.

## Non-goals (out)

- Right-panel **Pinned / Files / Links** tabs — Day-2 (leave a disabled/hidden tab stub,
  do not build).
- Creating rooms, leaving rooms, room directory/publishing, aliases management,
  space hierarchy, upgrading room versions.
- Ignoring/blocking users at the account level (moderation is room-scoped here).
- Server ACLs, reporting content, redaction UI (redaction is a timeline concern).
- Editing another user's profile; guest access rules beyond join-rules enum.
- Optimistic UI for state changes — re-read after the SDK confirms (state events are
  reflected via sync).

## Design & approach

### Rust modules / matrix-rust-sdk APIs

New module `src-tauri/src/matrix/room_admin.rs` (declared `pub mod room_admin;` in
`mod.rs`). All commands resolve the room via a helper:

```rust
async fn require_room(state, room_id: &str) -> Result<matrix_sdk::Room, String> {
    let client = state.require_client().await?;
    let id = RoomId::parse(room_id).map_err(|e| e.to_string())?;
    client.get_room(&id).ok_or_else(|| "room not found".into())
}
```

matrix-rust-sdk `Room` APIs used:

- **Name / topic**: `Room::set_name(String)`, `Room::set_room_topic(&str)`.
- **Avatar**: `Room::upload_avatar(&mime, data, None)` (uploads + sets
  `m.room.avatar`); read current via `Room::avatar_url()`.
- **Join rules**: send `m.room.join_rules` via
  `Room::send_state_event(RoomJoinRulesEventContent::new(JoinRule::{Public|Invite|Knock|Restricted|…}))`.
  Read current via `Room::join_rule()`.
- **History visibility**: `Room::send_state_event(RoomHistoryVisibilityEventContent::new(HistoryVisibility::{Shared|Invited|Joined|WorldReadable}))`;
  read via `Room::history_visibility()` (fall back to `Shared` when unset).
- **Encryption toggle**: `Room::enable_encryption()` (one-way; there is no disable in
  Matrix — the UI must present this as an irreversible switch with a confirm dialog).
- **Power levels**: `Room::power_levels().await -> RoomPowerLevels` for the full snapshot
  (per-user map + per-action `Int` thresholds: `invite`, `kick`, `ban`, `redact`,
  `events_default`, `state_default`, `users_default`). Mutate a single user with
  `Room::update_power_levels(vec![(&UserId, Int)])`; mutate action thresholds by building
  a `RoomPowerLevelChanges` from the current `RoomPowerLevels` and calling
  `Room::apply_power_level_changes(changes)`.
- **Members**: `Room::members(RoomMemberships::all())` (or `::JOIN | ::INVITE | ::BAN`) →
  `Vec<RoomMember>`; each exposes `user_id()`, `display_name()`, `avatar_url()`,
  `power_level()`, `membership()` (`MembershipState`). Actions:
  `Room::invite_user_by_id(&UserId)`, `Room::kick_user(&UserId, Option<&str> reason)`,
  `Room::ban_user(&UserId, reason)`, `Room::unban_user(&UserId, reason)`.
- **Permission checks** (source of truth for gating, computed server-consistently by the
  SDK): `Room::can_user_invite(uid)`, `can_user_kick`, `can_user_ban`,
  `can_user_send_state(StateEventType::RoomName | RoomTopic | RoomAvatar | RoomJoinRules |
  RoomHistoryVisibility | RoomPowerLevels | RoomEncryption)`. Compute these for the
  **current user** (`client.user_id()`) once when building `RoomDetails`.

### New commands (registered in `lib.rs`)

- `get_room_details(room_id) -> RoomDetails`
- `get_room_members(room_id) -> Vec<RoomMemberSummary>`
- `set_room_name(room_id, name)`
- `set_room_topic(room_id, topic)`
- `set_room_avatar(room_id, mime, data: Vec<u8>)` — data as bytes from a frontend file
  read; also `remove_room_avatar(room_id)` sending empty `m.room.avatar`.
- `set_room_join_rule(room_id, join_rule: JoinRuleKind)`
- `set_room_history_visibility(room_id, visibility: HistoryVisibilityKind)`
- `enable_room_encryption(room_id)`
- `set_member_power_level(room_id, user_id, power_level: i64)`
- `set_room_power_level_thresholds(room_id, changes: PowerLevelThresholds)`
- `invite_member(room_id, user_id)`, `kick_member(room_id, user_id, reason?)`,
  `ban_member(room_id, user_id, reason?)`, `unban_member(room_id, user_id, reason?)`

No new event stream is required for correctness: state changes arrive through the
existing sync loop. Add one **narrow typed event** `room_details:update` (payload
`RoomDetails`) emitted from the sync callback in `mod.rs` when the active room's state
events change, so an open right panel refreshes without polling. (Emit unconditionally
per joined-room update that carries state events; the frontend filters by `room_id`,
mirroring the existing `timeline:update` pattern.)

### ts-rs IPC types (new, `#[ts(export, export_to="../src/bindings/")]`)

```rust
pub struct RoomDetails {
    pub room_id: String,
    pub name: Option<String>,
    pub topic: Option<String>,
    pub avatar_url: Option<String>,          // mxc:// — resolved to http by frontend
    pub is_encrypted: bool,
    pub join_rule: JoinRuleKind,             // enum: Public|Invite|Knock|Restricted|Private
    pub history_visibility: HistoryVisibilityKind, // Shared|Invited|Joined|WorldReadable
    pub member_count: u64,
    pub my_power_level: i64,
    pub power_levels: PowerLevelThresholds,  // invite/kick/ban/redact/events_default/state_default/users_default
    pub can: RoomPermissions,                // booleans, see below
}
pub struct RoomPermissions {                 // current user, precomputed via can_user_*
    pub set_name: bool, pub set_topic: bool, pub set_avatar: bool,
    pub set_join_rules: bool, pub set_history_visibility: bool,
    pub set_encryption: bool, pub set_power_levels: bool,
    pub invite: bool, pub kick: bool, pub ban: bool,
}
pub struct RoomMemberSummary {
    pub user_id: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub power_level: i64,
    pub membership: MembershipKind,          // Join|Invite|Ban|Leave|Knock
}
pub struct PowerLevelThresholds {
    pub invite: i64, pub kick: i64, pub ban: i64, pub redact: i64,
    pub events_default: i64, pub state_default: i64, pub users_default: i64,
}
```

Add hand-authored mirrors of all of the above to `src/lib/matrix.ts` plus wrapper
functions (`getRoomDetails`, `getRoomMembers`, `setRoomName`, …, `banMember`, and
`onRoomDetailsUpdate(roomId, cb)` following the `onTimelineUpdate` pattern).

### Frontend components / hooks / atoms + surfaces changed

New feature dir `src/features/room-info/`:

- `RoomInfoPanel.tsx` — the right column. Uses `Tabs` (`src/components/ui/tabs.tsx`) with
  **Info** and **Members** tabs (+ a disabled **Pinned** tab stub labeled "Coming soon").
- `RoomSettingsForm.tsx` — name/topic inputs, avatar upload (file picker →
  `set_room_avatar`), join-rule + history-visibility dropdowns (`dropdown-menu`),
  encryption toggle button with a confirm `Dialog`. Each control reads `details.can.*`
  and is `disabled` with a `Tooltip` ("You need a higher power level").
- `MemberList.tsx` + `MemberRow.tsx` — avatar (reuse `avatarColor`/`initials`), name,
  PL badge, membership state; a per-row `dropdown-menu` with Kick/Ban/Unban/Set PL,
  each gated on `details.can.*`. `InviteMemberDialog.tsx` — MXID input + validate.
- `PowerLevelEditor.tsx` — set a member's PL (preset roles Admin 100 / Moderator 50 /
  Default 0 via a select, plus a raw number input) and edit action thresholds.

Hooks/state (first use of the stack in this feature):

- `useRoomDetails(roomId)` — TanStack Query `useQuery(['room-details', roomId], …)`
  seeded by `get_room_details`, invalidated on `room_details:update`.
- `useRoomMembers(roomId)` — `useQuery(['room-members', roomId], …)`, invalidated on the
  same event. Mutations (`useMutation`) call the setter commands then invalidate.
- Jotai atom-family `rightPanelOpenAtom(roomId)` for panel visibility.

Surfaces changed:

- `src/features/rooms/RoomsScreen.tsx` — add the third column; render `RoomInfoPanel`
  when `rightPanelOpenAtom` is set for the active room.
- `src/features/rooms/ChatShell.tsx` — make the header room name a button that toggles
  the right panel (add an info/members affordance in the header).

## Acceptance criteria

1. Opening the right panel on a joined room shows current name, topic, avatar, join rule,
   history visibility, encryption status, and member count, all matching the homeserver.
2. Editing name and topic persists and is reflected in `RoomList` and the chat header
   after the change round-trips through sync (no manual refresh).
3. Uploading a new room avatar updates `m.room.avatar`; the new avatar appears in the
   panel and room list.
4. Changing the join rule and history visibility sends the correct state events and the
   panel reflects the new values.
5. Enabling encryption on an unencrypted room sends `m.room.encryption`, requires a
   confirm step, and the toggle becomes a permanent "Encrypted" indicator (no disable).
6. Member list shows every member with correct display name, PL, and membership state,
   including banned users (shown under a Banned grouping with an Unban action).
7. Invite by valid MXID adds the user as `invite`; invalid MXID shows an inline error and
   sends no request.
8. Kick, ban, and unban each perform the correct SDK call and the member's membership
   state updates after sync.
9. Setting a member's power level via preset or raw number persists and is visible on the
   member row.
10. Editing an action threshold (e.g. `kick`) persists to `m.room.power_levels`.
11. **Gating**: when the signed-in user's PL is below the threshold for an action, the
    corresponding control is disabled with a tooltip explaining why, for every action in
    scope. A user with sufficient PL sees the controls enabled.
12. All new IPC types exist as ts-rs bindings in `src/bindings/` **and** as matching
    hand-authored types in `src/lib/matrix.ts`.

## Testing

- **Rust (`cargo test`, network-gated `tests/` against local Synapse, mirroring the
  existing `alias_resolution`/SSO test rationale)**: create a room as admin, exercise
  `set_room_name`/`set_room_topic`/`set_room_join_rule`/`set_room_history_visibility`,
  `enable_room_encryption`, `invite_member`/`kick_member`/`ban_member`/`unban_member`,
  and `set_member_power_level`; assert the resulting room state. Add a second test user
  with low PL and assert `RoomPermissions` booleans come back `false` and that a mutating
  call errors.
- **ts-rs binding drift**: a `cargo test` that exports bindings; CI check that
  `src/bindings/RoomDetails.ts` etc. exist. Add a unit test asserting the `matrix.ts`
  mirror shape (keys) matches the generated binding (guard against manual-sync drift).
- **Vitest + RTL** (coverage floor): `RoomSettingsForm` disables controls when
  `can.set_name === false`; `MemberRow` dropdown hides/disables Kick when `can.kick`
  false; `InviteMemberDialog` rejects a malformed MXID; panel re-renders on a mocked
  `room_details:update`.
- **Storybook + axe**: stories for `RoomInfoPanel` (admin vs. read-only member), `MemberRow`,
  `PowerLevelEditor`; axe passes; 44×44 hit targets on row actions.
- **Playwright + tauri-driver**: open panel from chat header, rename a room end-to-end,
  invite a user, confirm the member appears.

## Dependencies & sequencing

- Depends on existing session/sync wiring (`mod.rs`) and `RoomSummary`; no dependency on
  Day-2 timeline work.
- Introduces the first TanStack Query + Jotai usage in the rooms feature — coordinate the
  `QueryClientProvider`/Jotai `Provider` placement in `src/App.tsx` (shared with Spec 08).
- Right-panel column layout should land before/with any future Pinned/Files work.
- No dependency on Spec 08 (settings), but both add commands to the same `invoke_handler!`
  list and both introduce query/atom providers — land whichever first, rebase the other.

## Risks & open questions

- **PL edit foot-guns**: raising a user to 100 or lowering your own PL is irreversible via
  the UI. Require a confirm dialog for PL ≥ your own and for self-demotion.
- **`RoomPowerLevelChanges` API surface** may differ slightly across matrix-rust-sdk
  versions (`update_power_levels` vs. `apply_power_level_changes`); verify against the
  pinned version in `src-tauri/Cargo.toml` before finalizing command signatures.
- **Avatar bytes over IPC**: sending `Vec<u8>` through Tauri is fine for small images but
  set a size cap (e.g. 5 MB) and validate MIME in Rust.
- **`room_details:update` granularity**: emitting on every state-carrying sync update is
  simple but slightly chatty; acceptable given frontend filtering. Revisit if noisy.
- **Restricted join rule** needs an allow-list (space IDs); Day-1 exposes the enum value
  but the allow-list editor is out of scope — decide whether to disable `Restricted` in
  the dropdown when no allow-list UI exists (recommended: disable with tooltip).

## Effort estimate

**L** — broad command surface (≈15 commands), three new IPC structs plus enums, a full
new UI column with settings + member management + PL editing, and permission gating
threaded through every control; the moderation actions themselves are thin SDK wrappers,
but the panel UI and gating are the bulk of the work.
