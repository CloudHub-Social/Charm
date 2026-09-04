---
title: Charm 2.0 Spec — Cross-room message search
type: spec
project: Charm 2.0
created: 2026-07-13
status: shipped
---

## Implementation status

Charm now ships encrypted local message search behind the default-off
`encrypted_local_message_search` flag on desktop and the web companion. A dedicated,
per-account/device SQLCipher database is owned by Charm rather than matrix-sdk.
Its domain-separated key comes from the existing random encrypted-store secret;
neither that source secret nor the derived key crosses IPC or appears in logs.

Decrypted `m.text`, `m.notice`, and `m.emote` events from every joined room flow
through bounded background workers into an FTS5 trigram index. Replies are
normalized, spoiler-bearing events fail closed, edits replace the visible result,
forged cross-sender edits are ignored, and redactions or joined-to-left transitions
physically remove indexed text and compact SQLite sidecars. Queries re-check the
current joined-room set, support current-room and global scope with stable cursors,
and return plain snippets plus UTF-16 match ranges. Desktop IPC and the authenticated
web route share the same storage/query core. Logout and account deactivation close
and delete the derived index; the companion does the same on session logout.

The feature UI adds a distinct message-search button and `Cmd/Ctrl+F`, scoped/all-
room selection, keyboard-accessible results, incomplete-index disclosure, and
navigation through the existing load-around-event/highlight path. Search sessions
are intentionally ephemeral: closing and reopening the dialog resets both the query
and its results so the input never describes an empty result pane. Repository
evidence includes SQLCipher marker scans, no-follow filesystem tests, edit/redaction/
cursor/query tests, component coverage, workspace compilation, and a Playwright
search-navigation journey. Real-homeserver verification remains operational
evidence rather than a repository correctness gate. Filesystem/backup hardening and
durable overflow recovery remain tracked in
[#415](https://github.com/CloudHub-Social/Charm/issues/415),
and [#419](https://github.com/CloudHub-Social/Charm/issues/419). Kill-switch
reconciliation now survives renderer and process restarts.

**Workstream:** shipped daily-driver parity; bounded resilience follow-ups remain.

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
bundled SQLCipher FTS5/tokenizer availability, key custody, and backup exclusion before enabling
the flag.
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
  stripper or index hidden/disallowed elements. Because the result DTO cannot
  preserve concealed ranges, fail closed for any event containing a
  `data-mx-spoiler` element, so concealed text cannot appear in either matches or
  plain snippets. When normalizing an edit of a reply, carry
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
  Renderer selection mutations contain event IDs only and use reliable FIFO
  reservations when the plaintext queue is full. Cached-history retries replay
  current open timeline selections before their completion marker, rather than
  assuming raw events can reconstruct equal-timestamp renderer choices. Native
  metadata-retention and companion FIFO-order regressions require CI execution.
  Redacting the original writes a persistent
  tombstone, deletes the visible row, and purges every original/edit decrypted body
  in provenance; later edits and replay must remain suppressed by that tombstone.
  Redacting an edit removes that candidate and atomically recomputes the row from
  the preceding valid edit or original content only when the original is not
  tombstoned. An edit that arrives before its original remains encrypted,
  non-visible provenance until the original establishes the sender; forged-sender
  candidates are then removed before any row becomes visible. Schema migration
  enforces the same boundary when rebuilding visible rows: missing originals
  remain deferred and known mismatched-sender candidates are purged. Regression
  coverage migrates both legitimate and forged edits received before originals;
  schema version 6 also sanitizes already-installed version-5 databases, retaining
  their renderer selection ordering and saved equal-order edit choice while
  rebuilding visible rows and FTS, even with no open room listener. Saved choices
  cannot override a newer edit or restore a forged-sender candidate. Regressions
  cover tied choices, stale choices, and forged provenance with a saved choice
  and an existing forged FTS row in v5.
  GitHub Actions verification remains required. A late
  edit/redaction, backfill, or replay therefore converges without retaining or
  resurrecting stale or redacted text.
  Filtering an ignored original also queues plaintext-free cleanup of every
  candidate linked to that original, including unverified edits from another
  sender. This is reliable removal work, not a permanent redaction tombstone;
  unignore and replay remain possible. An ignored edit cannot authorize purging
  the original it claims to replace. Regression coverage remains CI-gated.
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
  WAL, SHM, and rollback-journal pages must not expose it at rest. Android excludes
  the actual Tauri app-data `message_search/` root from both cloud backup and device
  transfer through the `root` backup domain. iOS marks that exact direct child as
  excluded from backup when the root is created; the native bridge compares path
  components instead of trusting a string prefix.
- Desktop logout closes and deletes the current device's index, because Charm's
  logout flow revokes and removes that session and a later interactive login creates
  a new device that cannot safely reopen the old device-keyed index. Creating a
  superseding device likewise closes and deletes the prior device index. Account
  deactivation must close and delete every retained index.
  An explicit account-management "Forget local data" control that closes the
  account, removes both the retained SDK store and every search index, and tests
  the confirmation and physical cleanup remains lifecycle follow-up
  [#416](https://github.com/CloudHub-Social/Charm/issues/416). Its Spec 08 copy must
  disclose the separately encrypted search index and key lifecycle. Web logout,
  session expiry, and administrative session removal close and delete that
  session's index. A failed/corrupt migration records only non-sensitive diagnostics
  (schema version, error category, and a random incident ID), securely removes the
  search database plus WAL/SHM/rollback-journal sidecars through the same bounded
  cleanup path, and rebuilds from decrypted SDK history. Cleanup first validates
  the opaque search root, direct account/device child, and complete retained-file
  allowlist; symlinks and unexpected entries fail closed before deletion. A private,
  opaque cleanup marker survives failure or process exit and must reconcile before
  that account/device path can reopen. Explicit device, account, and all-index
  cleanup are idempotent, attempt every retained target even when one target fails,
  and never traverse into matrix-sdk-owned storage. Merely
  switching the active in-process handle closes but does not opportunistically
  delete an inactive account/device database; lifecycle teardown owns deletion.
  No decrypted-content quarantine is retained and an SDK store is never modified.
- Terminal-authentication cleanup and remote device-revocation recovery remain
  resilience work in [#416](https://github.com/CloudHub-Social/Charm/issues/416).
  Queries still fail closed once the owning authenticated session is unavailable.
- Web indexes are intentionally session-ephemeral in the first slice. They are not
  copied into the crypto-store backup and may be rebuilt only from decrypted
  history available to that same session after restart. The UI must disclose
  incomplete results after a deployment/restart; durable search-index backup is
  out of scope. In a hosted deployment decrypted text exists in the companion
  process while indexing and querying, not in the browser or user's device.
  SQLCipher protects disk snapshots but does not protect against an operator or
  attacker with access to live process memory. Web operations guidance and the UI
  disclose that trust boundary. Web logout deletes the session index; host-backup
  exclusion remains deployment-specific, while the shared bounded cleanup contract
  applies to web logout, expiry, and administrative session removal.
- Run schema creation, writes, rebuilds, and queries off the async runtime's worker
  threads. Sync/timeline delivery must not wait on SQLite I/O. Feed the worker
  through a bounded per-session queue. Overflow never retains unbounded decrypted
  text: it drops the batch, marks the index incomplete, and discloses that state on
  every result page. Desktop/mobile also writes an empty per-device directory
  checkpoint when work is dropped or fails. The checkpoint contains no message
  plaintext, survives restart, and clears only after a complete local event-cache
  scan and its FIFO completion marker both succeed. A later search claims one
  bounded retry while results remain incomplete. Native retry admission clears
  the previous failure under the lifecycle lock before detaching the scan;
  subsequent live failures remain sticky and cannot be erased by task startup.
  Web retry admission likewise clears the prior failure under the same mutex
  used by live sync, timeline-selection, pagination, and purge failure writers;
  detached scan startup never clears failures. Web indexes are session-ephemeral,
  so a later search similarly coalesces one local-cache rebuild after failure and a
  process restart creates a fresh incomplete index; neither transport invokes
  homeserver search or forces history pagination for reconciliation.
- Live indexing is sourced before room UI/timeline selection: the shared Rust sync
  pipeline decrypts joined-room timeline events from every sync response and submits
  eligible events to the indexer even when that room has never been opened. The
  current `m.ignored_user_list` is applied before live writes;
  newly ignored senders are purged transactionally before the updated ignore list
  becomes visible to queries. Unignoring permits future live writes; durable local
  backfill and reconciliation are the same bounded follow-up in #419. The indexer
  never scrapes mounted React timelines.

### Search UI

- Entry point: a dedicated search affordance (`Cmd/Ctrl+F` or a search icon in
  the room-list header, distinct from Spec 19's existing "Search everywhere" filter
  — clarify/differentiate the two entry points so users don't confuse "find a room"
  with "find a message" during implementation).
- Results: list of matches with room name, sender, timestamp, and the backend-provided
  plain-text snippet plus match ranges. The UI must not consume or render FTS-generated
  `snippet()`/`highlight()` markup.
- Scope toggle: "this room" vs "all rooms" — mirrors Charm 1.0's per-room vs global
  search modes. Room scope is fail-closed: if the active room disappears between
  render and submission, Charm issues no request rather than encoding that missing
  room as the global `null` scope. Submission and pagination resolve the same
  effective scope, and an explicit scope change clears the prior page and cursor.
- Selecting a result jumps to that message in its room's timeline and highlights it
  (reuse the scroll-to/highlight mechanism Spec 03's reply-click-to-scroll already
  has, if one exists, rather than building a second one). Navigation revalidates
  current joined-room state: a result that outlives a leave or kick keeps the
  dialog open and explains why it is no longer available instead of closing as
  though navigation succeeded.

## Data flow

New Tauri/web-server command:

`search_messages(query, room_id?, limit, cursor) -> SearchResultPage`

The user query is literal text, not raw FTS5 syntax. The backend stores the
unmodified display text separately from the token/search representation and uses
SQLite's maintained FTS5 `trigram` tokenizer. This supports literal substring and
unsegmented CJK matching without adding a new package. Queries shorter than three
characters use an escaped parameterized `LIKE` fallback. The backend converts
matched spans to UTF-16 code-unit offsets before transport and returns the original
display snippet plus those JavaScript-safe ranges; pre-segmented or normalized text
is never returned to the UI.
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
Each index caps snapshots at eight and identifier capture at 2,000 results, evicting
the oldest snapshot after its five-minute TTL. A cursor from another index
incarnation is rejected as stale. Results contain event ID, room ID, sender, origin
timestamp, a plain-text snippet with match ranges, and the next cursor; they never
contain FTS-generated HTML markup.

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
  when the flag is off. An enabled-to-disabled transition first closes the active
  handle, securely removes every retained Charm-owned account/device encrypted
  database and its database sidecars immediately, and records no reusable
  quarantine. A marker outside the bounded search root durably records destructive
  cleanup intent before deletion begins. Repeated disabled syncs skip marker
  writes only when both the search root and cleanup marker are definitely absent;
  metadata errors, symlinks, and pending markers still take the recovery path.
  Native startup recovers already-recorded cleanup intent before session
  restoration, but does not create new destructive intent from an unvalidated
  cached flag. Native search access and new flag-driven purges remain inactive
  until the renderer has awaited cohort/endpoint cache normalization and called
  native reconciliation. Receiver-only startup cannot use or newly purge search
  before that point. Renderer startup also
  reconciles both disabled-to-disabled and cached-enabled state with the native
  backend. Search remains unavailable in the renderer until that reconciliation
  succeeds, without discarding the user's saved override or blocking unrelated
  flag values. Labs and OFREP writes are serialized so a
  re-enable cannot overtake cleanup. Persistent cleanup failure pins the remote
  search value off without blocking durable updates to unrelated remote flags.
  Every open, write, and query fails closed
  while the marker remains. The marker contains no account, room, event, or message
  identifier.
- Because this flag controls a sensitive derived-content index, a trusted remote
  `false` is a hard veto over any persisted Labs/local override. The desktop veto
  prevents queries immediately and triggers the cleanup path above.
- The companion requires trusted server configuration
  (`CHARM_WEB_ENCRYPTED_LOCAL_MESSAGE_SEARCH=1`) before creating a worker or serving
  the search route. Browser OFREP/local-storage state may hide UI but cannot enable
  indexing or search routes.
- New IPC and authenticated web-companion command surface as above, with generated
  bindings via ts-rs per existing convention.
- Search instrumentation uses an explicit metadata allowlist: duration, result
  count, query byte length, scope kind, and typed error category only. It never
  logs command arguments, SQL with bound values, literal queries, snippets, or
  result DTOs. Error and telemetry tests submit distinctive raw markers and verify
  they are absent, and the operations observability guidance documents this rule.
- No changes to existing commands.

## Validation evidence and follow-ups

- Rust storage tests cover encrypted-at-rest marker scans, literal queries,
  Unicode substring matching, account/cursor isolation, edit replacement and
  sender validation, redaction restoration and tombstones, room/sender purge,
  cursor expiry/incarnation, migration, no-follow filesystem containment, bounded
  device/account/all cleanup, unexpected-entry rejection, durable cleanup blocking,
  rollback-journal removal, and exact Android/iOS path-boundary contracts.
- Sync-ingestion tests cover eligible decrypted text, notices and emotes; reply
  fallback removal; spoiler exclusion; edits, redactions, ignored senders, and
  joined-to-left purges. Ciphertext and undecryptable placeholders are never an
  input to the indexer.
- Frontend component coverage exercises query, fail-closed room scope, scope-change
  cursor reset, pagination, incomplete-index disclosure and result selection.
  Playwright covers the room-scoped shortcut and navigation journey through the
  mocked transport.
- GitHub Actions Rust/frontend checks and docs/Storybook/Playwright gates are the
  repository acceptance evidence; Charm's workstation policy intentionally skips
  local build and test execution. The iOS simulator build provides compile evidence
  for the native backup bridge, but actual backup/restore behavior on Android and
  iOS remains platform runtime evidence. Live Synapse verification of encrypted send,
  edit, redaction, restart persistence, desktop, and web companion behavior must be
  recorded separately and must not be inferred from repository tests.
- Durable reconciliation for edit-order ambiguity, missed/deferred events, ignore
  list changes, and queue overflow remains tracked in
  [#419](https://github.com/CloudHub-Social/Charm/issues/419).

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
