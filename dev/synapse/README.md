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

### Existing local data

If `./data/homeserver.yaml` predates the `preview-target` service, do not rerun
`configure-homeserver.sh`: it appends the complete local override block and is
intended for a newly generated config. Stop the stack, back up
`./data/homeserver.yaml`, then add the `url_preview_enabled`,
`url_preview_ip_range_blacklist`, and `url_preview_ip_range_whitelist` block
from `configure-homeserver.sh` exactly once. Confirm that
`url_preview_enabled:` appears only once before restarting:

```bash
docker compose down
cp data/homeserver.yaml data/homeserver.yaml.before-url-previews
grep -n '^url_preview_enabled:' data/homeserver.yaml
docker compose up -d
```

An empty `grep` result before editing means the migration is needed; a single
result means it is already applied. Restore the backup if Synapse does not
start cleanly.

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

The same stack starts `preview-target`, a fixed OpenGraph page reachable only on
the Compose network. `configure-homeserver.sh` enables Synapse URL previews with
the recommended private-network blacklist and a single-IP exception for that
container. Specs/tests must use `http://preview-target/`; do not weaken the
blacklist or copy these local-only settings to a public homeserver.

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
