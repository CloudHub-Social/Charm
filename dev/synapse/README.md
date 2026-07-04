# Local dev homeserver

Synapse via Docker Compose, for developing against a real Matrix server without
touching a production/shared homeserver.

## First run (generates config + signing keys into `./data`)

```bash
docker compose run --rm -e SYNAPSE_SERVER_NAME=localhost -e SYNAPSE_REPORT_STATS=no synapse generate
```

## Start

```bash
docker compose up -d
```

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
