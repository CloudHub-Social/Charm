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

Experimental Matrix writes also require a companion-side rollout gate. Spec 33
space-parent creation and reorganization remain disabled unless
`CHARM_FEATURE_SPACE_HIERARCHY_REORGANIZATION` is set to `1` or `true`.
Read-only space hierarchy browsing and top-level space creation are unaffected.

The refreshed browser shell also requires
`CHARM_FEATURE_UX_REFRESH_V1=1` on the companion to include the message-preview
and recent-activity metadata it renders. This server-side metadata gate defaults
off and must be enabled alongside the browser's `ux_refresh_v1` rollout.

First-time recovery setup requires both the browser's `crypto_backup_setup` flag
and `CHARM_WEB_CRYPTO_BACKUP_SETUP=1` on the companion. The server gate defaults
off. `POST /api/verification/recovery/setup` authenticates the session, validates
the optional passphrase through the shared native boundary, and returns the
issued recovery credential with `Cache-Control: no-store`. A later durable-store
snapshot failure is logged without secrets and does not suppress the issued key.

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

The cookie carries an explicit 30-day `Max-Age`
(`session::SESSION_COOKIE_MAX_AGE_SECS`) rather than expiring at browser
close: without one, most browsers discard it as soon as the browser fully
quits, forcing a full re-login — and, since e2ee verification is tied to the
device, a fresh recovery-key prompt — far sooner than the persisted session
backing it actually goes away. The cookie is refreshed with a new 30-day
window on every authenticated request that resolves to a still-active
session, so continuous use never runs out the clock; only real inactivity for
the full 30 days does. A companion background sweep (once daily) revokes the
Matrix access token and deletes the persisted session and crypto store for
any session that has gone unused past that window, so a browser that lost or
never presented the cookie again doesn't leave server-side state valid
indefinitely.

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

When `CHARM_WEB_REGISTRATION_AND_RECOVERY=1` exposes browser SSO, also set
`CHARM_WEB_SERVER_PUBLIC_URL` to the operator-controlled HTTPS origin of the
companion. It is the sole callback-authority source; request `Host` and
forwarded headers are deliberately ignored. Plain HTTP is limited to local
development with `CHARM_WEB_SERVER_INSECURE_COOKIES=1`.

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
3. binds the selected protected revision and requests one spec/source update,
   waiting for that operation (without a second `create-deployment` request);
4. verifies `/api/health` returns `200`;
5. verifies unauthenticated `/api/devices` returns `401`.

The live-spec merge is important: applying `.do/app.yaml` as a full replacement
would erase secret values that cannot exist in Git.

## Writer activation diagnosis

A writer-handoff timeout reports `attempts`, `mutation_waits`, and
`conditional_conflicts` in the existing startup error. Counts distinguish waits
for a live recovery mutation from failed conditional publication; mixed counts
are possible. They contain no fence contents, owner identities, snapshot data,
credentials, or key material. The existing retry budget, delays, leases and
ownership checks are unchanged.

`create_conflicts` and `update_conflicts` separate failed create-if-absent
requests from failed version-conditional updates. `observed_version_changes`
counts changes in the metadata returned by successive existing reads, including
appearance or disappearance of the object; the first read is not a change.
No additional storage request is made, and metadata values are never logged.
Zero changes means only that the reads returned identical metadata, not that
the provider returned fresh data. An update precondition error may also represent
the dependency's translation of a missing-object response, so these counts do
not establish an underlying HTTP status or prove provider incompatibility.

The conflict counters also classify retained HTTP status as `http_404`,
`http_412`, `http_other`, or `http_unknown`. The pinned storage dependency keeps
that status in a private error type even when it maps update-404 to a precondition
error. A bounded formatter recognizes only its fixed status prefix and stops
before URLs or response bodies; unrecognized formats remain unknown. These
categories never affect retry, lease or conditional-write decisions and add no
requests. Synthetic HTTP fixtures distinguish mapped 404 from 412. This does not
establish which status production returned before these counters existed, nor
prove that a 412 means the provider lacks conditional-write support.

An exhausted activation attempt budget is different from an individual request
timeout. With the pinned dependency, a final transport timeout or HTTP 408 is a
generic error and exits activation; it is not counted as a conditional conflict.
Synthetic fixtures cover both timeout cases. Transient internal retries can
still precede a final conditional response, so counts alone do not establish
per-request latency or immediate rejection. Do not increase timeout settings
merely because the application exhausted its attempt budget.


A conflict count does not establish why publication failed or authorize clearing
a fence. Preserve the old writer and durable data while investigating issue573.
An automatic rollback and healthy routes prove service availability only; verify
the provider's active source revision before claiming a candidate is deployed.

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

## Related documentation

- [Spec 16: web client architecture](/specs/day-1/spec-16--web-client-via-companion-matrix-server/)
  defines the companion-server boundary and shared client contract.
- [Spec 25: persistent crypto state](/specs/day-1/spec-25--persistent-crypto-state-and-recovery-key-sufficient-verification-web-client/)
  governs durable browser-session crypto and recovery behavior.
- [Cloudflare previews](../cloudflare-previews/) documents the same-origin
  Worker proxy in front of this service.
- [Sentry observability](../sentry/) covers backend telemetry, release tags,
  and privacy scrubbing.

### Writer fence reader compatibility

The current reader accepts the original plain alphanumeric writer IDs (and
hyphen/underscore fixture IDs) as well as JSON lease fences. Malformed structured
fences fail closed with a payload-free error; they must not silently become
legacy IDs with no lease. A regression fixture verifies that activation leaves
such bytes unchanged. This is a parser hardening change, not evidence that
malformed production data caused issue573.

The running legacy revision092dba3 reads JSON bytes as a literal ID. A change to
the current reader cannot retrofit that old process. A compatibility backport
would need JSON decoding plus equivalent pending/expired ownership decisions;
merely extracting writer_id does not preserve lease behavior. Such a backport
also does not fix the legacy unconditional startup write or add mutation leases.
Do not force a rollout, clear a fence, or waive conditional-write safeguards on
the assumption that parsing alone resolves the startup failure. The Spaces probe
is paused, and no new test infrastructure is a rollout prerequisite.


### Release source guard and remaining transition requirements

The release workflow supplies `CHARM_WEB_SERVER_EXPECTED_SOURCE_SHA` from its
protected-main `GITHUB_SHA`, and binds `CHARM_WEB_SERVER_SOURCE_SHA` to App
Platform's `${_self.COMMIT_HASH}`. Before telemetry, credentials, storage or
background tasks initialize, the API requires both values to be matching full
lowercase commit hashes whenever a Spaces bucket is configured. A blank crypto
bucket disables crypto backup and does not alone require provenance; the session
bucket retains its separate presence-based configuration semantics. Use without Spaces (including local filesystem persistence) and without either
provenance variable remains supported. Supplied invalid or
partial metadata always fails closed. This trusts the provider's build metadata;
it is not a new artifact attestation or a replacement for protected review and
exact-revision CI. These two nonsecret runtime entries require approval as part
of the still-held production transition.

The workflow issues one `apps update --update-sources --wait` request, with
automatic HTTP retries disabled for that mutation. An error or wait timeout is
not proof of nonexecution: inspect the existing provider operation before any
retry. Workflow serialization is not cross-run idempotency; a manual rerun or
separate dispatch still requires outcome reconciliation. This proposal does not
change provider deployment settings or make an earlier binary enforce the guard.

Do not start the old `092dba3` binary after a candidate may have written JSON
writer state. Provider rollback restores code and configuration, not durable
object state. A safe fallback must understand the current lease protocol and
preserve conditional writes, recovery ownership and pending/expired decisions.
A parser-only legacy backport is insufficient. No supported automatic-fallback
control guaranteeing that behavior has been established for this app.

The legacy shutdown message announces snapshot work; it is not a receipt that
all final snapshots succeeded. The shutdown loop logs individual failures and
continues without an aggregate success result. Neither a clean process exit nor
an absence of errors proves positive snapshot completion. Before a transition,
require positive final-snapshot evidence, confirmed cessation of every old
background writer, and a compatible failure destination. The current patch does
not produce those receipts for the already-running legacy binary. No live
classifier, fence modification, forced rollout or new test bucket is authorized
by this proposal. Transition downtime remains unknown.

Provider references: [source update and wait semantics](https://docs.digitalocean.com/reference/doctl/reference/apps/update/),
[build commit binding](https://docs.digitalocean.com/products/app-platform/how-to/use-environment-variables/),
and [rollback behavior](https://docs.digitalocean.com/products/app-platform/how-to/manage-deployments/).

## R2 state repair (qualification pending)

The proposed production authority is private R2 bucket
`charm-api-state-production`. It holds the complete encrypted `sessions/`
namespace and `control/active-writer`. Crypto database generations and manifests
remain in the original Spaces crypto bucket. This is encrypted secret-bearing
session data, not metadata-only. Encryption keys remain in their existing stores.

Configure the complete `CHARM_WEB_SERVER_STATE_` group: `BUCKET`, `ENDPOINT`,
`REGION` (`auto`), `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, and `CUTOVER_SHA`.
Credentials must be installed directly as encrypted runtime secrets. Never put
values in repository files, chat, command arguments or logs. Partial configuration
fails closed. Before the first copy, the source revision must equal `CUTOVER_SHA`. Completed
migrations consult the destination receipt before requiring old source credentials
or the initial cutover attestation. Later releases retain R2 authority.

Before the single cutover, verify the app is archived with zero instances and no
pending rollout. Preserve source session and crypto bindings. The qualified binary
copies opaque session ciphertext and the writer fence before starting any listener,
sweeper or writer. It preserves exact object paths (required by authenticated
encryption), verifies bytes, and rechecks the source inventory. Source objects are
never deleted or rewritten. Conflicting destination bytes halt migration. Copies
are bounded to 1,000 sessions, 1 MiB/object and 64 MiB total session data. Exceeding
these bounds requires a separately reviewed sizing decision; do not raise them
silently. R2/source migration client transport retries are disabled; interrupted
copies can resume only against identical destination bytes.

The completion receipt is written only after verification. Subsequent starts read
that receipt and never reimport original session records, including records deleted
by logout after cutover. R2 is authoritative thereafter. Failure means stop/archive
and fix forward using the same R2 state, not boot an old Spaces-backed binary.

Provisioning, credential delivery, migration, source-size measurement and live
acceptance have not yet occurred. USD10/month is an authorized planning budget,
not a provider-enforced cap. One instance and bounded retries do not bound repeated
requests or monthly usage. Record private aggregate source counts/bytes and expected
session traffic before provisioning; halt if the estimate exceeds the budget.
Use existing provider usage reporting during acceptance; do not add a new monitor.
Required hosted tests and review must pass before production setup. Acceptance
includes source/destination integrity, activation/commit, session restoration,
durable token/cookie updates and restart without stale-state resurrection.

The release controller runs `scripts/verify-state-cutover.py` before an initial
cutover update. The same read-only gate is mandatory immediately before the
secure credential-install update; its receipt must show archived active spec,
zero instances, no pending rollout and unchanged single-instance capacity.

The automatic release workflow refuses an update until the approved state bucket
binding is present. This lets the protected merge complete without accidentally
launching an additional legacy-backend deployment. The single secure binding update
must apply the qualified merged source and pass the same controller gate; do not
install bindings early or follow that update with a duplicate workflow dispatch.
After migration, same-revision restart requires provider-reported actual source
identity, matching guarded configuration and no additional background components.
