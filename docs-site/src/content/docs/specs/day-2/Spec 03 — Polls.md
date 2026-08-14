---
title: Charm 2.0 Spec — Polls
type: spec
project: Charm 2.0
created: 2026-07-13
status: shipped
---

**Workstream:** one PR / one agent.

## Implementation status

Charm ships single-select Matrix polls behind the default-off `polls` feature
flag on desktop and the authenticated web companion. The implementation uses
matrix-sdk-ui 0.18's aggregated `PollState` for timeline updates and Ruma's
maintained MSC3381 event types for creation, responses, and ending; Charm does
not parse or aggregate poll relations itself. The bounded implementation is
[PR #468](https://github.com/CloudHub-Social/Charm/pull/468).

MSC3381 is still an accepted but unstable proposal, so the wire events are
`org.matrix.msc3381.poll.start`, `org.matrix.msc3381.poll.response`, and
`org.matrix.msc3381.poll.end`, with `org.matrix.msc1767.text` fallbacks. Charm
renders disclosed live tallies, keeps undisclosed totals hidden until close,
shows the current user's selected option, and allows the poll creator to end an
open poll. New polls support 2–20 options and one selection per voter.

## Problem & why now

Matrix polls (MSC3381) let a room
member propose options and collect votes inline in the timeline. Charm 1.0 supports
creating and voting on polls; Charm 2.0 has none — a poll sent from another client
would currently render as an unrecognized event type (or not at all) in Charm 2.0's
timeline.

## Non-goals

- Not ranked-choice or multi-select polls. Phase 1 sends `max_selections: 1` and
  supports MSC3381's disclosed and undisclosed visibility kinds.
- Not poll analytics/export beyond the live in-timeline result display.
- Not scheduled closing times or editing a poll after creation.

## High-level design

- New `PollMessage` timeline component: renders question, options with live vote
  counts/percentages (updates as response events arrive via the timeline stream),
  and a vote-count / poll-closed footer.
- Creation: composer gets a "Create poll" action (alongside existing slash-command/
  attachment affordances from Spec 04) opening a small form (question + 2-N
  options, disclosed vs undisclosed vote visibility if MSC3381 supports both —
  confirm current spec state).
- Voting: clicking an option sends `m.poll.response`; re-clicking a different
  option resends response (last response per user wins, per protocol semantics —
  confirm against current MSC3381 text before implementing tie-break rules).
- Ending: the poll creator can send the poll-end event to close voting; UI then
  locks further votes and shows final tallies.

## Data flow

Polls ride ordinary room timeline events. `matrix-sdk-ui::Timeline` classifies the
start event as `MsgLikeKind::Poll` and maintains its `PollState` as responses and
end relations arrive. Charm maps that SDK-owned aggregate into an additive
`PollSummary` on `RoomMessageSummary`; the frontend never sees raw event JSON.

Outbound actions use three narrow transport commands (`create_poll`,
`vote_on_poll`, and `end_poll`) that all queue Ruma event content through the same
send queue and transaction-ID capture path as ordinary messages. The web routes
call those same Rust implementation functions, so desktop and web do not maintain
parallel protocol logic.

## API/contract changes

- Additive `poll: PollSummary | null` on `RoomMessageSummary`.
- New `PollSummary`, `PollAnswerSummary`, and `PollKindSummary` bindings.
- New `create_poll`, `vote_on_poll`, and `end_poll` commands plus matching
  authenticated web routes.
- New default-off `polls` feature flag catalog entry.

## Testing strategy

- Rust CI covers poll validation and Ruma content construction, including
  single-selection semantics and duplicate/too-few option rejection.
- Frontend CI covers disclosed and undisclosed rendering, vote submission,
  creator ending, creation form validation, and both web transport routes.
- Cross-client owner acceptance remains useful after enabling the flag: create a
  poll in Element, vote from Charm, then reverse the direction and compare totals.

## Trade-offs

- **Thin poll-specific commands over arbitrary raw-content IPC**: the generic send
  queue is reused internally, but the frontend receives validated intent-shaped
  commands rather than permission to submit arbitrary Matrix event JSON.
- **Unstable wire namespace**: MSC3381 has not reached the stable Client-Server
  specification. Keeping all event construction in Ruma confines a future stable
  namespace migration to the Rust boundary.

## What I'd revisit as this grows

- Poll result export/analytics if requested by power users running large
  community rooms.

## Related documentation

- [Spec 14: matrix-sdk-ui Timeline](/specs/day-1/spec-14--adopt-matrix-sdk-ui-timeline/)
  supplies the event stream and update semantics.
- [Spec 58: rich message rendering](/specs/day-1/spec-58--rich-message-content-rendering/)
  is the adjacent structured-event presentation layer.
- [Spec 43: composer parity](/specs/day-1/spec-43--composer-parity/) owns the
  message-composition surface from which a poll is created.
- [MSC3381: Polls](https://github.com/matrix-org/matrix-spec-proposals/blob/main/proposals/3381-polls.md)
  defines the current unstable event contract.
