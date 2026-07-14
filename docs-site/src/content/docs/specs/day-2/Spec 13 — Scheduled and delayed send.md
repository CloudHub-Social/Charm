---
title: Charm 2.0 Spec — Scheduled and delayed send
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
---

**Workstream:** one PR / one agent. New day-2 (power-user) spec from the UI-parity
deep-dive (2026-07-13) — Charm 1.0 has it, Charm 2.0 doesn't.

## Problem & why now

Charm 1.0 lets a user schedule a message to send later (`room/schedule-send/
SchedulePickerDialog.tsx`; the GIF/message send paths accept a scheduled/delayed
time). Charm 2.0 sends immediately only. Scheduled send is a power-user convenience
(send at a reasonable hour, reminders, cross-timezone teams) — day-2 tier, not
launch-critical.

## Non-goals

- Not recurring/scheduled *reminders* as a separate feature — one-shot "send this
  message at time T."
- Not server-side guaranteed delivery if the client is offline unless the mechanism
  supports it (see design) — be explicit about whether a scheduled send survives the
  app being closed.

## High-level design

- A "schedule send" affordance on the composer (next to send), opening a
  date/time picker (reuse Spec 47's date/time formatting and, if present, day-2
  Spec 11's date-picker component).
- **Delivery mechanism — decide explicitly:**
  - **Matrix-native delayed events (MSC4140 `m.delayed_events` / "futures")** if the
    homeserver supports it — the server holds and sends the event at T, so it works
    even if the client is offline/closed. Preferred where available; check
    matrix-rust-sdk + target homeserver support.
  - **Client-side scheduling** as a fallback — the client stores the pending message
    locally and sends it at T *if running*. Must be honest in the UI that a
    client-scheduled message only sends while the app is open (or a background
    task/native scheduler fires it). Charm 1.0's approach is worth checking to match
    expectations.
- A **pending-scheduled list** so the user can see, edit, or cancel messages waiting
  to send.
- Scheduled sends carry the same content/relations (reply, mentions, media, GIF) as
  a normal send — Charm 1.0's GIF send explicitly supports scheduling, so the
  scheduled path must accept attachments, not just text.

## Data flow

If MSC4140: a new IPC to send a delayed event (server holds it) + list/cancel
delayed events. If client-side: a local store of pending messages + a timer/native
scheduler that fires the existing send path at T. Confirm matrix-rust-sdk's delayed-
event support before choosing; prefer server-side for reliability.

## API/contract changes

- `schedule_message(room_id, content, send_at)` + `list_scheduled()` +
  `cancel_scheduled(id)` IPC (shape depends on server-side vs client-side).

## Testing strategy

- Rust: schedule → the message sends at T (server-side: delayed-event round-trip;
  client-side: timer fires the send); cancel prevents send; list shows pending.
- Frontend: picker sets a future time; pending list shows/edits/cancels; scheduled
  send carries attachments/reply relations.
- Manual: schedule a message a minute out, confirm it sends; cancel one and confirm
  it doesn't.

## Trade-offs

- **Server-side (MSC4140) vs client-side**: server-side survives the app being
  closed and is the honest "it will send" — strongly preferred if supported.
  Client-side is a fallback that must clearly communicate its "only while running"
  limitation, or users will expect messages that never send.

## What I'd revisit as this grows

- Recurring scheduled messages / reminders if requested (a distinct feature).
- Editing a scheduled message's content (not just time) before it sends.
