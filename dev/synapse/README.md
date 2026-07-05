# Local dev homeserver

Synapse via Docker Compose, for developing against a real Matrix server without
touching a production/shared homeserver.

## First run (generates config + signing keys into `./data`)

```bash
docker compose run --rm -e SYNAPSE_SERVER_NAME=localhost -e SYNAPSE_REPORT_STATS=no synapse generate
./configure-homeserver.sh
```

`configure-homeserver.sh` appends open registration, generous rate limits, and
an OIDC provider (pointed at the `dex` service below) to the generated
`homeserver.yaml` — see the script for details on why each is needed.

## Start

```bash
docker compose up -d
```

This also starts `dex`, a local-only OIDC identity provider used to test SSO
login (`src-tauri/tests/sso_login.rs`). It has one hardcoded test account —
username `sso-test@localhost`, password `testpass123` — via Dex's
"staticPasswords" connector; there's no real upstream identity provider
involved, so it works offline and in CI without a human clicking through a
real consent screen.

Homeserver is then reachable at `http://localhost:8008` — matches the default
`homeserver_url` in the app's Phase 0 login screen.

## Register a test user

```bash
# Registers TEST_MATRIX_USERNAME/TEST_MATRIX_PASSWORD (defaults: evie/testpass123)
# and publishes #alias-test-room:localhost — everything src-tauri's integration
# tests (verification_flow.rs, alias_resolution.rs) expect.
./register-test-user.sh
```

`tests/persistence_isolation.rs` and `tests/ephemeral.rs` also need a second,
distinct account (`TEST_MATRIX_USERNAME_2`/`TEST_MATRIX_PASSWORD_2`, defaults
`evie2`/`testpass123`) — register it directly (it doesn't need the
`#alias-test-room` side effect, so skip the full script):

```bash
docker exec charm-dev-synapse register_new_matrix_user \
  -u evie2 -p testpass123 --no-admin \
  -c /data/homeserver.yaml http://localhost:8008
```

## Stop

```bash
docker compose down
```

`./data` is gitignored — it holds the generated homeserver config, signing keys,
and the SQLite database for this dev server; never commit it.

## QR login (MSC4108) — separate MAS-delegated stack

QR login needs a homeserver with auth delegated to Matrix Authentication
Service — plain password/registration/SSO don't support it. `synapse-mas`,
`mas`, and `mas-db` are a second, separate stack (own port, own data dir) for
this, kept apart from the `synapse`/`dex` stack above so nothing here can
regress the already-working password/SSO tests.

```bash
# First run (generates synapse-mas's config + signing keys into ./data-mas)
docker compose run --rm -e SYNAPSE_SERVER_NAME=localhost -e SYNAPSE_REPORT_STATS=no synapse-mas generate

docker compose up -d synapse-mas mas mas-db
./configure-mas.sh
```

`configure-mas.sh` generates and injects MAS's signing keys (not checked into
the repo — see `mas-config.yaml`'s header comment), delegates synapse-mas's
auth to MAS, and enables the MSC4108 rendezvous endpoint QR login needs.
synapse-mas is then reachable at `http://localhost:8010` — matches
`tests/qr_login.rs`'s `HOMESERVER` constant.

`./data-mas` is gitignored, same as `./data` above.
