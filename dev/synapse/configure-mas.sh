#!/usr/bin/env sh
# One-time setup for the MAS-delegated homeserver stack (synapse-mas, mas,
# mas-db) used by tests/qr_login.rs — separate from configure-homeserver.sh,
# which sets up the plain `synapse` instance the password/registration/SSO
# tests use.
#
# Run once after `docker compose up -d` has started synapse-mas/mas/mas-db.
#
# Usage: ./configure-mas.sh [synapse-mas-container] [mas-container]
# Defaults match docker-compose.yml locally; CI passes its own container
# names since it starts these via plain `docker run`, not docker-compose.
set -eu

SYNAPSE_CONTAINER="${1:-charm-dev-synapse-mas}"
MAS_CONTAINER="${2:-charm-dev-mas}"

# mas-config.yaml deliberately ships with no `secrets:` section at all (see
# its header comment) — MAS can't start without one, so on every run here we
# generate a fresh encryption key + RSA/EC signing keys and append them,
# the same append-then-restart approach used for synapse-mas's config below.
# `docker cp` works against a container regardless of whether its main
# process is currently running or has already crash-looped on the incomplete
# config, so this is safe to run before MAS ever comes up successfully.
echo "Generating and injecting MAS secrets (encryption key + signing keys)..."
MAS_SECRETS_DIR="$(mktemp -d)"
trap 'rm -rf "$MAS_SECRETS_DIR"' EXIT
openssl genrsa -out "$MAS_SECRETS_DIR/rsa.pem" 2048 2>/dev/null
openssl ecparam -name prime256v1 -genkey -noout -out "$MAS_SECRETS_DIR/ec.pem" 2>/dev/null
{
  echo ""
  echo "secrets:"
  echo "  encryption: $(openssl rand -hex 32)"
  echo "  keys:"
  echo "    - kid: dev-rsa"
  echo "      key: |"
  sed 's/^/        /' "$MAS_SECRETS_DIR/rsa.pem"
  echo "    - kid: dev-ec"
  echo "      key: |"
  sed 's/^/        /' "$MAS_SECRETS_DIR/ec.pem"
} > "$MAS_SECRETS_DIR/secrets-overrides.yaml"
docker cp "$MAS_CONTAINER":/base-config.yaml "$MAS_SECRETS_DIR/config-base.yaml"
cat "$MAS_SECRETS_DIR/config-base.yaml" "$MAS_SECRETS_DIR/secrets-overrides.yaml" > "$MAS_SECRETS_DIR/config-final.yaml"
docker cp "$MAS_SECRETS_DIR/config-final.yaml" "$MAS_CONTAINER":/config.yaml
docker restart "$MAS_CONTAINER" > /dev/null

echo "Waiting for MAS to come up with its generated secrets..."
for _ in $(seq 1 30); do
  if curl -sf http://localhost:8080/.well-known/openid-configuration > /dev/null 2>&1; then
    echo "MAS is up."
    break
  fi
  sleep 1
done

echo "Waiting for synapse-mas's homeserver.yaml to exist..."
for _ in $(seq 1 30); do
  if docker exec "$SYNAPSE_CONTAINER" test -f /data/homeserver.yaml 2>/dev/null; then
    break
  fi
  sleep 1
done

echo "Appending matrix_authentication_service config to synapse-mas..."
cat > /tmp/synapse-mas-overrides.yaml <<'EOF'

# Synapse's default public_baseurl guess is https://<server_name>/ — doesn't
# match this plain-HTTP setup, and Synapse builds absolute URLs from it.
public_baseurl: http://localhost:8010/

# Delegates all auth (password, registration, SSO, QR login) to MAS. This is
# the stable config key (Synapse >= 1.136) — NOT experimental_features.msc3861,
# which is deprecated and removed as of Synapse 1.157.
matrix_authentication_service:
  enabled: true
  endpoint: "http://mas:8080"
  secret: "charm-dev-only-mas-synapse-shared-secret"

# QR login (tests/qr_login.rs) needs Synapse's own MSC4108 rendezvous
# endpoint (POST /_matrix/client/unstable/org.matrix.msc4108/rendezvous) —
# without this, matrix-sdk's login_with_qr_code fails fast with a 404
# ("Unrecognized request") the moment it tries to create a rendezvous
# session, before ever generating a QR code.
experimental_features:
  msc4108_enabled: true
EOF
docker cp /tmp/synapse-mas-overrides.yaml "$SYNAPSE_CONTAINER:/tmp/overrides.yaml"
docker exec "$SYNAPSE_CONTAINER" sh -c "cat /tmp/overrides.yaml >> /data/homeserver.yaml"
docker restart "$SYNAPSE_CONTAINER" > /dev/null

echo "Running MAS database migrations..."
docker exec "$MAS_CONTAINER" mas-cli database migrate --config /config.yaml

echo "Syncing MAS static client config..."
docker exec "$MAS_CONTAINER" mas-cli config sync --config /config.yaml

echo "Waiting for synapse-mas to come back up after restart..."
for _ in $(seq 1 30); do
  if curl -sf http://localhost:8010/_matrix/client/versions > /dev/null 2>&1; then
    echo "synapse-mas is up."
    break
  fi
  sleep 2
done

echo "Registering MAS test user 'qr-test' / 'testpass123'..."
docker exec "$MAS_CONTAINER" mas-cli manage register-user \
  qr-test --password testpass123 --yes --ignore-password-complexity \
  --config /config.yaml || echo "(already registered, continuing)"
