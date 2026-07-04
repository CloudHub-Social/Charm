#!/usr/bin/env bash
# Registers the account + published room alias the src-tauri integration
# tests (tests/verification_flow.rs, tests/alias_resolution.rs) expect.
#
# Credentials come from TEST_MATRIX_USERNAME/TEST_MATRIX_PASSWORD env vars so
# nothing real is hardcoded here — same variables the tests themselves read.
# Defaults below are for local dev convenience only (this homeserver is
# localhost-only); CI sets its own values from GitHub Actions secrets and a
# different CONTAINER_NAME (it runs Synapse via a plain `docker run`, not
# this directory's docker-compose.yml).
set -euo pipefail

HOMESERVER_URL="${HOMESERVER_URL:-http://localhost:8008}"
USERNAME="${TEST_MATRIX_USERNAME:-evie}"
PASSWORD="${TEST_MATRIX_PASSWORD:-testpass123}"
CONTAINER_NAME="${CONTAINER_NAME:-charm-dev-synapse}"

echo "Registering test user '$USERNAME' at $HOMESERVER_URL..."
docker exec "$CONTAINER_NAME" register_new_matrix_user \
  -u "$USERNAME" -p "$PASSWORD" --no-admin \
  -c /data/homeserver.yaml "$HOMESERVER_URL"

TOKEN=$(curl -s -X POST "$HOMESERVER_URL/_matrix/client/v3/login" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"m.login.password\",\"user\":\"$USERNAME\",\"password\":\"$PASSWORD\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

echo "Creating #alias-test-room:localhost (used by tests/alias_resolution.rs)..."
curl -s -X POST "$HOMESERVER_URL/_matrix/client/v3/createRoom" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"alias-test-room","room_alias_name":"alias-test-room","preset":"public_chat"}'
echo
echo "Done."
