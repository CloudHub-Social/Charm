---
title: Charm 2.0 Spec — Avatars and presence visuals
type: spec
project: Charm 2.0
created: 2026-07-13
status: shipped
---

## Implementation status

Charm now ships the avatar and presence parity work behind the default-off
`avatar_presence_visuals` flag. Group DMs use Matrix room-summary heroes to render
a three-face composite in the room list, while presence is aggregated across all
heroes returned by the SDK (up to five). The default appearance uses a colored
presence ring; users can switch group composites to the ordinary corner dot with
the persisted **Group DM presence rings** setting.

Room member rows now resolve and render their Matrix avatar alongside initials
fallbacks and show presence for joined members. The shared presence contract also
accepts the custom Matrix `dnd` and `busy` values, normalizes them to `dnd`, and
labels the red visual as **Busy**. One-to-one DM dots and every pre-existing avatar
remain unchanged while the flag is disabled.

The room summary carries a bounded `group_dm_members` DTO populated from the SDK's
cached `Room::heroes()` data, so the room list needs no per-row member request.
Frontend component coverage, Rust mapping coverage, a Storybook-compatible
component surface, and a deterministic Playwright journey cover the mosaic,
aggregate state, ring/dot preference, member avatar resolution, and busy state.

**Workstream:** one PR / one agent. New spec from the UI-parity deep-dive
(2026-07-13); two independent agents confirmed these. Owner explicitly flagged
group-DM avatars and presence dots/rings.

## Problem & why now

Charm 2.0's basic avatars are fine (user/room/space avatars + initial fallbacks,
timeline sender avatar, 1:1 DM-header presence dot all covered). But several
identity visuals from Charm 1.0 are missing, and one is a data the app already has
but never renders:

1. **Group-DM composite ("triangle") avatar.** Charm 1.0 renders a mosaic of up to
   3 member faces in a triangular arrangement for group DMs
   (`RoomNavItem.tsx:504-601` + `useGroupDMMembers.ts`). Charm 2.0 shows a single
   generic room-initial circle for every room including group DMs
   (`RoomListItem.tsx:56-65`) — you can't tell who's in a group chat at a glance.
2. **Presence rings + group-DM presence.** Charm 1.0 has two presence styles — a
   corner **dot** for 1:1s and a colored **ring** around the avatar for group DMs
   (`boxShadow: 0 0 0 2px …`, `RoomNavItem.tsx:534`, ring colors `:101-106`), with a
   `groupPresenceRing` toggle (default-on) and aggregated group presence
   (`useGroupPresence`). Charm 2.0's `PresenceDot.tsx` is dot-only, applied only to
   1:1 DMs — no ring style, no toggle, no group-DM presence at all.
3. **Member-list avatars are initials-only.** `MemberRow.tsx:52-63` renders only
   `<AvatarFallback>` (initials) — never `<AvatarImage>` — even though the
   `RoomMemberSummary` DTO already carries `avatar_url`. Every member shows initials,
   never their photo. (Charm 1.0: `MemberTile.tsx:35-59` renders the real image.)
4. **Member-list presence dots.** `MemberRow.tsx` shows no presence indicator; Charm
   1.0 renders a `PresenceBadge` per member (`MemberTile.tsx`, `MembersDrawer.tsx:149`).
5. **DND / "busy" presence state (data-model gap).** Charm 1.0 models a 4th presence
   state, **Dnd** (red ring/badge). Charm 2.0's `PresenceStateDto` is only
   `online | unavailable | offline` — so no red/busy indicator is possible. This is a
   Rust enum + mapping change that also feeds Spec 40 (presence controls).

## Non-goals

- Not presence *privacy controls* (appear-offline, hide typing) — that's Spec 40.
  This spec is the *rendering* of presence, not the user's control over broadcasting
  it. (Coordinate: the DND state, item 5, is shared plumbing — implement the enum
  change once.)
- Not trust shields on avatars — that's Spec 44.
- Not the profile card — Spec 36 (which will host presence/avatar at larger size).

## High-level design

### Group-DM composite avatar

- `GroupDmAvatar` receives the Matrix SDK's room-summary heroes from `RoomSummary`.
  It lays out up to three image+initial faces while retaining all returned heroes
  for presence aggregation. `Room::heroes()` is cached, excludes the signed-in
  user, and caps the data at five, avoiding another member-list query per row.

### Presence dot vs ring + group presence

- Add a **ring** presence variant alongside the existing dot: a colored ring around
  the avatar. Apply per Charm 1.0's rule — **dots for 1:1, rings for group DMs by
  default** — with the persisted `groupPresenceRing` toggle in appearance settings.
- **Group presence aggregation**: compute an aggregate presence for a group DM
  (e.g. "most-present member") to color the ring, matching `useGroupPresence`.
- Ring colors follow the presence-state palette (green online / amber away / red
  DND / grey offline).

### Member-list avatar images + presence

- `MemberRow` renders `<AvatarImage src={resolve(avatar_url)}>` with the existing
  initials fallback — the URL is already in the DTO; wire it to the media resolver
  (Spec 02's `resolve_avatar_thumbnail`).
- Add a presence dot per member row (reuse `PresenceDot`), gated on presence data
  availability.

### DND presence state (shared plumbing)

- Extend `PresenceStateDto` (Rust) to include `dnd`/`busy`, map it from the SDK's
  presence, regenerate bindings. Update `PresenceDot`/ring to render the red/busy
  color. Spec 40 consumes the same enum for the "set my status" side.

## Data flow

- Group-DM member subset: additive `RoomSummary.group_dm_members`, populated from
  `Room::heroes()` during the existing room snapshot.
- Member avatar images: reuse Spec 02 media resolver; no new data (DTO already has
  `avatar_url`).
- Presence: extend the presence DTO enum (Rust) + the presence stream already in
  place; group aggregation can be frontend-side over per-member presence.

## API/contract changes

- `PresenceStateDto` gains a DND/busy variant (ts-rs regen).
- `RoomSummary` gains `group_dm_members: GroupDmAvatarMember[]`.
- No change to the media resolver (reused).

## Testing strategy

- Frontend: group-DM room renders the triangle composite (3 faces + fallbacks);
  1:1 renders a single avatar + dot; group DM renders a ring; ring toggle flips
  dot↔ring; member rows render real avatar images (not just initials) and presence
  dots; DND state renders the red color.
- Storybook + axe: avatar/presence variants (1:1 dot, group ring, DND, member row
  with image) through the a11y gate.
- Rust: presence enum includes DND and maps both `dnd` and `busy`; room snapshots
  expose the SDK's bounded hero subset.
- Manual: a real group DM shows member faces; a member with an avatar shows their
  photo in the member list.

## Trade-offs

- **Composite avatar cost**: using `Room::heroes()` adds no per-row member request;
  render only three faces (matching 1.0) and aggregate at most five cached heroes.
- **Ring vs dot default**: follow Charm 1.0 exactly (dot for 1:1, ring for group,
  toggle default-on) rather than inventing new rules — users migrating expect it.

## What I'd revisit as this grows

- Avatar image crop/upload (Spec 36 area) — separate.
- Animated/typing presence on avatars if desired later.
