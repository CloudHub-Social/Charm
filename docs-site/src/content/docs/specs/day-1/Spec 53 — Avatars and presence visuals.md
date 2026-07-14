---
title: Charm 2.0 Spec — Avatars and presence visuals
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
---

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

- A `GroupAvatar` component that, for a room that is a group DM (direct + >2 members),
  fetches up to 3 joined non-bot members (sorted by recent activity, matching
  `useGroupDMMembers`) and lays their avatars out in the triangular arrangement, each
  with its own image+initials fallback. Used in the room list row (and anywhere a
  group DM's avatar shows). Needs a Rust read for the member subset (or reuse
  whatever member data the room summary can carry) — confirm the cheapest path
  (ideally the room summary already resolves DM peers; extend to top-N members).

### Presence dot vs ring + group presence

- Add a **ring** presence variant alongside the existing dot: a colored ring around
  the avatar. Apply per Charm 1.0's rule — **dots for 1:1, always rings for group
  DMs** — with a user toggle (`groupPresenceRing`-equivalent, default on) in
  appearance settings (Spec 47's surface).
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

- Group-DM member subset: new/extended room-summary field or a small IPC read
  (`get_group_dm_members(room_id, limit=3)`).
- Member avatar images: reuse Spec 02 media resolver; no new data (DTO already has
  `avatar_url`).
- Presence: extend the presence DTO enum (Rust) + the presence stream already in
  place; group aggregation can be frontend-side over per-member presence.

## API/contract changes

- `PresenceStateDto` gains a DND/busy variant (ts-rs regen).
- Possibly a group-DM-members read (or extend room summary).
- No change to the media resolver (reused).

## Testing strategy

- Frontend: group-DM room renders the triangle composite (3 faces + fallbacks);
  1:1 renders a single avatar + dot; group DM renders a ring; ring toggle flips
  dot↔ring; member rows render real avatar images (not just initials) and presence
  dots; DND state renders the red color.
- Storybook + axe: avatar/presence variants (1:1 dot, group ring, DND, member row
  with image) through the a11y gate.
- Rust: presence enum includes DND and maps correctly; group-DM member read returns
  the right subset.
- Manual: a real group DM shows member faces; a member with an avatar shows their
  photo in the member list.

## Trade-offs

- **Composite avatar cost**: fetching top-N members per group-DM row adds reads;
  cache per room and cap at 3 faces (matching 1.0) to keep the room list cheap.
- **Ring vs dot default**: follow Charm 1.0 exactly (dot for 1:1, ring for group,
  toggle default-on) rather than inventing new rules — users migrating expect it.

## What I'd revisit as this grows

- Avatar image crop/upload (Spec 36 area) — separate.
- Animated/typing presence on avatars if desired later.
