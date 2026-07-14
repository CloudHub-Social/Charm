---
title: Charm 2.0 Spec — Cross-room message search
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
---

**Workstream:** one PR / one agent, likely split into a Rust-side indexing phase and
a frontend search-UI phase if the indexing approach turns out nontrivial — see
Trade-offs.

## Problem & why now

Charm 1.0 has real message search: users can find a past message by keyword across
some or all of their rooms. Charm 2.0's Spec 19 (room-list rebuild) shipped a
"Search everywhere" escape hatch, but per the parity gap analysis that search is
**filtering the synced room/member list**, not searching message *content* — it
can find a room by name, not a message by what was said in it. This is a Day-1 gap:
"find that thing someone said last week" is one of the most common real-world chat
actions, and its absence is immediately noticeable to anyone migrating from 1.0.

Matrix's own server-side search API (`POST /search`) exists but is inconsistently
implemented across homeservers and, critically, **cannot search encrypted room
content** — the server only ever sees ciphertext. Charm 1.0 (matrix-js-sdk) uses
`matrix-seshat`, a local SQLite FTS index built client-side from decrypted events,
specifically to solve this. Charm 2.0 needs an equivalent local-index approach or
search will silently not work in any encrypted room, which is most rooms.

## Non-goals

- Not federated/global search across rooms the user hasn't joined (room directory
  search is a separate spec, see day-2).
- Not real-time "search as you type across the whole server" — client-local index
  only, same boundary as Charm 1.0.
- Not search of non-text content (image OCR, audio transcription) — text bodies and
  `formatted_body` only, matching `m.text`/`m.notice`/`m.emote` msgtypes.
- Not a redesign of the room-list "Search everywhere" room-name filter from Spec 19
  — that stays as-is; this spec adds a distinct message-content search surface.
- Not cross-device index sync — each device (re)builds its own local index from
  events it has decrypted, same privacy boundary as Charm 1.0's Seshat.

## High-level design

### Indexing

Build a local full-text index in Rust, populated as events are decrypted and
inserted into the timeline store (`matrix-sdk-sqlite` already backs Spec 15's
per-account store — confirm whether SQLite FTS5 can piggyback on that same
connection/schema, or whether a dedicated index database is cleaner given FTS5
virtual tables have different lifecycle/vacuum characteristics than the SDK's own
tables).

- Index fields: room ID, event ID, sender, plain-text body (HTML-stripped from
  `formatted_body` where present), origin timestamp.
- Backfill: on first login (or first login after this feature ships for existing
  users), index whatever history is already locally available in the SDK's store;
  do not force a full server backfill purely to populate search — index grows
  organically as the user scrolls/syncs, same behavior as Seshat.
- Redaction/edit handling: a redacted event's indexed text must be removed/blanked
  on redaction; an edited event's index entry must be replaced with the latest
  content, not append a duplicate.

### Search UI

- Entry point: a dedicated search affordance (e.g. `Cmd/Ctrl+K` or a search icon in
  the room-list header, distinct from Spec 19's existing "Search everywhere" filter
  — clarify/differentiate the two entry points so users don't confuse "find a room"
  with "find a message" during implementation).
- Results: list of matches with room name, sender, timestamp, and a highlighted
  snippet of matched text (standard FTS5 `snippet()`/`highlight()` output).
- Scope toggle: "this room" vs "all rooms" — mirrors Charm 1.0's per-room vs global
  search modes.
- Selecting a result jumps to that message in its room's timeline and highlights it
  (reuse the scroll-to/highlight mechanism Spec 03's reply-click-to-scroll already
  has, if one exists, rather than building a second one).

## Data flow

New Tauri/web-server IPC command, e.g. `search_messages(query, room_id?, limit,
offset) -> SearchResult[]`, backed by the Rust FTS index. No new Matrix protocol
traffic for local-index hits. If a homeserver-side fallback is desired for rooms
the local index hasn't caught up on yet (freshly joined room, unencrypted room with
old history not yet synced), that's an explicit "search on server too" opt-in
button, not automatic — avoid silently mixing local (private, but possibly
incomplete) and server (complete, but transmits the query in plaintext) result sets
without the user knowing which is which.

## API/contract changes

- New Rust module for the index (e.g. `crates/charm-core/src/search/` or similar —
  confirm actual crate layout before implementing).
- New IPC command surface as above, generated bindings via ts-rs per existing
  convention.
- No changes to existing commands.

## Testing strategy

- Rust unit tests: index insert/query/redact/edit-replace correctness against a
  fixture set of events, including multi-room and multi-sender fixtures.
- Rust test: encrypted-room round-trip — decrypt a fixture event, confirm it's
  indexed; confirm a never-decrypted (e.g. undecryptable/UTD) event is not indexed
  with garbage ciphertext.
- Frontend: search UI component tests (query input, results list, scope toggle,
  empty-state, jump-to-message behavior) with a mocked IPC search command.
- Manual: verify search survives app restart (index persisted, not rebuilt from
  scratch each launch) and verify redacting a message removes it from subsequent
  search results.

## Trade-offs

- **SQLite FTS5 vs a dedicated search library (e.g. Tantivy)**: FTS5 is simpler to
  wire into an already-SQLite-based storage layer and sufficient for personal-scale
  chat history; a dedicated engine is more powerful but adds a new dependency and
  index-format surface for marginal benefit at this scale. Default to FTS5 unless
  a spike shows it can't handle realistic history volumes acceptably.
- **Local index vs relying on homeserver `/search`**: local index is strictly
  necessary for encrypted rooms (the majority case) and is the only path to parity
  with Charm 1.0's actual behavior; a server-only implementation would look "done"
  but silently fail for most real usage.
- **Splitting into indexing PR + UI PR**: recommended if the FTS5-vs-store-schema
  question above turns out to need real design work; otherwise one PR is fine for a
  scope this size.

## UI-parity note (from the 2026-07-13 UI deep-dive)

- **⌘F in-room search hotkey + entry.** Charm 1.0 binds ⌘F to search within the
  current room (`Search.tsx` `mod+f`). This spec owns the search itself; Spec 55
  (command palette / quick switcher) owns wiring the ⌘F hotkey to open this search
  scoped to the current room. Ensure this spec exposes a **room-scoped** search entry
  (not only the global "search everywhere") so ⌘F has something to open — the scope
  toggle in this spec's design already covers "this room vs all rooms," so just
  confirm a per-room entry point exists for the hotkey to target.

## What I'd revisit as this grows

- If index size/build time becomes a real problem for accounts with very large
  history, revisit incremental/background indexing strategy (throttled, off the
  main sync thread) rather than synchronous-with-sync indexing.
- Per-room search-index opt-out (for genuinely sensitive rooms a user doesn't want
  indexed even locally) is a plausible follow-up if requested, not built now.
