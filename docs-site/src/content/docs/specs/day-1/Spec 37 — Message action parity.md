---
title: Charm 2.0 Spec — Message action parity
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
---

**Workstream:** one PR / one agent (or split forward-message out if it grows).
Extends Spec 03 (message actions), which shipped a deliberately minimal action menu.

## Problem & why now

Charm 2.0's message action menu (`src/features/rooms/MessageActions.tsx` ~lines
188-216) is exactly **Reply, Edit (own), Copy text, Delete, React**. Charm 1.0's
`src/app/features/room/message/MessageOptionsMenu.tsx` plus its modal set is far
richer, and the parity audit (2026-07-13) confirmed each of the following is
entirely absent from Charm 2.0's code — not just hidden. Several are things users
hit constantly (resend a failed message, copy a link to a message), so their
absence is immediately felt.

## Non-goals

- Not pinning (day-2 Spec 04) or bookmarking (day-2 Spec 12) — those are separate.
- Not forwarding *to arbitrary external targets* — forward is room-to-room within
  the user's joined rooms, matching Charm 1.0.

## Scope — the missing actions

Each maps to a confirmed Charm 1.0 modal/handler and a confirmed Charm 2.0 absence:

1. **Forward message to another room** — Charm 1.0
   `message/modals/MessageForward.tsx`. Room-picker → re-send the event's content
   into the chosen room. Absent in `MessageActions.tsx`.
2. **Copy link / permalink to message** — Charm 1.0 `MessageOptionsMenu.tsx:106-130`
   (`matrix.to/#/!room/$event`). Charm 2.0's "Copy" copies body text only
   (`ChatShell.tsx:775` `writeText(message.body)`). This also closes the
   permalink-to-message gap the timeline audit flagged separately — same feature.
3. **View source (raw event JSON)** — Charm 1.0 `message/modals/MessageSource.tsx`.
   A read-only JSON viewer of the event; valuable for debugging/power users.
4. **Report message** — Charm 1.0 `message/modals/MessageReport.tsx`. Sends
   `/rooms/{roomId}/report/{eventId}` with a reason; a moderation/safety basic.
5. **Edit history viewing** — Charm 1.0 `message/modals/MessageEditHistory.tsx`.
   Charm 2.0 shows only an "(edited)" marker (`BubbleMessageRow.tsx:161`) with no
   way to see prior versions (`m.replace` chain).
6. **Reaction viewer ("who reacted")** — Charm 1.0
   `message/modals/MessageReactions.tsx`. Charm 2.0's `ReactionBar.tsx` shows counts
   only; add a per-reaction "reacted by …" list.
7. **Resend failed message** — Charm 1.0 `message/Message.tsx:666-713`
   (`onResend`/`onDeleteFailedSend`). Charm 2.0 shows "· failed to send" + red
   border (`BubbleMessageRow.tsx:164`) with **no retry or discard** — a real dead
   end for the user when a send fails. Should use the SDK send-queue's own
   retry/abort rather than re-composing.
8. **Redact with reason + confirmation** — Charm 1.0
   `message/modals/MessageDelete.tsx:75` (reason input). Charm 2.0's
   `useMessageActions.ts:24` `redactEvent(roomId, eventId)` takes no reason and has
   no confirm dialog (one-click destructive) — add an optional reason and a confirm
   step.

## Data flow

Most reuse existing send/redact plumbing with small additions:
- Forward: reuse the message-send path, targeting a different room.
- Copy link: pure client-side (`matrix.to` string build) — no IPC.
- View source / edit history: need the raw event JSON and the `m.replace` chain —
  add `get_event_source(room_id, event_id)` and `get_edit_history(room_id,
  event_id)` IPC reads if the timeline summary doesn't already carry them.
- Report: new `report_event(room_id, event_id, reason, score?)` IPC command.
- Resend/discard: wire to the SDK send-queue's retry/cancel for the local echo's
  transaction, not a re-send of new content.
- Redact-with-reason: extend `redactEvent` signature with an optional `reason`.

## API/contract changes

New IPC: `report_event`, `get_event_source`, `get_edit_history`; extend
`redactEvent` with `reason`; a forward command or reuse of send targeting another
room. Send-queue retry/cancel wrappers surfaced to the frontend. ts-rs bindings as
usual.

## Testing strategy

- Frontend: each new menu item renders and dispatches; forward opens a room picker
  and re-sends; resend/discard appear only on failed sends and call the right
  send-queue op; redact shows a confirm + optional reason.
- Rust: `report_event` posts correct payload; `get_edit_history` returns the
  ordered `m.replace` chain; redact-with-reason includes the reason.
- Manual: force a send failure (offline), confirm resend and discard both work;
  forward a message to another room and confirm it arrives.

## Trade-offs

- **Bundle vs one-action-per-PR**: bundled because they share the same menu surface
  and several share IPC additions; forward-message is the only one heavy enough to
  reasonably split out if the PR gets large.
- **Resend via send-queue vs re-compose**: send-queue retry preserves the original
  event/txn semantics (ordering, relations) that a re-compose would lose — matches
  how Spec 14's Timeline adoption already models echoes.

## UI-parity additions (from the 2026-07-13 UI deep-dive)

The UI sweep confirmed three adjacent reaction/action-affordance gaps that belong
here rather than in a new spec:

- **Who-reacted tooltip + reaction viewer.** The reaction viewer (a list of who
  reacted) is already in this spec's scope; the UI audit adds that Charm 1.0 also
  shows a **hover tooltip** naming reactors on each reaction chip
  (`Reactions.tsx:96-104`). Charm 2.0's `ReactionBar` shows counts only — add the
  hover tooltip alongside the viewer modal.
- **Quick-react emoji row on hover.** Charm 1.0's hover toolbar shows ~4 recent-emoji
  one-tap buttons (`MessageOptionsMenu.tsx:68-93`) for instant reactions. Charm 2.0's
  `MessageActions.tsx:134` has only a single "React" button that opens the picker.
  Add a small quick-react row (recent/frequent emoji) to the hover affordance.
- **Shared confirm / confirm-with-reason dialog primitive.** This spec already adds
  redact-with-reason; the UI audit found Charm 2.0 has **no reusable confirmation
  dialog** for destructive actions (delete, kick, ban) — each is one-click or ad hoc.
  Build one shared confirm primitive (optional reason field) and use it for redact
  and the moderation actions, rather than a bespoke dialog per action.

## What I'd revisit as this grows

- Bulk selection (select multiple messages → forward/delete together) if requested;
  Charm 1.0 is mostly single-message, so not built now.
