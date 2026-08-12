---
title: Charm 2.0 Spec — Timeline state and membership events
type: spec
project: Charm 2.0
created: 2026-07-13
status: shipped
---

## Implementation status

The implementation has merged across two slices: the foundation in
[#324](https://github.com/CloudHub-Social/Charm/pull/324) adds a ts-rs-exported
`TimelineItemSummary` union and maps matrix-sdk-ui's existing
membership, member-profile, room name, topic, avatar, tombstone, and hidden-state
classifications into it.

The rendering slice in [#336](https://github.com/CloudHub-Social/Charm/pull/336)
carries that full union through both desktop IPC and the web companion while
retaining the legacy message-only list for compatibility. Behind
the default-off `timeline_state_events` flag, Charm renders friendly notices in
Bubble, Discord, and IRC layouts, collapses consecutive matching membership
changes with expand-on-click, and exposes membership and hidden-state visibility
controls in Appearance settings. Notice bucketing preserves the existing
message-based Virtuoso anchoring, receipts, actions, unread boundaries, and jump
behavior rather than changing row identity for the dark launch.

Repository evidence includes Rust mapper and binding tests, web-server compilation,
frontend unit coverage, and a Playwright full-shell collapsed-membership journey.
A real-account nightly smoke test also confirmed a synchronized membership/profile
notice, collapse rendering, and the Appearance visibility controls. The real-Synapse
`room_admin` integration suite now uses a second Matrix client to produce live join
and leave transitions and sends live name, topic, avatar, and tombstone state. It
then asserts that Charm's actual timeline DTO contains each corresponding variant,
closing the former live-event-matrix gap.

**Workstream:** one PR / one agent. Extends Spec 14/26 (timeline). Likely the
single most-noticeable omission found in the whole parity audit.

## Problem & why now

Charm 2.0's timeline renders **only message events** — every state and membership
event is filtered out before it reaches the renderer (`RoomMessageSummary` carries
only messages; confirmed `useChatTimeline.ts:46`, `ChatShell.tsx:165`). So Charm
2.0 shows nothing when someone joins, leaves, is invited/kicked/banned, or when the
room name, topic, or avatar changes. Charm 1.0 renders all of these via
`src/app/features/room/useTimelineEventRenderer.tsx` (RoomMember ~1298, RoomName
~1397, RoomTopic ~1492, RoomAvatar ~1588), with membership collapsing and toggles.

In a real, active room this is glaring — the timeline reads as if the room's
membership and settings never change. It also silently subsumes several smaller
gaps (the `hideMembershipEvents`/`showHiddenEvents` toggles have nothing to hide
because nothing renders).

## Non-goals

- Not rendering *every conceivable* state event verbatim as raw JSON — render the
  human-meaningful ones (membership, name, topic, avatar, and the tombstone notice
  which day-1 Spec 31 also touches) as friendly notices; genuinely obscure/custom
  state events can stay hidden behind a "show hidden events" power-user toggle
  rather than cluttering the default view.
- Not pinned-events timeline notices — that belongs with day-2 Spec 04 (pinning),
  which the audit noted also surfaces a `RoomPinnedEvents` notice.

## High-level design

### Data — stop dropping non-message events

The core change is that the timeline data model must carry state/membership events,
not just `m.room.message`. matrix-sdk-ui's `Timeline` (adopted in Spec 14) already
emits these as timeline items — Charm 2.0's mapping layer is discarding them.
Extend the timeline summary model with a variant (or a sibling item type) for
non-message timeline items so `ChatShell` can render them. Confirm the SDK's
`TimelineItem`/virtual-item shape before designing the DTO — the SDK likely already
groups/represents these in a way worth mirroring rather than re-deriving.

### Rendering

- **Membership changes:** "X joined", "X left", "X was invited by Y", "X was
  kicked/banned by Y (reason)", display-name and avatar changes ("X changed their
  name to Y"). Style as compact, muted, center-ish system notices distinct from
  message rows (all three Spec 27 layout modes need a sensible rendering — in IRC
  mode especially these should be single-line `* X joined` style).
- **Collapsing:** consecutive membership changes collapse into "X, Y and 3 others
  joined" with expand-on-click — Charm 1.0 `useTimelineEventRenderer.tsx:1298-1301`
  (`isMembershipChanged`, `collapse`). Without collapsing, a room with join churn
  becomes unreadable, so this is not optional polish.
- **Room state:** "X changed the topic to …", "X changed the room name to …", "X
  changed the room avatar" as system notices.
- **Tombstone:** coordinate with day-1 Spec 31 (room upgrades) — the tombstone
  banner is that spec's; this spec just ensures the tombstone *event* isn't dropped
  from the timeline stream.

### Toggles (tie off the subsumed gaps)

- `hideMembershipEvents` — hide join/leave/nick/avatar churn (Charm 1.0
  `settings.ts:139`). Default on-or-off should match Charm 1.0's default (confirm).
- `showHiddenEvents` — power-user toggle to also render otherwise-hidden/unknown
  state events.
  Both live in appearance/display settings (overlaps Spec 47; put them wherever
  Spec 47 lands the other display toggles, for one coherent surface).

## Data flow

New/extended timeline item type flowing from the Rust timeline mapping through the
existing timeline IPC/stream into `ChatShell`. No new *fetch* path — the events are
already synced and already reach the SDK Timeline; the fix is to stop discarding
them in the mapping layer and to carry enough fields (actor, target, membership
transition, old/new value) to render a friendly string frontend-side.
Membership/profile-change DTOs keep the remote-controlled display name separate
from the authoritative MXID. Renderers must isolate the display-name fragment and
show the MXID without concatenating both into a single untrusted string.

## API/contract changes

Extend the timeline summary binding with a state/membership item variant (fields:
kind, sender, target user, transition type, old/new value, reason). ts-rs
regeneration. `ChatShell`'s render loop gains a branch for the new item kind.

## Testing strategy

- Rust: the timeline mapping now emits state/membership items (not just messages)
  for representative fixture events, with correct transition classification
  (join vs leave vs invite vs kick vs ban vs display-name-change vs avatar-change).
- Frontend: each notice renders correctly in all three Spec 27 layout modes;
  collapsing groups consecutive membership changes and expands on click;
  `hideMembershipEvents` hides them; `showHiddenEvents` reveals unknown state.
- Manual: in a real room, trigger a join/leave/topic-change from a second client
  and confirm the notice appears; confirm a high-churn room collapses sensibly.

## Trade-offs

- **Carry render-ready fields in the DTO vs re-fetch state frontend-side**: carry
  them — the mapping layer already has the event; shipping actor/target/old/new in
  the item avoids a frontend round-trip per notice and keeps rendering pure.
- **Collapse in the mapping layer vs in the frontend**: lean frontend (it's a
  presentation concern and interacts with the hide/show toggles), but the DTO must
  carry enough to group correctly (sender, transition, contiguity).

## What I'd revisit as this grows

- Pinned-events notice once day-2 Spec 04 (pinning) lands.
- Per-event-type verbosity settings (Charm 1.0 has finer `hideNickAvatarEvents`
  etc.) if the single `hideMembershipEvents` toggle proves too coarse.
