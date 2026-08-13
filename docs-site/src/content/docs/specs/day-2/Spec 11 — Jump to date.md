---
title: Charm 2.0 Spec — Jump to date
type: spec
project: Charm 2.0
created: 2026-07-13
status: shipped
---

## Implementation status

Charm ships jump-to-date behind the default-off `jump_to_date` feature flag on
desktop, mobile, and the authenticated web companion. The room-header calendar
resolves the first event on or after local midnight through Matrix's stable
[`/timestamp_to_event`](https://spec.matrix.org/latest/client-server-api/#get_matrixclientv1roomsroomidtimestamp_to_event)
endpoint, then hands the returned event ID to the existing bounded
`load_timeline_around_event` and `TimelineFocus::Event` fallback from Spec 12.
The shared jump path centers and briefly highlights the target and exposes the
existing Jump to present control, without introducing a second viewport state
machine.

Both transports validate the room ID, require an active joined-room session, bound
the timestamp to Matrix's JavaScript-safe integer range, accept only forward or
backward direction, and return only the event ID. The web GET also requires Charm's
non-simple transport header before it can cause a homeserver request. Expected
not-found failures are sanitized before crossing IPC. This follows Element's
established calendar-jump interaction while using the stable Matrix v1.6 endpoint
rather than the former MSC3030 unstable path.

**Workstream:** shipped in one bounded implementation PR. Interacts with Spec 26's bottom-up virtualized
timeline — read that spec's implementation before starting, since jump-to-date
needs to insert an arbitrary point into an already-carefully-tuned scroll/
virtualization system.

## Problem & why now

Neither Charm 1.0 nor 2.0 currently has jump-to-date (confirmed absent in both by
the parity analysis) — but it's a natural, expected feature for any client with
deep room history, and its absence becomes more noticeable as Spec 26's timeline
virtualization work matures (a scrollable-forever timeline without a way to jump
into it is a worse experience than a shorter one). Including it as a genuine
"beyond parity" Day-2 item rather than a strict 1.0-parity gap.

## Non-goals

- Not a full calendar-heatmap "message density by day" visualization — a simple
  date picker that jumps to the nearest message on/after the chosen date, matching
  the baseline feature other Matrix clients (e.g. Element) already ship.
- Not per-thread jump-to-date (jump within a thread drawer) in Phase 1 — main
  timeline only; extend to threads later if Spec (day-2 01, Threads) has landed and
  demand exists.

## High-level design

- Room header/info panel gets a "Jump to date" action opening a date picker.
- On date selection: resolve the target via the homeserver's `/timestamp_to_event`
  endpoint (MSC3030, spec-stable) which returns the nearest event ID at/after a
  given timestamp — avoids the client having to locally binary-search sync history,
  which it likely doesn't fully have anyway for older dates.
- Because that endpoint may anchor on a membership or other non-message event, a
  filtered `/context` lookup resolves the nearest plain or encrypted room message
  in the requested direction before the target crosses the transport boundary.
  If the context window contains no renderable message, bounded filtered
  `/messages` pagination continues from its directional token until a message or
  the accessible-history boundary is reached.
- Once the target event ID is resolved, the timeline needs to paginate/load around
  that point and scroll to it — this is the part that must integrate carefully with
  Spec 26's bottom-up virtualization rebuild: "jump to an arbitrary point mid-
  history" is exactly the kind of operation that historically caused Charm 1.0's
  scroll-anchoring whack-a-mole bugs (#445/#444/#527/#328/#224, referenced in Spec
  26's own motivation). Reuse Spec 26's anchoring primitives rather than building a
  second, competing scroll-management path for this one feature.
- After jumping, the target message is highlighted briefly (same highlight
  treatment as search-result-click and reply-click-to-scroll, for visual
  consistency across all three "jump to a specific message" entry points).
- A "jump to now"/"back to live" affordance appears once the user has jumped away
  from the bottom, letting them return to the live tail of the timeline (this
  already conceptually exists if Spec 26 has any "new messages, scroll to bottom"
  affordance — reuse it rather than inventing a second one).

## Data flow

The typed transport command wrapping `/timestamp_to_event` plus the filtered
`/context` lookup is `get_event_at_timestamp(room_id, timestamp_ms, direction) ->
event_id`; the returned ID is always a message Charm can render. Timeline
loading/pagination around that event reuses whatever pagination primitives Spec
26/14 already expose (e.g. a
"paginate around event ID" capability — confirm matrix-sdk-ui's `Timeline` exposes
this, since jump-to-message-in-the-middle-of-history is a common enough need that
it likely does).

## API/contract changes

New IPC command as above. No changes to existing pagination commands, assuming the
underlying SDK already supports paginating around an arbitrary event.

## Testing strategy

- Rust CI: `get_event_at_timestamp` correctness against mocked
  `/timestamp_to_event`, `/context`, and `/messages` responses, including
  non-message anchors, filtered pagination, and the "no event before/after this
  date" edge case (room created after the requested date, or date in the future).
- Frontend CI: date picker → jump → correct message scrolled-to-and-highlighted,
  using a fixture timeline; "back to live" returns to the actual bottom, not a
  stale cached position.
- Manual follow-up: this is the one most worth hand-testing against Spec 26's real
  virtualized timeline (not just fixtures) given the scroll-anchoring risk called
  out above — jump to several different points in a real room's history including
  the very oldest and very newest available messages.

## Trade-offs

- **MSC3030 server endpoint vs local-only resolution**: server endpoint chosen
  because full local history isn't guaranteed to be synced, and re-implementing
  timestamp-to-event resolution against partial local data would be both more work
  and less correct than a spec-standard server endpoint designed for exactly this.

## What I'd revisit as this grows

- Message-density calendar heatmap if requested as a richer discovery aid on top
  of the basic date-jump.

## Related documentation

- [Spec 26: timeline scroll anchoring](/specs/day-1/spec-26--timeline-scroll-anchoring-and-bottom-up-rendering/)
  governs viewport stability after the jump.
- [Spec 28: cross-room search](/specs/day-1/spec-28--cross-room-message-search/)
  is the complementary event-discovery flow.
- [Export chat history](../spec-10--export-chat-history/) has the same partial
  local-history constraint.
