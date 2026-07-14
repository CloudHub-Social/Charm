---
title: Charm 2.0 Spec — Room directory and public room browser
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
sidebar:
  label: "Room directory & public browser"
---

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
  list of the current homeserver's public room directory (`GET
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

New IPC command `search_public_rooms(server?, query, since?) -> PaginatedRoomList`,
thin-wrapping the homeserver's `/publicRooms` endpoint. No new sync-side state —
this is a request/response query pattern, not a synced data source.

## API/contract changes

New IPC command as above with pagination token handling. No changes to existing
commands.

## Testing strategy

- Rust: `search_public_rooms` correctness against a mocked `/publicRooms` response
  including pagination-token round-trip.
- Frontend: search input debouncing/query-on-type, results list rendering,
  join-from-directory flow reusing existing join command, empty/error states.
- Manual: browse a real homeserver's public directory, join a room from it, confirm
  it appears correctly in the room list afterward.

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
