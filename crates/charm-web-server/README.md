# charm-web-server

Companion HTTP server for Charm's web client (Spec 16). Exposes
`matrix-rust-sdk` over the network so the existing React app can run in a
browser, unmodified above `src/lib/matrix.ts`, talking to a real homeserver
through this server instead of Tauri IPC.

See the full spec: `Knowledge-Platform/10-19 Personal Life/15 Personal
projects/15.12 Charm 2.0/specs/Spec 16 — Web client via companion Matrix
server.md`.

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

## Deferred to sub-PR B (WebSocket + storage)

- **WebSocket event channel** mirroring `app.emit(...)` (`sync:state`,
  `room_list:update`, `timeline:update`, `verification:*`, `profile:update`,
  receipts/typing/presence, `push:status`) — not implemented here. Every
  route above is request/response only; there is no live push yet, so a
  connected browser tab would need to poll.
- **Encrypted-at-rest session persistence.** Sessions in this sub-PR are
  **in-memory only, per the spec's Design section's option 1** (ephemeral,
  no persistence) — a process restart drops every session and every
  logged-in browser needs to log in again. The spec's own recommendation for
  this project's scope is actually **option 2** (server-side encrypted-at-
  rest storage, persisted per logged-in user, surviving a restart) — that is
  explicitly the sub-PR B scope, not skipped by oversight. Option 1 is a
  reasonable starting point on its own merits too (simplest, matches how
  PR-preview sessions are inherently throwaway per the spec's scope item 6),
  but the final state this phase is building toward is option 2.
- Media resolution/upload, avatar upload (both file-path-based on the
  desktop side and need a web-appropriate equivalent — an authenticated
  HTTP endpoint serving resolved media, per the spec's frontend-transport
  section), multi-device verification, and QR login are all out of scope
  for this slice — same pattern (`_impl` function exists, route doesn't yet)
  applies to each when picked up.
- A per-room `Timeline` LRU cache (mirroring desktop's `MAX_LIVE_TIMELINES`
  bound in `MatrixState`) — each `get_timeline_page` request currently opens
  a fresh `Timeline` handle. Fine for MVP request volume; revisit if this
  becomes a hot path.

## Running

```
cargo run -p charm-web-server
```

Listens on `CHARM_WEB_SERVER_ADDR` (default `0.0.0.0:8787`).

## Deployment (not done as part of this PR — flagged as a manual follow-up)

Per the spec's Deployment topology: this runs as another persistent process
on the existing `matrix-vps` (`matrix-cloudhub-1.cloudhub.social`), alongside
Synapse/Dex/MAS — either another `docker-compose` service or a systemd unit,
matching how that stack already runs. No Cloudflare Containers spike (that's
explicitly shelved in the spec). This PR does not deploy anything live —
confirm VPS capacity and add the compose service/systemd unit as a separate,
deliberate change.

## Testing

- `cargo test -p charm-web-server --test isolation` — session-store
  isolation, no homeserver required.
- `cargo test -p charm-web-server --test http_api` — full HTTP surface
  against a real homeserver at `localhost:8008`
  (`TEST_MATRIX_USERNAME`/`TEST_MATRIX_PASSWORD` env vars, same convention as
  `src-tauri/tests/common`).
