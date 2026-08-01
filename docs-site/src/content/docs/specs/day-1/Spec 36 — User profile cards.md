---
title: Charm 2.0 Spec — User profile cards
type: spec
project: Charm 2.0
created: 2026-07-13
status: in-progress
---

**Workstream:** staged delivery. Extends Spec 01 (timeline identity & profiles),
which shipped **own-profile** editing but no way to view or act on *other* users.

The first slice establishes the desktop/web read contracts and default-off
`user_profile_cards` flag. The second slice upgrades the existing mention-pill
dialog into a profile card and adds message-sender entry points across all three
timeline layouts. Later slices add member-list entry, actions, and room-scoped
profile writes.

## Problem & why now

A deep parity audit (2026-07-13) found Spec 01's biggest omission: Charm 2.0 has no
user-profile surface for anyone but yourself. Clicking a member or an avatar in
Charm 2.0 opens only an admin action menu (`src/features/room-info/MemberRow.tsx`
lines ~70-114: kick/ban/set-power-level) — there is no profile card. Charm 1.0 has
a full one (`src/app/components/user-profile/UserRoomProfile.tsx`,
`UserHero.tsx`, `UserChips.tsx`) showing presence, mutual rooms, per-room profile,
and per-user actions. This is a table-stakes gap — "tap someone's name to see who
they are / DM them / ignore them" is a universal chat expectation.

## Non-goals

- Not a redesign of the admin/moderation action menu (kick/ban/power-level) — that
  stays (Spec 07). The profile card *hosts* those admin actions for privileged
  users rather than replacing the menu, but this spec doesn't re-scope moderation.
- Not a global address book / user directory search (that's a separate discovery
  concern) — this is the profile of a user you can already see (a room member, a
  message sender, a mention).

## High-level design

A profile card/drawer (reuse the existing right-panel slot pattern used by
room-info/member-list, or a popover — pick whichever matches how `MemberRow` is
currently surfaced) opened by: clicking a member in the members list, clicking a
message sender's avatar/name, or clicking an interactive mention pill (see below).
Contents, each mapping to a confirmed Charm 1.0 capability:

- **Identity:** avatar (full-size), display name, user ID with a **copy button**
  and copy-permalink (`matrix.to/#/@user`) — Charm 1.0 `UserHero.tsx:279-289`. Today
  Charm 2.0 shows the ID as static text (`MemberRow.tsx:67`), no copy.
- **Presence:** online/away/offline + **status message** + **last-active-ago** —
  Charm 2.0 already has `PresenceDot`/`usePresence` and the `status_msg` /
  `last_active_ago_ms` fields exist in the `PresenceUpdate` DTO but are never
  rendered; this card is where they finally surface.
- **Mutual rooms:** list of rooms you share with this user — Charm 1.0
  `UserChips.tsx:500-560` / `useMutualRooms.ts`. Needs a new read path (see data
  flow).
- **Actions:** start/open DM, **ignore/block** (contextual — today Charm 2.0 only
  has a Settings-page block list `settings/BlockedUsersCard.tsx`, no ignore-from-
  context), plus admin actions (kick/ban/power-level) for privileged users, gated
  by Spec 07's existing power-level checks.
- **Per-room profile:** ability to set **your own** per-room display name/avatar
  (`/myroomnick`, `/myroomavatar` — Charm 1.0 `useCommands.ts:248-249`), and to see
  a user's room-specific profile vs their global one. This is the write side of
  per-room identity that Spec 01 only ever did account-wide.

### Interactive mention pills

Charm 2.0 currently renders mentions inside `formatted_body` as sanitized,
non-interactive HTML links (`BubbleMessageRow.tsx:120` / `messageRowShared.tsx`).
This spec makes a mention of a user open that user's profile card (intercept the
click the same way `handleMessageLinkClick` already intercepts link clicks), rather
than treating it as an external link.

### Own-avatar crop (minor)

Charm 1.0 crops an avatar after upload (via its `image-editor/`); Charm 2.0's
`AccountPanel.tsx` does a raw file upload with no crop. Add a simple crop step —
small, and it overlaps day-2 Spec 08 (image editing); if that spec lands first,
reuse its crop tool rather than building a second one.

## Data flow

New IPC read: `get_user_profile(user_id, room_id?) -> UserProfile` returning global
+ optional room-specific display name/avatar and best-effort presence, and
`get_mutual_rooms(user_id) -> MutualRoomSummary[]`. The mutual-room shape is
deliberately narrower than the room-list `RoomSummary`: profile cards do not need
notification counts, tags, or message previews. Ignore/DM/per-room-profile-set
reuse existing commands where they exist (`BlockedUsersCard` already has an
ignore mutation to reuse; DM creation already exists). Per-room nick/avatar is a
state-event send of the user's own `m.room.member` content — confirm the SDK
helper before hand-rolling.

## API/contract changes

- New `get_user_profile` / `get_mutual_rooms` IPC commands (ts-rs bindings).
- Matching authenticated web-companion routes; browser clients never receive
  another account's session or SDK store.
- Surface `status_msg` / `last_active_ago_ms` (already in the DTO) to the card.
- New `set_room_profile(room_id, display_name?, avatar?)` command for per-room
  identity.
- `UserProfile` is the canonical profile-card DTO. The older own-account
  `OwnProfile` and settings-only `ProfileSummary` remain compatibility shapes
  until the card surface migrates their consumers in the next slice.

## Testing strategy

- Frontend: profile card renders identity/presence/mutual-rooms/actions from
  fixture data; mention-pill click opens the card; ignore/DM actions dispatch the
  right mutations; admin actions gated by power level.
- Rust: `get_mutual_rooms` correctness; `set_room_profile` sends correct
  `m.room.member` content scoped to the room.
- Manual: open a real user's card, confirm mutual rooms and presence status message
  actually populate, and that per-room nick change is visible to a second client.

## Trade-offs

- **Card hosts admin actions vs keeping a separate admin menu**: consolidating into
  one profile surface matches Charm 1.0 and avoids two competing "click a user"
  affordances; the existing `MemberRow` admin menu becomes a section of the card
  rather than a parallel path.
- **Global profile lookup can fail while room membership is readable**: when a
  caller supplies a shared room, Charm still returns its room-scoped membership
  profile and leaves unavailable global fields empty. With no readable room
  membership, a failed global lookup remains an error rather than fabricating an
  empty user.

## What I'd revisit as this grows

- Shared-media / shared-files-with-this-user view if requested (Charm 1.0 doesn't
  strongly have this, so not built now).

## Implementation status

- Merged: canonical `UserProfile` and privacy-minimal `MutualRoomSummary`
  contracts, desktop commands, web routes, and the default-off feature flag in
  [#323](https://github.com/CloudHub-Social/Charm/pull/323).
- Merged: the profile card in
  [#329](https://github.com/CloudHub-Social/Charm/pull/329) renders room-aware
  identity, presence/status, account-isolated mutual-room queries and navigation;
  mentions retain their existing entry point, while sender avatars/names/nicks
  become keyboard accessible entry points only when `user_profile_cards` is
  enabled. A real-account nightly smoke test confirmed the sender entry point,
  synchronized presence, and mutual-room list.
- Remaining: migrate the two legacy own-profile DTO consumers, add member-list
  entry, render last-active time and identity copy actions, wire
  DM/block/moderation actions, and implement `set_room_profile`.
