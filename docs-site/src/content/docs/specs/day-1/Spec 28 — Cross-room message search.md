---
title: Charm 2.0 Spec — Cross-room message search
type: spec
project: Charm 2.0
created: 2026-07-13
status: in-progress
---

## Implementation status

The storage and API architecture is decision-ready. Charm uses a dedicated,
per-account and per-device SQLCipher database owned by Charm, not tables or
connections owned by matrix-sdk. The first storage/lifecycle foundation now adds
the approved direct desktop `rusqlite`/SQLCipher dependency, a domain-separated
per-device key derived from the keychain-backed matrix-sdk store passphrase,
opaque device-scoped private directories, visible-message and edit-provenance tables, persistent redaction
tombstones, physical redaction/room cleanup, account/device purge helpers, and a
default-off `encrypted_local_message_search` flag. Logout deletes the current
device index and account deactivation deletes every retained index for that
account. Opening a replacement device index first purges any superseded device
indexes for that account; rejected session restore and terminal
`M_UNKNOWN_TOKEN` sync errors clear the affected device index as part of session
teardown, including the revoked account's local push registration state, and
invalidate the renderer session. Explicit logout does the same if index purge
or credential deletion fails, while still completing the remaining teardown;
an empty account-scoped logout tombstone prevents startup restoration until both
keychain session kinds are confirmed absent.
The renderer registers that invalidation listener before session restoration
and ignores a restore response invalidated during initial sync. A device-scoped key verifier lets Charm
rebuild a corrupt encrypted header with the confirmed current key without
mistaking a wrong-key or transient storage failure for disposable corruption.
For this sensitive flag only, a trusted remote `false` vetoes a
persisted local Labs override; disabled startup removes every retained index
before any search surface can be used, and a runtime enabled-to-disabled
transition immediately purges the native derived-index root (iOS preserves only its empty,
backup-excluded root and native success marker). Labs serializes a later re-enable
behind that cleanup so durable flag writes cannot overtake the purge.
Device-scoped purge failures retain only opaque durable retry markers, while a failed
whole-root kill-switch purge retains an empty marker outside that root. Account sweeps
attempt and queue every matching device, and retain an opaque account-wide marker when
the search root itself cannot be enumerated; startup and the next index open retry all
pending deletions before search can become usable.
Room purge deletes searchable bodies and version provenance but retains non-content
redaction tombstones so a delayed replay cannot resurrect previously redacted text.

This foundation does not yet ingest timeline/sync events or expose the search
command. The next backend slice owns the bounded off-runtime worker, FTS5 tokenizer,
startup reconciliation, joined-room/ignored-user enforcement, and desktop/web
session wiring. The global and current-room search UI follows only after that
indexing contract is stable.

**Workstream:** ordered backend foundation and ingestion/query PRs, followed by the
frontend search UI and result navigation — see Trade-offs.

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
Android and iOS use the same Rust-owned database under Tauri's app-data
directory, keyed by both the account store key and the current Matrix device
ID. A superseding device or logout deletes the prior device's encrypted index
before another index can be opened. The mobile build verifies this lifecycle,
bundled SQLCipher FTS5/tokenizer availability, key custody, and backup exclusion
before enabling the flag. Android excludes the search root from cloud backup,
device transfer, and legacy full backup. The native iOS launcher applies
`NSURLIsExcludedFromBackupKey` to the dedicated search root before Rust starts;
Rust refuses to open an index unless that native step records success.
Each web-companion session derives a separate search-encryption key from its
persisted random `crypto_store_key` with the same search-specific HKDF domain
separation and a session-bound context. The raw crypto key is never used as a
SQLCipher key. A legacy session without a crypto key must complete Spec 25's
existing migration or re-login before search can open; there is no MXID-derived
fallback. Indexes are never shared merely because two sessions use the same MXID.
Spec 25's session cleanup removes the source key and the search index.
Never open matrix-sdk's database directly, add tables to its schema, or share its
connection: the SDK owns that schema and migration lifecycle.

- Index fields: room ID, event ID, sender, plain-text body, origin timestamp.
  Normalize formatted Matrix content with Ruma's sanitizer and
  `RemoveReplyFallback::Yes` before text extraction; do not implement a second tag
  stripper or index hidden/disallowed elements. Remove the descendants of
  `data-mx-spoiler` elements before extraction, so concealed text cannot appear in
  either matches or plain snippets. When normalizing an edit of a reply, carry
  the original event's reply relation into the replacement content before
  removing the fallback; `m.new_content` alone does not preserve that context.
  Cross-spec tests must cover Spec 58 spoilers and edited replies whose quoted
  fallback must not become searchable.
- Index only `m.text`, `m.notice`, and `m.emote`. Do not index encrypted payloads,
  undecryptable placeholders, media filenames/captions, reactions, state events, or
  untrusted raw HTML. Index only acknowledged remote events with a server event ID;
  pending, failed, retried, and discarded local echoes are excluded, avoiding
  transaction-ID rows that can survive alongside an acknowledged echo.
- An unable-to-decrypt placeholder is not marked permanently handled. When the
  timeline re-emits that event ID after decryption succeeds, insert or update the
  decrypted row. Reconciliation on startup must make the same transition if the
  key arrived before restart.
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
  searchable body/msgtype. The `matrix-sdk-ui` timeline's already-collapsed
  visible event is authoritative; search must not independently select a
  replacement with a tie-break the renderer does not use. When raw backfill
  contains multiple edits at the same timestamp and no authoritative collapsed
  projection is available, defer that original event until timeline
  reconciliation resolves it rather than choosing by local arrival or event ID.
  Redacting the original writes a persistent
  tombstone, deletes the visible row, and purges every original/edit decrypted body
  in provenance; later edits and replay must remain suppressed by that tombstone.
  Redacting an edit removes that candidate and atomically recomputes the row from
  the preceding valid edit or original content only when the original is not
  tombstoned. A late edit/redaction, backfill, or replay therefore converges without
  retaining or resurrecting stale or redacted text.
- Backfill: on first login, and on the first index open after the feature flag
  becomes enabled for an already-active account/session, index whatever history
  is already locally available in the SDK's store;
  do not force a full server backfill purely to populate search — index grows
  organically as the user scrolls/syncs, same behavior as Seshat.
- Redaction/edit handling follows the provenance rules above; replacement events
  never become independent search results.
- Although SQLCipher encrypts index pages at rest, deletion is physical as well as
  logical: redaction and room/account purge rebuild affected FTS storage, enable
  `secure_delete`, checkpoint and truncate WAL sidecars, and compact freelist pages
  before reporting cleanup complete. Tests place a unique marker in an indexed
  body and verify it is absent from the database, WAL, and SHM files after purge.
- Every joined-to-non-joined membership transition atomically purges that room's
  visible rows and edit provenance, whether caused by local leave/forget or sync
  observing a remote kick, ban, or membership change. Both global and explicitly
  room-scoped queries verify joined membership before reading or returning results,
  so a failed purge cannot expose departed-room content through either API shape.

### Ownership, privacy, and lifecycle

- The index handle belongs to the authenticated account session. Desktop and web
  use the same core index abstraction but resolve their account roots through their
  existing, separate persistence layers.
- Derive the desktop index directory from an opaque hash of the account store key
  plus Matrix device ID, and the web directory from its opaque session identity; never
  put an MXID, homeserver, access token, or raw account identifier in a filename.
  A new/superseding desktop device never reopens a previous device's encrypted
  index; supersession closes and deletes the old device index.
- Create the directory and database with owner-only permissions where the platform
  supports Unix modes. Encrypt the complete database, including its FTS and
  provenance tables, with SQLCipher. On desktop/mobile, derive a distinct per-device
  search key from matrix-sdk's keychain-backed random store passphrase using HKDF-SHA256
  with an explicit Charm search domain and account/device context. On web, derive it
  from the session's random `crypto_store_key` with a session-bound context. Never use,
  persist, log, or transport either source secret or derived key as application data.
  Decrypted text exists in process memory while indexing or querying, but database,
  WAL, and SHM pages must not expose it at rest.
- Desktop logout closes and deletes the current device's index, because Charm's
  logout flow revokes and removes that session and a later interactive login creates
  a new device that cannot safely reopen the old device-keyed index. Creating a
  superseding device likewise closes and deletes the prior device index. Account
  deactivation must close and delete every retained index.
  PR 1 owns an explicit account-management "Forget local data" control that closes
  the account, removes both the retained SDK store and every search index, and
  tests the confirmation and physical cleanup. Its Spec 08 copy discloses the
  separately encrypted search index and key lifecycle. Web logout, session
  expiry, and administrative session removal close and delete that session's
  index. A failed/corrupt migration records only non-sensitive diagnostics
  (schema version, error category, and a random incident ID), securely removes the
  search database plus WAL/SHM sidecars, and rebuilds from decrypted SDK history;
  no decrypted-content quarantine is retained and an SDK store is never modified.
- A terminal Matrix authentication error, including remote deletion of the
  current device from another session, is session teardown rather than a
  retryable sync failure. Desktop, mobile, and web immediately stop serving
  queries, close the handle, and remove the database and sidecars. Integration
  tests revoke the device from a second session and verify both access denial
  and physical cleanup.
- Web indexes are intentionally session-ephemeral in the first slice. They are not
  copied into the crypto-store backup and may be rebuilt only from decrypted
  history available to that same session after restart. The UI must disclose
  incomplete results after a deployment/restart; durable search-index backup is
  out of scope. In a hosted deployment decrypted text exists in the companion
  process while indexing and querying, not in the browser or user's device.
  SQLCipher protects disk snapshots but does not protect against an operator or
  attacker with access to live process memory. Web operations guidance and the UI
  must disclose that trust boundary; companion search directories are excluded from host backups,
  deleted on session expiry/removal, and retained no longer than the owning
  session.
- Run schema creation, writes, rebuilds, and queries off the async runtime's worker
  threads. Sync/timeline delivery must not wait on SQLite I/O. Feed the worker
  through a bounded queue that coalesces work by room/event and persists only a
  non-content sync checkpoint. Overflow schedules a bounded reconciliation from
  the encrypted SDK store instead of retaining every event in memory, blocking
  sync, or silently dropping work. Tests stall SQLite while delivering a large
  sync and prove bounded memory plus eventual reconciliation.
- Persist a Charm-owned indexing journal/checkpoint before acknowledging a sync
  position as searchable. The journal contains only opaque event/room identifiers
  and checkpoints; it never stores message bodies, normalized text, snippets, or
  other decrypted content and rehydrates work from the encrypted SDK store. Startup
  replays incomplete journal entries and reconciles the index against decrypted
  events in the SDK store before serving queries; this includes redactions and
  edit provenance. An index file existing is never sufficient evidence that
  backfill/reconciliation completed. Tests stop the process between SDK
  persistence and search commit, scan the journal for raw markers, and verify
  restart removes redacted plaintext and fills missing events.
- Live indexing is sourced before room UI/timeline selection: the shared Rust sync
  pipeline decrypts joined-room timeline events from every sync response and submits
  eligible events to the indexer even when that room has never been opened. The
  current `m.ignored_user_list` is applied before live writes and during backfill;
  newly ignored senders are purged transactionally before the updated ignore list
  becomes visible to queries. Unignoring permits future live writes and a bounded
  rebuild of locally retained eligible events, but never restores text from a
  decrypted-content quarantine. Initial and recovery backfill enumerate each joined room's
  locally persisted SDK event cache and pass encrypted events through the SDK's
  decryption machinery; the indexer never scrapes mounted React timelines. Tests
  cover an encrypted message arriving in an unopened room and becoming searchable
  without opening that room or making a search-triggered Matrix request, plus ignore
  and unignore transitions.

### Search UI

- Entry point: a dedicated search affordance (`Cmd/Ctrl+F` or a search icon in
  the room-list header, distinct from Spec 19's existing "Search everywhere" filter
  — clarify/differentiate the two entry points so users don't confuse "find a room"
  with "find a message" during implementation).
- Results: list of matches with room name, sender, timestamp, and the backend-provided
  plain-text snippet plus match ranges. The UI must not consume or render FTS-generated
  `snippet()`/`highlight()` markup.
- Scope toggle: "this room" vs "all rooms" — mirrors Charm 1.0's per-room vs global
  search modes.
- Selecting a result jumps to that message in its room's timeline and highlights it
  (reuse the scroll-to/highlight mechanism Spec 03's reply-click-to-scroll already
  has, if one exists, rather than building a second one).

## Data flow

New Tauri/web-server command:

`search_messages(query, room_id?, limit, cursor) -> SearchResultPage`

The user query is literal text, not raw FTS5 syntax. The backend stores the
unmodified display text separately from the token/search representation and uses a
maintained Lindera-backed custom FTS tokenizer that preserves byte offsets into
that original text internally. The backend converts matched byte spans to UTF-16
code-unit offsets before transport, validates that every boundary falls on a
Unicode scalar boundary, and returns the original display snippet plus those
JavaScript-safe ranges. Tests cover emoji, combining characters, and CJK text.
Pre-segmented or normalized text is never returned to the UI. This is the
selected CJK-capable strategy (subject to the repository's
explicit dependency approval); do not fall back to `unicode61` for unsegmented
Chinese/Japanese content.
unmatched quotes and FTS operators are searched as text. Empty-token queries are
rejected with a typed invalid-query error. Requests are capped server-side at 512
UTF-8 bytes and `limit` is clamped to 1–100.

The first page creates a bounded, TTL-limited search snapshot containing only the
ordered result identifiers, ranks, and a non-plaintext content-version identifier
for the exact renderer-selected event version that matched under a random
per-account search ID. Later pages resolve that immutable version rather than the
mutable current event; redaction still suppresses the result and physically purges
its content. The opaque cursor binds to that snapshot, normalized query,
optional room scope, account/session, and a random per-process index-incarnation
nonce. Results use the total order
`bm25 rank ASC, origin_server_ts DESC, room_id ASC, event_id ASC`; the cursor
contains the search ID, last tuple, and incarnation. Live indexing does not mutate
that snapshot, so pagination progresses on active accounts without duplicating,
skipping, or repeatedly restarting. Room purge and membership checks still suppress
departed-room results before return. Expired snapshots and pages routed to another
web process during a rolling deployment are rejected as stale, never replayed
against an independently rebuilt index. The UI restarts pagination from page one
on this typed response.
Each session has a strict cap on live snapshots and aggregate retained identifiers,
and the process has a separate global byte/count budget. Creating a first page
deterministically evicts that session's oldest snapshot or returns a typed
resource-limit error when the global budget cannot admit it; expiry and session
teardown release accounting immediately. Tests repeatedly request first pages,
including from concurrent hosted sessions, and assert both quotas and eviction.
Rolling-deploy integration tests alternate requests between old and new companion
processes. Results contain event ID, room ID, sender, origin timestamp, a plain-text
snippet with match ranges, and the next cursor; they never contain FTS-generated
HTML markup.

Executing a local-index query causes no Matrix protocol traffic. Opening a result
outside the loaded timeline can use the existing `/context` navigation path and
therefore reveals that event ID to the homeserver; the UI discloses that boundary
before the first network-backed jump. If a homeserver-side fallback is desired for rooms
the local index hasn't caught up on yet (freshly joined room, unencrypted room with
old history not yet synced), that's an explicit "search on server too" opt-in
button, not automatic — avoid silently mixing local (private, but possibly
incomplete) and server (complete, but transmits the query in plaintext) result sets
without the user knowing which is which.

## API/contract changes

- New shared Rust search module with a small storage trait and a SQLCipher FTS5
  implementation. Desktop and web session layers own account-specific handles;
  neither transport owns indexing semantics.
- New default-off `encrypted_local_message_search` flag in both Rust and TypeScript
  catalogs. Opening, backfilling, writing, and querying the index are all disabled
  when the flag is off. An enabled-to-disabled transition first closes every
  account/session handle, securely removes the Charm-owned encrypted database
  and its WAL/SHM files, and records no reusable quarantine. Startup also purges
  a leftover index before serving other account work when the effective flag is
  false. Kill-switch tests cover an active handle, restart cleanup, and failure
  reporting without reopening the index.
- Because this flag controls a sensitive derived-content index, a trusted remote
  `false` is a hard veto over any persisted Labs/local override. The veto closes
  active handles and triggers the same purge even when Labs previously persisted
  `true`; tests cover that exact transition on every transport.
- The companion evaluates that flag in trusted server configuration on every
  indexing/search request (or through a bounded cache with explicit configuration
  invalidation), rather than binding a `true` value for the lifetime of a
  sliding-expiry session. Browser OFREP/local-storage state may hide UI but cannot
  enable indexing or search routes. Disabled and enabled companion sessions are
  covered separately, including a forged client request while the server-side
  value is false and a kill-switch transition during an active session.
- New IPC and authenticated web-companion command surface as above, with generated
  bindings via ts-rs per existing convention.
- Search instrumentation uses an explicit metadata allowlist: duration, result
  count, query byte length, scope kind, and typed error category only. It never
  logs command arguments, SQL with bound values, literal queries, snippets, or
  result DTOs. Error and telemetry tests submit distinctive raw markers and verify
  they are absent, and the operations observability guidance documents this rule.
- No changes to existing commands.

## Testing strategy

- Rust unit tests: index insert/query/redact/edit-replace correctness against a
  fixture set of events, including multi-room, multi-sender, text-to-non-text
  replacements, out-of-order edits, equal-timestamp edits deferred until an
  authoritative collapsed projection is available, and redaction restoring the
  preceding renderer-selected searchable version.
- Rust unit tests: account A cannot open, query, or consume a cursor from account
  B; flag-off performs no index file creation; corrupt-schema rebuild cannot touch
  matrix-sdk files.
- Rust unit tests: literal quotes/operators, maximum query/page bounds, tied-result
  ordering, cursor TTL expiry and index-incarnation mismatch, local leave/forget and remote kick/ban
  purge, deactivation wipe, legacy web-session crypto-key migration, and
  web-session isolation/cleanup. Include substring word queries within unsegmented
  Chinese and Japanese sentences, not just whole-message queries.
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
  per-account file and a separate SQLCipher/key-derivation lifecycle.
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
