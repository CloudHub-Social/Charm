---
title: Charm 2.0 Spec — Room invites surface
type: spec
project: Charm 2.0
created: 2026-07-13
status: shipped
---

## Implementation status

**Shipped 2026-07-14 in [PR #243](https://github.com/CloudHub-Social/Charm/pull/243)**
(`ce0138bb15c076b476b80d0cd6bb863a0dc3f63b`).

The merged implementation extends room summaries with membership and inviter
metadata; separates pending invitations from joined-room consumers; adds invite
rows, count badges, and accept/decline actions across desktop and web transports;
opens accepted rooms; handles invite deep links and initial-sync races; and sends
deduplicated new-invite notifications while honoring mute settings.

The feature is intentionally dark-launched behind the default-off
`room_invites` feature flag. Focused unit, Rust integration, E2E, visual,
security, and merge-queue checks passed, and all automated review threads were
resolved before merge.

**Workstream:** one PR / one agent. New spec from the UI-parity deep-dive
(2026-07-13). **Functional gap, not just visual** — arguably the most consequential
UI finding.

## Problem & why now

At authoring time, Charm 2.0 had **no UI to accept or decline a room invite.** The
room list was joined-rooms-only (`snapshot_rooms` carried no membership field; a
grep for "invite" found only the *outgoing* "invite a user" / `/invite` path).
Charm 1.0 has a
dedicated invites surface — an invites inbox, an `allInvitesAtom`, an invite-count
badge, and an OS notification on a new invite (`pages/client/inbox/Invites.tsx`,
`state/room-list/inviteList.ts`, `ClientNonUIFeatures.tsx:396-453`).

Before PR #243, **a user invited to a room in Charm 2.0 could not see or act on the
invite at all.** They had to use another Matrix client to accept it. For a new user
being invited into their first rooms, this was a hard wall. This wasn't caught by the
earlier feature audit (which focused on messaging capabilities), which is exactly why
the UI sweep was worth doing.

## Non-goals

- Not *sending* invites — that already exists (member management / `/invite`).
- Not space-invite-specific flows beyond treating a space invite the same as a room
  invite (a space is a room) — surface both.
- Not knock/join-request *approval* (admin side) — separate; the user-side "Request
  to join" (knock) already exists in 2.0.

## High-level design

- **Surface invited rooms.** Extend the room-list data so invited rooms are known to
  the frontend: `snapshot_rooms` / the room summary must carry membership state
  (`invite` vs `join`), or a separate `list_invites()` read. matrix-rust-sdk exposes
  invited rooms — surface them.
- **Invites section / inbox.** Show pending invites — either as a distinct section at
  the top of the room list (inviter, room name/avatar, "invited you") and/or a
  dedicated invites view. Include an **invite count badge** on the relevant nav
  affordance.
- **Accept / decline actions.** Each invite row has Accept (join the room) and
  Decline (reject the invite) — both are existing SDK operations (join / leave-on-
  invite). On accept, the room moves into the normal joined list and opens; on
  decline, it's removed.
- **New-invite notification.** Fire a notification on a newly-received invite
  (reuse Spec 10/11's notification path), matching 1.0.
- Show who invited you and (for a preview, if available) the room topic/name, so the
  user can decide.

## Data flow

- New/extended read: invited rooms with inviter + room identity. Either extend the
  room summary with membership + inviter, or a dedicated `list_invites()` IPC.
- Accept = join; decline = reject/leave — new IPC commands (`accept_invite(room_id)`,
  `decline_invite(room_id)`) wrapping the SDK, or reuse existing join/leave if they
  handle the invited state.
- New-invite event feeds the notification path.

## API/contract changes

- Room summary carries membership state (invite/join) + inviter, OR a `list_invites`
  read (ts-rs regen).
- `accept_invite` / `decline_invite` IPC commands.
- Invite-received event surfaced for notifications.

## Testing strategy

- Rust: `list_invites` returns pending invites with inviter; accept joins the room;
  decline rejects it.
- Frontend: invites section renders pending invites with Accept/Decline; accept moves
  the room to joined and opens it; decline removes it; count badge reflects pending
  count.
- Manual: from a second account, invite this user to a room; confirm the invite
  appears (with a notification), and both Accept and Decline work end-to-end.

## Trade-offs

- **Membership on the summary vs separate invites read**: putting membership state on
  the room summary is cleaner (one list source, invites as a section) and matches how
  most clients model it; a separate read is fine if the summary can't easily carry
  non-joined rooms. Pick per how `snapshot_rooms` is built.
- **Section vs dedicated inbox**: a top-of-list invites section is the lower-friction
  default (invites are seen immediately); a dedicated inbox (à la 1.0) can coexist if
  an activity-inbox surface is built (Spec 57).

## What I'd revisit as this grows

- Bulk accept/decline if users get many invites.
- Invite preview/peek (see the room before accepting) if the homeserver supports it.
