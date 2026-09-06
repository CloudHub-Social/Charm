---
title: Charm 2.0 Spec — Room directory and public room browser
type: spec
project: Charm 2.0
created: 2026-07-13
status: in-progress
sidebar:
  label: "Room directory & public browser"
---

**Status:** implementation is in review behind the default-off `room_directory`
feature flag.

**Workstream:** one PR / one agent.

## Problem & why now

Charm 2.0's Spec 19 index explicitly noted room directory browsing as "explicitly
unbuilt." Neither Charm 1.0 nor 2.0 having this was confirmed by the parity
analysis as a near-parity gap (not a regression), but it's still a real Day-2 gap:
users have no in-client way to discover/join public rooms (their own homeserver's
directory, or other homeservers' via federation) without already having an
invite/alias/link from outside the app.

## Non-goals

- Not a full room-discovery/recommendation engine — a straightforward searchable
  list of the current homeserver's public room directory (`POST
  /_matrix/client/v3/publicRooms`), matching baseline Matrix client functionality.
- Not federated cross-homeserver directory aggregation in Phase 1 — start with the
  user's own homeserver's directory; querying a specific *other* known homeserver
  by name (`?server=`) can be a same-spec stretch goal if trivial, full
  aggregation across many servers is out of scope.
- Not room creation flow changes — this is discovery/join only; room creation
  already exists per Spec 19.

## High-level design

- New entry point (e.g. a "Browse rooms" action near existing space/room-list
  navigation) opening a directory browser: search box, paginated list of public
  rooms (name, topic, member count, avatar), join button per row.
- Search filters client requests server-side (`filter.generic_search_term` on
  `/publicRooms`) rather than client-side filtering a full fetched list, since
  directories can be large.
- Joining from the directory reuses the existing join-room flow/command Spec 19's
  join-by-address work introduced.
- Optional (from the alias-management spec's "What I'd revisit"): a "list this room
  in the directory" toggle in room settings, setting the room's directory
  visibility (`PUT /directory/list/room/{roomId}`) — include if low-effort
  alongside the alias-management spec's work, otherwise defer to its own follow-up.

## Data flow

The `search_public_rooms(query, since, limit) -> PublicRoomPage` command uses the
Matrix SDK's maintained filtered-public-rooms request on desktop. The hosted web
companion exposes the same authenticated contract at
`POST /api/rooms/directory/search`. No new sync-side state is introduced — this
is a request/response query pattern, not a synced data source.

## API/contract changes

The new command returns room id, name, topic, canonical alias, avatar MXC URI,
joined-member count, the next pagination token, and the homeserver's optional
total estimate. Queries are trimmed and opaque pagination tokens pass through unchanged; page size defaults to
20, and the backend caps it at 50. Joining deliberately continues through the
existing `join_room` command.

The initial browser filters out spaces, custom room types, and non-public join
rules before producing actionable results; knock and space navigation remain
outside this slice. Pagination tokens and the estimate still describe the
homeserver's unfiltered directory. The metadata follows the
[Matrix public-room contract](https://spec.matrix.org/latest/client-server-api/#post_matrixclientv3publicrooms).
Typing a replacement query immediately suspends pagination throughout debounce.
Successful joins reuse the existing refresh-and-pending-selection path, so a
delayed room-list sync keeps the current conversation visible until the joined
room is available.

## Testing strategy

- Rust: `search_public_rooms` correctness against a mocked `/publicRooms` response
  including pagination-token round-trip.
- Frontend: search input debouncing/query-on-type, results list rendering,
  join-from-directory flow reusing existing join command, empty/error states.
- Manual: browse a real homeserver's public directory, join a room from it, confirm
  it appears correctly in the room list afterward.

## Implementation

- A globe action in the room-list header opens the browser when
  `room_directory` is enabled.
- Search is debounced and sent to the homeserver; results are never produced by
  downloading and filtering an entire directory in the renderer.
- Pagination appends unique rooms by room id and preserves the server's next
  token.
- Room avatars reuse Charm's existing authenticated Matrix media resolution on
  desktop and web.
- Join actions prefer a canonical alias when available, reuse the existing join
  flow, select the resolved room id, and close the browser after success.
- Phase 1 searches only the signed-in account's own homeserver. Remote-server
  selection and directory-publication controls remain follow-ups.

## Trade-offs

- **Own-homeserver directory first**: matches where most users' actual usage sits
  (their home server's community rooms) and avoids the complexity of multi-server
  directory aggregation UX (dedup, ranking across servers) for a Phase 1 that's
  meant to close a "there's currently zero discovery UI" gap, not build a
  best-in-class discovery product.

## What I'd revisit as this grows

- Cross-homeserver directory search/aggregation if users request browsing rooms on
  servers other than their own by default.
- Directory-listing toggle if not bundled with the alias-management spec.

## Related documentation

- [Spec 32: room alias management](/specs/day-1/spec-32--room-alias-management/)
  governs public addresses and directory publication.
- [Spec 31: room upgrades](/specs/day-1/spec-31--room-upgrades/) defines how
  discovery should treat replacement rooms.
- [Spec 55: command palette](/specs/day-1/spec-55--command-palette-and-quick-switcher/)
  is the complementary fast path for known rooms.
