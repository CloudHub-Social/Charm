# charm-web-server

Companion HTTP server for Charm's web client (Spec 16). Exposes
`matrix-rust-sdk` over the network so the existing React app can run in a
browser, unmodified above `src/lib/matrix.ts`, talking to a real homeserver
through this server instead of Tauri IPC.

See the full repository spec:
[`Spec 16 — Web client via companion Matrix server`](<../../docs-site/src/content/docs/specs/day-1/Spec 16 — Web client via companion Matrix server.md>).

## Scope of this sub-PR (A)

- New crate sharing `src-tauri`'s `matrix/*.rs` business logic via a path
  dependency on `charm_lib` (added to a new root `Cargo.toml` workspace —
  `src-tauri` remains independently buildable, `cd src-tauri && cargo build`
  still works unchanged, this only adds a shared build graph/lockfile).
- axum HTTP router covering login/register/logout, room list, room details,
  member list, timeline pages, send/edit/reply/react/redact, run-command
  (slash commands), receipts/typing/mark-read, room organization
  (favourite/low-priority/marked-unread/manual-order), room admin (name,
  topic, avatar removal, join rule, history visibility, encryption,
  power levels, invite/kick/ban/unban), presence, own profile, and account
  data — one route per relevant existing `#[tauri::command]`/`_impl`
  function in `charm_lib::matrix`, reusing the same DTOs `ts-rs` already
  generates bindings for.
- `SessionStore`: an opaque, server-issued session token (via an
  `HttpOnly`/`SameSite=Strict` cookie) mapped to an in-memory
  `matrix_sdk::Client`. Every authenticated route resolves its session from
  this cookie via `require_session` before touching any `Client`.
- Multi-session isolation is covered by `tests/isolation.rs` (no live
  homeserver needed) and `tests/http_api.rs` (needs a running dev Synapse,
  same convention as `src-tauri/tests/`).

## Sub-PR B: WebSocket event channel + encrypted-at-rest persistence

- **WebSocket event channel** (`GET /api/ws`, `routes::ws_handler`) —
  authenticates via the same session cookie as every HTTP route, then
  streams `crate::events::ServerEvent` (an adjacently-tagged
  `{"event": "...", "data": ...}` envelope reusing the exact ts-rs DTOs
  desktop's `app.emit` payloads already use — see `events.rs`) for
  `sync:state`, `room_list:update`, `badge:update`, `receipts:update`,
  `typing:update`, `room_details:update`, `timeline:update`,
  `presence:update`, `profile:self`, `upload:progress`,
  `verification:request`, and `verification:sas_update`. Driven by
  `sync_loop.rs` (a per-session background `/sync` loop plus
  presence/self-profile/verification event-handler registration, mirroring
  `src-tauri/src/matrix/sync.rs::spawn_sync_loop` minus its desktop-only
  native-badge/notification concerns) and, for live timeline updates, a
  per-room listener spawned in `session.rs`'s `get_or_create_timeline`.
  `push:status` is **not** emitted — that's Spec 11's separate Web Push
  mechanism for a *closed* tab, not this open-connection channel.
- **Encrypted-at-rest session persistence** (`persistence.rs`) — sessions
  are now the spec's recommended option 2: AES-256-GCM-encrypted, keyed by
  `CHARM_WEB_SERVER_MASTER_KEY` (a deployer-provided base64 32-byte key; see
  the module doc comment), persisted as one object per opaque session token,
  and restored at startup under their original cookie so a restart doesn't
  force a re-login. AES-GCM associated data binds every ciphertext to its
  token-derived object path; the decrypted token is checked again on read,
  so a bucket writer cannot relocate one valid session onto another token.
  Opt-in: with no master key set, sessions fall back to sub-PR A's
  in-memory-only behavior rather than refusing to start.
- **Durable web crypto snapshots** (`crypto_backup.rs`) — the irreplaceable
  `matrix-sdk-crypto.sqlite3` database is copied with SQLite's online-backup
  API, independently AES-256-GCM encrypted, and committed to a separate
  private Spaces bucket. Snapshot authentication binds the cookie-token
  hash, Matrix user/device, random crypto-store id, generation, and filename.
  A bucket-level active-writer fence makes only the newest App Platform
  instance eligible to commit snapshots during zero-downtime deployment;
  restore ranks that writer's generations ahead of stale-instance uploads.
  Recovery-key import creates an immediate snapshot; active sessions refresh
  every five minutes and again during graceful shutdown. Room/state/media
  caches are intentionally excluded because the homeserver can rebuild them.
- **Media resolution, attachment upload, avatar upload** — bytes-based web
  equivalents of desktop's file-path-based commands (`resolve_message_media`,
  `send_attachment`, `set_avatar`/`remove_avatar` in `routes.rs`), reusing
  `charm_lib::matrix::media::resolve_media_impl` against a per-account
  `MediaCache` (`media_cache.rs`, keyed by
  `charm_lib::matrix::persistence::account_key` — never shared across
  sessions, so one account can't reach media only another account has
  decrypted). Resolved media is only ever served inline with its real
  `Content-Type` for `image/`/`audio`/`video/` *excluding* `image/svg+xml`
  (SVG is active content) — anything else is forced to
  `application/octet-stream` + `Content-Disposition: attachment`, plus
  `X-Content-Type-Options: nosniff` and `Cross-Origin-Resource-Policy:
  same-origin` on every response, since this route serves sender-controlled,
  privacy-sensitive bytes from the browser's authenticated API origin.
  `POST .../attachments` is `multipart/form-data` (`file` + optional
  `caption` fields, `txn_id` as a query param) rather than a raw body with
  filename/caption in headers or the query string — keeps a long caption
  out of header-size limits and browser history/access logs, and lets the
  `file` part's own `Content-Type` (the browser's real `File.type`) drive
  the sent event's mimetype instead of guessing from the filename alone.
  `GET /api/media/avatar?mxc=...` resolves a bare room/profile/sender
  avatar `mxc://` URI (every DTO this crate's routes return still carries
  those unresolved) to its thumbnail bytes, the avatar counterpart to
  `resolve_message_media`'s event-attached media. `PUT
  /api/rooms/{room_id}/avatar` uploads a room avatar (bytes-based, same
  shape as the account-avatar route) alongside the existing `DELETE` to
  remove one.
- **Multi-device verification** — accept/cancel/SAS-start/SAS-confirm,
  cross-signing bootstrap/status, and outgoing self-verification
  (`POST /api/verification/devices/{device_id}/request`,
  `sync_loop::request_device_verification`) routes, reusing the same
  `_impl` functions/SDK calls as desktop; SAS state changes stream as
  `verification:sas_update` over the WebSocket channel
  (`sync_loop::start_sas_verification`).

## Still deferred
- **No idle/abandoned-session expiry.** A session's sync loop (and the
  presence-online it sets) runs indefinitely until an explicit logout — a
  closed browser tab, or a restored-at-startup session nobody ever
  reconnects to, keeps long-polling `/sync` and advertising the account
  online forever. See `sync_loop::spawn`'s doc comment for why this needs
  its own idle-timeout design rather than a quick fix.
- **Device management endpoints (list/revoke/reset).** This sub-PR adds the
  outgoing-verification route (`request_device_verification`) but not the
  rest of desktop's `devices.rs` command surface a Settings → Devices UI
  actually needs first — listing this account's devices (to get the device
  ids `request_device_verification`'s route requires), revoking another
  session, or resetting cross-signing. A web session can respond to or
  initiate verification of a device it already knows the id of, but has no
  way yet to discover that id or manage devices otherwise. Straightforward
  `_impl`-reusing routes to add, same shape as the verification routes this
  sub-PR already has — left for a follow-up slice rather than growing this
  PR's already-large diff further.
- **Verification event delivery isn't fully acknowledgement-guaranteed.**
  `sync_loop::buffer_verification_event` buffers an event only when
  `broadcast::send` finds zero subscribers — but "a subscriber exists"
  isn't the same as "the frame actually reached the browser"; a connection
  that's live-but-about-to-die exactly when an event fires can still lose
  it. See that function's doc comment ("Known gap") for why closing this
  fully needs real delivery-acknowledgement semantics, not a one-line fix.
- **QR login.** Desktop's `qr_login::start_qr_login` is built around
  `MatrixState`'s single-client-per-process model (it drives an in-progress
  login to completion *before* any session/token exists to key it by) —
  porting it to a multi-session server needs its own session-lifecycle
  design, not just a route wrapper around the existing `_impl` functions the
  rest of this crate reuses. Left out rather than shipped half-adapted;
  pick up as its own slice.
- **Media download size isn't capped during download, only after.**
  `resolve_message_media` checks the resolved file's actual on-disk size
  against `MAX_ATTACHMENT_UPLOAD_BYTES` only once `resolve_media_impl` has
  already finished downloading and caching it — a sender who misreports (or
  omits) `info.size` can still make this route download and cache an
  arbitrarily large file before the oversized response is rejected and the
  cached copy removed. Enforcing the cap *during* download requires changing
  `charm_lib::matrix::media::resolve_media_impl` itself (shared with
  desktop, where an unbounded download is far less of a concern with one
  local user) — left as a follow-up rather than done here.
- A per-room `Timeline` LRU cache (mirroring desktop's `MAX_LIVE_TIMELINES`
  bound in `MatrixState`) — each `get_timeline_page` request (and each
  `timeline:update` push) currently opens/reuses a `Timeline` handle without
  a true incremental diff-to-DTO path (the WebSocket listener re-fetches a
  full page per diff rather than patching — see `session.rs`'s
  `spawn_timeline_listener` doc comment). Fine for MVP traffic; revisit if
  either becomes a hot path.

## Running

```
cargo run -p charm-web-server
```

Listens on `CHARM_WEB_SERVER_ADDR` (default `0.0.0.0:8787`).

The session cookie is `Secure` by default, which browsers refuse to store or
send over plain HTTP — `main.rs` itself only ever serves plain HTTP (TLS is
expected to terminate in front of it, e.g. a reverse proxy in production).
For local dev or any other non-TLS deployment, set
`CHARM_WEB_SERVER_INSECURE_COOKIES=1` to drop the `Secure` flag; never set
this in a production deployment that's actually behind TLS.

### Session persistence env vars

- `CHARM_WEB_SERVER_MASTER_KEY` — base64-encoded 32-byte AES-256 key
  (`openssl rand -base64 32`), enabling encrypted-at-rest session
  persistence (see `persistence.rs`'s module doc comment). Unset by default
  — sessions are in-memory only (sub-PR A behavior) until this is set.
- `CHARM_WEB_SERVER_DATA_DIR` — local backing data, media cache, and live
  Matrix SDK stores (default `./data`). App Platform's copy is ephemeral;
  sessions and durable crypto snapshots use their respective Spaces buckets.

### Durable crypto snapshot env vars

- `CHARM_WEB_SERVER_CRYPTO_SPACES_BUCKET`, `_REGION`, `_ENDPOINT`,
  `_ACCESS_KEY_ID`, and `_SECRET_ACCESS_KEY` — a separate private,
  bucket-scoped Spaces destination. Configuring the bucket makes all sibling
  values and encrypted session persistence mandatory; startup fails closed
  if any are absent.
- `CHARM_WEB_SERVER_DOPPLER_TOKEN` — read-only service token restricted to
  the single Doppler config containing `CHARM_WEB_SERVER_CRYPTO_BACKUP_KEY`.
  The server fetches only that named secret over HTTPS at startup and keeps
  it in process memory. Do not use Doppler's App Platform sync for this key.
- `CHARM_WEB_SERVER_CRYPTO_BACKUP_KEY` — direct base64 32-byte key override
  for local development/tests. Production should leave it unset and use the
  Doppler token so the backup key is never stored in App Platform config.

The Spaces credential authorizes object access; it is not an encryption key.
A bucket-only compromise exposes ciphertext and permits deletion/replay, not
decryption or cross-session relocation. A compromised running process can
still access plaintext by design, because it must restore Matrix state.

#### Rotation and retention

Rotate the Spaces credential independently by adding the replacement to App
Platform, redeploying, verifying a snapshot, then revoking the old key. To
rotate the crypto backup key without invalidating existing snapshots, first
deploy dual-key read support and rewrite every manifest/database generation;
never replace the Doppler value in place before that migration exists.
The server retains the three newest usable committed generations and
deletes older committed generations after each successful snapshot. Each
generation's encrypted `manifest.json` is its commit marker. Restore orders
complete generations by recency. Normal snapshots from a superseded writer are
fenced out, while its explicitly marked graceful-shutdown snapshot remains
eligible so the replacement can recover crypto changes learned during handoff.
A replacement publishes its active-writer fence only after session restoration
and listener binding succeed, so a failed startup cannot disable snapshots
from the healthy serving instance. Logout deletes all generations best-effort.
An optional bucket lifecycle expiry can clean up objects left by interrupted
uploads, but its age also becomes the maximum lifetime of a dormant session's
last backup.

### Observability (Sentry) env vars

See `observability.rs`'s module doc comment for the full design. Unset by
default — this process logs to stdout only (via `tracing_subscriber::fmt`)
until `CHARM_WEB_SERVER_SENTRY_DSN` is set; there's no per-user consent
toggle to configure separately (unlike desktop/frontend), since this is a
headless backend process with a single operator-controlled opt-in gate.

- `CHARM_WEB_SERVER_SENTRY_DSN` — Sentry project DSN. Unset (default): no
  `sentry::init` call happens at all.
- `CHARM_WEB_SERVER_SENTRY_ENVIRONMENT` — optional, e.g. `production`/`dev`.
- `CHARM_WEB_SERVER_SENTRY_RELEASE` — optional; falls back to this crate's
  own `CARGO_PKG_NAME@CARGO_PKG_VERSION` (via `sentry::release_name!()`) when
  unset. Nothing in CI sets this today (see the env var's own doc comment).
- Every event/log is scrubbed through `charm_lib::observability_scrub`
  (shared with desktop) before it ever leaves the process — Matrix
  IDs/room IDs/event IDs/MXC URIs and known secret fields (access/refresh
  tokens, passwords, recovery keys, etc.) are redacted unconditionally,
  matching `PRIVACY.md`'s guarantee regardless of platform.

### WebSocket origin allowlist and CORS

- `CHARM_WEB_SERVER_ALLOWED_ORIGIN` — the frontend origin(s) allowed to open
  `GET /api/ws` (comma-separated for more than one). **Set this before
  deploying charm-web-server** — the session cookie's
  `SameSite=Strict` doesn't defend against a same-*site* subdomain (a
  different origin, same registrable domain) opening this socket and
  attaching the cookie automatically; only an explicit `Origin` check does.
  Unset by default; WebSocket upgrades and raw-body requests with an
  `Origin` header fail closed until this is configured. Configure this even
  for same-origin browser deployments, because browsers send an `Origin`
  header on WebSocket handshakes.
  - Exact origins are preferred. For dynamic preview URLs, one constrained
    wildcard is supported per entry, with both a non-empty prefix and suffix
    (for example,
    `https://pr-*-charm-preview.<account>.workers.dev`). Broad host-wide
    patterns such as `https://*.workers.dev` are intentionally rejected.
- The same allowlist also drives the router's `CorsLayer` (credentialed —
  `Access-Control-Allow-Credentials: true`, needed for the session cookie),
  covering the rest of the HTTP API. An empty allowlist grants no
  cross-origin CORS access at all. Same-origin HTTP requests that do not hit
  the WebSocket/raw-body origin guard need no CORS headers to work. **Set
  `CHARM_WEB_SERVER_ALLOWED_ORIGIN` if the frontend is served from a
  different origin than this API** (e.g. a Vite dev server on a different
  port, or a separately-hosted production frontend) — otherwise the browser
  blocks every response for lacking `Access-Control-Allow-Origin`.

## Deployment

The production service runs on DigitalOcean App Platform from `.do/app.yaml`.
GitHub Actions merges that checked-in spec with live secret values and creates
an explicit deployment after `main` passes its checks. Session records and
crypto snapshots use separate private Spaces buckets because App Platform's
local filesystem is ephemeral. The one-time bucket, scoped-key, Doppler token,
and lifecycle setup is documented at the top of `.do/app.yaml`.

## Testing

- `cargo test -p charm-web-server --lib` — `persistence.rs`'s own unit tests
  (encryption round-trip, wrong-key rejection, save/remove semantics), no
  homeserver required.
- `cargo test -p charm-web-server --test isolation` — session-store
  isolation (including per-session WebSocket event-channel isolation and
  restart-reinsertion under a stable token), no homeserver required.
- `cargo test -p charm-web-server --test http_api` — full HTTP surface plus
  the WebSocket event channel, against a real homeserver at `localhost:8008`
  (`TEST_MATRIX_USERNAME`/`TEST_MATRIX_PASSWORD` env vars, same convention as
  `src-tauri/tests/common`). The WebSocket tests bind a real ephemeral TCP
  listener (`oneshot` can't drive a protocol upgrade) and use
  `tokio-tungstenite` as a real client.
