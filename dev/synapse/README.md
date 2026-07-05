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

## Stop

```bash
docker compose down
```

`./data` is gitignored — it holds the generated homeserver config, signing keys,
and the SQLite database for this dev server; never commit it.
