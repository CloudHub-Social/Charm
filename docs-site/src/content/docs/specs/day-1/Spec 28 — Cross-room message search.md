---
title: Charm 2.0 Spec — Cross-room message search
type: spec
project: Charm 2.0
created: 2026-07-13
status: in-progress
---

## Implementation status

The storage and API architecture is now decision-ready. Charm will use a dedicated
per-account SQLite FTS5 database owned by Charm, not tables or connections owned by
matrix-sdk. The first code slice is indexing and lifecycle only; the global and
current-room search UI follows after the index contract is stable.

Implementation has not started in this PR. `rusqlite` is already used by the web
companion and present in the repository lockfile, but making it a direct desktop
dependency still requires the repository's explicit dependency approval before the
indexing PR changes `src-tauri/Cargo.toml`.

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

Build a local full-text index in Rust, populated only after an event is available
to Charm as decrypted timeline content. Each desktop account gets a dedicated
`message-search.sqlite3` database in that account's Charm-owned data directory.
Each web-companion session gets a separate index beside the session's random
`crypto_store_key`; indexes are never shared merely because two sessions use the
same MXID.
Never open matrix-sdk's database directly, add tables to its schema, or share its
connection: the SDK owns that schema and migration lifecycle.

- Index fields: room ID, event ID, sender, plain-text body, origin timestamp.
  Normalize formatted Matrix content with Ruma's sanitizer and
  `RemoveReplyFallback::Yes` before text extraction; do not implement a second tag
  stripper or index hidden/disallowed elements.
- Index only `m.text`, `m.notice`, and `m.emote`. Do not index encrypted payloads,
  undecryptable placeholders, media filenames/captions, reactions, state events, or
  untrusted raw HTML.
- Use one visible content row per `(room_id, original_event_id)`. An `m.replace`
  may update that row only after the same validity checks used by the timeline:
  the replacement sender must match the original event sender, its target must
  be the original message in the same room, and its `m.new_content` must be
  decrypted. A different sender's forged relation is ignored. When the newest
  otherwise-valid replacement changes the visible content to a non-indexed
  msgtype, delete the visible FTS row rather than retaining the original text;
  keep that replacement in provenance so redacting it can restore the preceding
  searchable version.
- Track replacement provenance separately from the visible FTS row: original
  content plus every valid edit's event ID, `origin_server_ts`, and optional
  searchable body/msgtype. Determine the latest non-redacted replacement with the
  same timestamp ordering and deterministic event-ID tie-break used by the
  timeline, never local arrival order. Redacting the original deletes its visible
  row; redacting an edit removes that candidate and atomically recomputes the row
  from the preceding valid edit or original content. A late edit/redaction,
  backfill, or replay therefore converges without retaining stale or redacted
  replacement text.
- Backfill: on first login (or first login after this feature ships for existing
  users), index whatever history is already locally available in the SDK's store;
  do not force a full server backfill purely to populate search — index grows
  organically as the user scrolls/syncs, same behavior as Seshat.
- Redaction/edit handling follows the provenance rules above; replacement events
  never become independent search results.
- Leaving or forgetting a room atomically purges that room's visible rows and edit
  provenance. Global queries also verify joined membership before returning a
  result, so a failed purge cannot expose departed-room content.

### Ownership, privacy, and lifecycle

- The index handle belongs to the authenticated account session. Desktop and web
  use the same core index abstraction but resolve their account roots through their
  existing, separate persistence layers.
- Derive the index directory from the existing opaque desktop account store key or
  web session `crypto_store_key`; never
  put an MXID, homeserver, access token, or raw account identifier in a filename.
- Create the directory and database with owner-only permissions where the platform
  supports Unix modes. The database contains decrypted message text, so the privacy
  model and docs must state that local search expands the plaintext-at-rest surface
  beyond matrix-sdk's encrypted store. OS full-disk/user-account protection is the
  initial boundary; SQLCipher is not silently implied.
- Desktop logout continues to preserve a retained account index, but account
  deactivation must close and delete it. The account-management surface must also
  expose an explicit local-data wipe that removes both the retained SDK store and
  search index; its confirmation and Spec 08 documentation disclose the plaintext
  index separately from the encrypted SDK store. Web logout, session expiry, and
  administrative session removal close and delete that session's index. A
  failed/corrupt migration quarantines and rebuilds only Charm's search database,
  never an SDK store.
- Web indexes are intentionally session-ephemeral in the first slice. They are not
  copied into the crypto-store backup and may be rebuilt only from decrypted
  history available to that same session after restart. The UI must disclose
  incomplete results after a deployment/restart; durable plaintext search backup
  is out of scope until an encrypted, session-bound backup design exists.
- Run schema creation, writes, rebuilds, and queries off the async runtime's worker
  threads. Sync/timeline delivery must not wait on SQLite I/O.

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

New Tauri/web-server command:

`search_messages(query, room_id?, limit, cursor) -> SearchResultPage`

The user query is literal text, not raw FTS5 syntax. The backend applies Unicode
normalization, tokenizes it with the index tokenizer, and safely quotes each token;
unmatched quotes and FTS operators are searched as text. Empty-token queries are
rejected with a typed invalid-query error. Requests are capped server-side at 512
UTF-8 bytes and `limit` is clamped to 1–100.

The cursor is opaque and binds to the normalized query, optional room scope,
account/session, and an index generation. Results use the total order
`bm25 rank ASC, origin_server_ts DESC, room_id ASC, event_id ASC`; the cursor
contains the last tuple and generation. Any index mutation increments the
generation, so a cursor from before an edit/index write is rejected as stale
rather than duplicating or skipping results. Results contain event ID, room ID,
sender, origin timestamp, a plain-text snippet with match ranges, and the next
cursor; they never contain FTS-generated HTML markup.

No new Matrix protocol traffic occurs for local-index hits. If a homeserver-side fallback is desired for rooms
the local index hasn't caught up on yet (freshly joined room, unencrypted room with
old history not yet synced), that's an explicit "search on server too" opt-in
button, not automatic — avoid silently mixing local (private, but possibly
incomplete) and server (complete, but transmits the query in plaintext) result sets
without the user knowing which is which.

## API/contract changes

- New shared Rust search module with a small storage trait and a SQLite FTS5
  implementation. Desktop and web session layers own account-specific handles;
  neither transport owns indexing semantics.
- New default-off `encrypted_local_message_search` flag in both Rust and TypeScript
  catalogs. Opening, backfilling, writing, and querying the index are all disabled
  when the flag is off.
- New IPC and authenticated web-companion command surface as above, with generated
  bindings via ts-rs per existing convention.
- No changes to existing commands.

## Testing strategy

- Rust unit tests: index insert/query/redact/edit-replace correctness against a
  fixture set of events, including multi-room, multi-sender, text-to-non-text
  replacements, out-of-order edits, equal-timestamp event-ID tie-breaks, and
  redaction restoring the preceding searchable version.
- Rust unit tests: account A cannot open, query, or consume a cursor from account
  B; flag-off performs no index file creation; corrupt-schema rebuild cannot touch
  matrix-sdk files.
- Rust unit tests: literal quotes/operators, maximum query/page bounds, tied-result
  ordering, stale cursors after writes, leave/forget purge, deactivation wipe, and
  web-session isolation/cleanup.
- Rust test: encrypted-room round-trip — decrypt a fixture event, confirm it's
  indexed; confirm a never-decrypted (e.g. undecryptable/UTD) event is not indexed
  with garbage ciphertext.
- Frontend: search UI component tests (query input, results list, scope toggle,
  empty-state, jump-to-message behavior) with a mocked IPC search command.
- Manual: verify search survives app restart (index persisted, not rebuilt from
  scratch each launch) and verify redacting a message removes it from subsequent
  search results.
- Real Synapse: send and edit an encrypted text event from another client, wait for
  decryption, then verify replacement and redaction in desktop and web-companion
  results. Record this separately from repository tests.

## Trade-offs

- **SQLite FTS5 vs a dedicated search library (e.g. Tantivy)**: decided in favor
  of FTS5. It is sufficient for personal-scale chat history, already supported by
  Charm's web-server SQLite stack, and avoids a second index format.
- **SDK database vs a dedicated database**: decided in favor of a dedicated
  Charm-owned database. This keeps SDK schema migrations, backup/restore, and
  corruption recovery outside the feature's blast radius at the cost of one extra
  per-account file and an explicit plaintext-at-rest disclosure.
- **Local index vs relying on homeserver `/search`**: local index is strictly
  necessary for encrypted rooms (the majority case) and is the only path to parity
  with Charm 1.0's actual behavior; a server-only implementation would look "done"
  but silently fail for most real usage.
- **Splitting into indexing PR + UI PR**: decided. PR 1 owns schema, account
  lifecycle, indexing/rebuild, flags, typed command, and desktop/web tests. PR 2
  owns global/current-room UI, snippets, and result navigation.

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
