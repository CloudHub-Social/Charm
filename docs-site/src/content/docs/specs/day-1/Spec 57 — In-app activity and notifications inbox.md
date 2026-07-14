---
title: Charm 2.0 Spec — In-app activity and notifications inbox
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
sidebar:
  label: "In-app activity inbox"
---

**Workstream:** one PR / one agent. New spec from the UI-parity deep-dive
(2026-07-13, wide-net pass).

## Problem & why now

Charm 1.0 has a **Notifications Inbox / activity view** — an in-app surface that
aggregates your mentions and notable activity across all rooms in one place
(`pages/client/inbox/Inbox.tsx`, `sidebar/InboxTab.tsx`). Charm 2.0 has no equivalent
(grep for "inbox" → 0 files). This is distinct from OS push notifications (Spec 11):
it's an *in-app* "what happened while I was away / where was I mentioned" list you can
scroll and act on, rather than transient OS toasts. Without it, catching up on
mentions across many rooms means visiting each room individually.

## Non-goals

- Not OS push notifications (Spec 11) or notification rules (Spec 46) — this consumes
  the same notification data but presents it as an in-app browsable surface.
- Not the room invites surface (Spec 56) — related (both are "things needing
  attention") and could share a tab/inbox shell, but invites are a distinct type.
- Not a full "all unread messages" reader — focus on **mentions/highlights and
  notable activity**, matching 1.0, not every unread message (that's the room list).

## High-level design

- An **activity/notifications inbox** surface (a sidebar tab or a dedicated view)
  listing recent notifications — primarily **mentions/highlights** (where you were
  @-mentioned), optionally key activity — each showing the room, sender, a snippet,
  and timestamp, newest first.
- Clicking an entry jumps to that message in its room (reuse the scroll-to/highlight
  mechanism used by reply-click / search-result-click).
- An **unread-activity count badge** on the inbox affordance.
- Mark-as-read / clear semantics (an entry is read once visited; a "mark all read").
- Consider unifying with Spec 56 (invites) under one "Activity"/"Inbox" surface with
  sections (Mentions, Invites) — reduces nav surface and matches 1.0's inbox-tab
  grouping.

## Data flow

matrix-rust-sdk exposes notification/highlight data (the same source feeding push and
the room-list highlight counts). Aggregate it into a flat, time-ordered list: new IPC
`list_notifications(limit, since?)` returning `{room_id, event_id, sender, snippet,
kind, ts}`. Jump-to reuses existing event-navigation. Mark-read maps to receipts /
notification-read state.

## API/contract changes

- `list_notifications` IPC read (ts-rs regen).
- Possibly a mark-notification-read command (or reuse read receipts / fully-read
  markers).
- No change to the push path (Spec 11) — shared source, different presentation.

## Testing strategy

- Rust: `list_notifications` aggregates mentions/highlights across rooms in time
  order with correct room/sender/snippet.
- Frontend: inbox renders entries; click jumps to the message; count badge reflects
  unread activity; mark-all-read clears.
- Manual: get mentioned in several rooms, confirm all appear in the inbox and each
  jumps to the right message.

## Trade-offs

- **Mentions-focused vs all-activity**: mentions/highlights are the high-signal
  subset and match 1.0; showing *all* activity would duplicate the room list and be
  noisy. Start focused.
- **Unify with invites (Spec 56) vs separate**: unifying under one Activity surface
  is tidier and matches 1.0's inbox tab; keep them as sections so each type stays
  actionable.

## What I'd revisit as this grows

- Filtering the inbox (mentions only / all) if the aggregate gets noisy.
- Including reactions-to-your-messages or replies-to-you as activity types if
  requested.
