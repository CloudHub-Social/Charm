---
title: Charm 2.0 Spec — Polls
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
---

**Workstream:** one PR / one agent.

## Problem & why now

Matrix polls (`m.poll.start`/`m.poll.response`/`m.poll.end`, MSC3381) let a room
member propose options and collect votes inline in the timeline. Charm 1.0 supports
creating and voting on polls; Charm 2.0 has none — a poll sent from another client
would currently render as an unrecognized event type (or not at all) in Charm 2.0's
timeline.

## Non-goals

- Not ranked-choice or multi-select poll types beyond whatever `m.poll.start`'s
  `kind` field currently defines as stable — implement whatever the current stable
  MSC3381 poll kinds are, don't invent new ones.
- Not poll analytics/export beyond the live in-timeline result display.

## High-level design

- New `PollMessage` timeline component: renders question, options with live vote
  counts/percentages (updates as `m.poll.response` events arrive via the timeline
  stream), and a "N votes, ends at X / poll closed" footer.
- Creation: composer gets a "Create poll" action (alongside existing slash-command/
  attachment affordances from Spec 04) opening a small form (question + 2-N
  options, disclosed vs undisclosed vote visibility if MSC3381 supports both —
  confirm current spec state).
- Voting: clicking an option sends `m.poll.response`; re-clicking a different
  option resends response (last response per user wins, per protocol semantics —
  confirm against current MSC3381 text before implementing tie-break rules).
- Ending: poll creator (or sufficient power level) can send `m.poll.end` to close
  voting early; UI then locks further votes and shows final tallies.

## Data flow

Polls ride ordinary room timeline events — no new IPC surface beyond what the
existing send-message/timeline-read commands already provide, assuming
matrix-rust-sdk exposes poll event types in its content enum. If the SDK doesn't
have first-class poll type support yet, this becomes a raw-content
send/deserialize using the MSC3381 JSON shape directly — confirm SDK support level
before scoping IPC changes.

## API/contract changes

Likely none beyond generic message-send (if content is just structured JSON body)
— confirm whether existing `send_message`-style commands accept arbitrary
`msgtype`/event-type content or need a poll-specific new command.

## Testing strategy

- Frontend: `PollMessage` renders correctly for open/closed states, vote-count
  aggregation from a fixture set of response events, vote-click sends correct
  response event.
- Cross-client manual test: create a poll in Element/Charm 1.0, vote from Charm
  2.0, confirm vote registers and result display matches.

## Trade-offs

- **Riding existing send/timeline plumbing vs a poll-specific IPC surface**:
  prefer reusing existing generic event plumbing if the SDK supports it, to avoid a
  parallel code path just for one event type; fall back to a dedicated command only
  if the SDK's poll support requires it.

## What I'd revisit as this grows

- Poll result export/analytics if requested by power users running large
  community rooms.
