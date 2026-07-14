---
title: Rust companion API
description: Run, secure, deploy, and verify the axum service used by Charm's browser client.
---

`crates/charm-web-server` exposes the shared `matrix-rust-sdk` operations over
HTTP and WebSocket so the React client can run in a normal browser. Above the
transport boundary, the web and Tauri clients reuse the same DTOs and Matrix
business logic.

```d2
direction: right
Browser -> Cloudflare: "same-origin /api/*"
Cloudflare -> axum: "proxy"
axum -> SessionStore: "HttpOnly cookie"
SessionStore -> matrix-rust-sdk: "per-session Client"
matrix-rust-sdk -> Homeserver: "/sync + client API"
axum -> Browser: "HTTP responses + /api/ws events"
```

## Run locally

```sh
cargo run -p charm-web-server
```

The default listener is `0.0.0.0:8787`; override it with
`CHARM_WEB_SERVER_ADDR`. The process itself serves HTTP and expects TLS to
terminate at a reverse proxy in production.

For plain-HTTP local development only, set
`CHARM_WEB_SERVER_INSECURE_COOKIES=1`. Without it, browsers correctly refuse
to store the server's `Secure` session cookie over HTTP. Never use this flag on
a TLS-backed production deployment.

## Request and event surfaces

- Login, registration, logout, profile, rooms, members, timelines, message
  actions, receipts, typing, room administration, organization, media, and
  verification are exposed as typed HTTP routes under `/api`.
- `GET /api/ws` authenticates with the same cookie and streams typed
  `ServerEvent` envelopes for sync, room lists, timelines, receipts, typing,
  profile, verification, and other live state.
- `GET /api/health` is the unauthenticated liveness check.
- Protected routes must resolve a session first. An unauthenticated request to
  a known route such as `/api/devices` returns `401`; `404` means the deployed
  router is missing the expected surface.

## Session and state model

The server issues an opaque `HttpOnly`, `SameSite=Strict` cookie and maps it to
one `matrix_sdk::Client`. Sessions and caches are isolated per token/account.
The browser never receives the Matrix access token.

Without `CHARM_WEB_SERVER_MASTER_KEY`, sessions are memory-only and a restart
requires login again. Supplying a base64-encoded 32-byte key enables
AES-256-GCM encrypted session persistence under `CHARM_WEB_SERVER_DATA_DIR`.

Durable crypto snapshots use a separate private Spaces bucket and encryption
key. Production retrieves the backup key through a restricted Doppler service
token rather than storing it in App Platform configuration. App Platform's
local filesystem remains ephemeral; do not treat it as the durable copy of a
user's crypto store.

The complete persistence, rotation, retention, and active-writer fencing model
is documented in
[`crates/charm-web-server/README.md`](https://github.com/CloudHub-Social/Charm/blob/main/crates/charm-web-server/README.md).

## Origin and cookie security

Set `CHARM_WEB_SERVER_ALLOWED_ORIGIN` to the exact frontend origin or a
comma-separated allowlist. This setting controls credentialed CORS and the
WebSocket/raw-body `Origin` guard.

`SameSite=Strict` is not a substitute for origin validation: another subdomain
can be same-site while still being a different origin. Dynamic preview hosts
may use only the supported constrained wildcard form, with non-empty prefix and
suffix. Broad patterns such as `https://*.workers.dev` are rejected.

## Production deployment

`.github/workflows/web-server-deploy.yml` runs when the crate, shared Matrix
code/bindings, observability scrubber, Cargo workspace, App Platform spec, or
workflow changes on `main`.

The workflow:

1. fetches the live DigitalOcean app spec;
2. merges checked-in structural changes from `.do/app.yaml` while preserving
   DigitalOcean's encrypted secret values;
3. updates the app and waits for a new deployment;
4. verifies `/api/health` returns `200`;
5. verifies unauthenticated `/api/devices` returns `401`.

The live-spec merge is important: applying `.do/app.yaml` as a full replacement
would erase secret values that cannot exist in Git.

## Backend observability

Set `CHARM_WEB_SERVER_SENTRY_DSN` to initialize the backend Sentry client;
otherwise the process logs to stdout only. Optional environment and release
overrides are `CHARM_WEB_SERVER_SENTRY_ENVIRONMENT` and
`CHARM_WEB_SERVER_SENTRY_RELEASE`.

Every backend event passes through the shared Rust observability scrubber before
leaving the process. See [Sentry observability](../sentry/) for the broader
runtime and release model.

## Tests

```sh
cargo test -p charm-web-server --lib
cargo test -p charm-web-server --test isolation
cargo test -p charm-web-server --test http_api
```

The first two do not require a homeserver. `http_api` uses a real local
homeserver at `localhost:8008` plus `TEST_MATRIX_USERNAME` and
`TEST_MATRIX_PASSWORD`, and opens a real TCP listener for WebSocket coverage.
