---
title: Charm 2.0 Spec — Jump to date
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
---

**Workstream:** one PR / one agent. Interacts with Spec 26's bottom-up virtualized
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

New IPC command wrapping `/timestamp_to_event`: `get_event_at_timestamp(room_id,
timestamp_ms, direction) -> event_id`. Timeline loading/pagination around that
event reuses whatever pagination primitives Spec 26/14 already expose (e.g. a
"paginate around event ID" capability — confirm matrix-sdk-ui's `Timeline` exposes
this, since jump-to-message-in-the-middle-of-history is a common enough need that
it likely does).

## API/contract changes

New IPC command as above. No changes to existing pagination commands, assuming the
underlying SDK already supports paginating around an arbitrary event.

## Testing strategy

- Rust: `get_event_at_timestamp` correctness against a mocked
  `/timestamp_to_event` response, including the "no event before/after this date"
  edge case (room created after the requested date, or date in the future).
- Frontend: date picker → jump → correct message scrolled-to-and-highlighted,
  using a fixture timeline; "back to live" returns to the actual bottom, not a
  stale cached position.
- Manual: this is the one most worth hand-testing against Spec 26's real
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
