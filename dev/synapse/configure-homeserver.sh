#!/usr/bin/env sh
# Appends local-dev/CI-only overrides to the generated homeserver.yaml:
# open registration (needed by tests/discovery_and_registration.rs),
# generous rate limits (avoids flakiness across repeated manual test runs),
# and an OIDC provider pointed at a Dex instance reachable at the "dex"
# hostname (needed by tests/sso_login.rs — see docker-compose.yml locally,
# or quality-checks.yml's "Start Dex" step in CI).
#
# Run once after the homeserver.yaml config file has been generated
# (`docker compose run --rm synapse generate` locally) and before starting
# Synapse.
#
# Usage: ./configure-homeserver.sh [path-to-homeserver.yaml]
# Defaults to ./data/homeserver.yaml (this script's local dev layout); CI
# passes an explicit path into its own Synapse data volume instead.
set -eu

TARGET="${1:-$(dirname "$0")/data/homeserver.yaml}"

cat >> "$TARGET" <<'EOF'

# Synapse's default public_baseurl guess is https://<server_name>/, which
# doesn't match our plain-HTTP localhost:8008 setup and breaks SSO redirects
# (Synapse builds absolute URLs, including the OIDC callback, from this).
public_baseurl: http://localhost:8008/

enable_registration: true
enable_registration_without_verification: true
rc_login:
  address:
    per_second: 1000
    burst_count: 1000
  account:
    per_second: 1000
    burst_count: 1000
  failed_attempts:
    per_second: 1000
    burst_count: 1000
rc_message:
  per_second: 1000
  burst_count: 1000

# Enable the local-only URL-preview integration target used by Spec 29.
# Keep the recommended private-network blacklist in place and punch one
# exact exception for the fixed `preview-target` container address. This
# configuration is never appropriate for a public homeserver.
url_preview_enabled: true
url_preview_ip_range_blacklist:
  - 127.0.0.0/8
  - 10.0.0.0/8
  - 172.16.0.0/12
  - 192.168.0.0/16
  - 100.64.0.0/10
  - 169.254.0.0/16
  - ::1/128
  - fe80::/10
  - fc00::/7
url_preview_ip_range_whitelist:
  - 172.28.0.10/32

oidc_providers:
  - idp_id: dex
    idp_name: "Dex (local dev)"
    issuer: "http://localhost:5556/dex"
    client_id: "charm-synapse"
    client_secret: "charm-dev-only-secret"
    discover: false
    # Synapse otherwise refuses non-HTTPS token/userinfo/jwks endpoints —
    # fine for a real deployment, not for this local-only Dex instance.
    skip_verification: true
    authorization_endpoint: "http://localhost:5556/dex/auth"
    # Synapse-side backend calls use the dex container's network hostname
    # rather than the host-published port the browser/issuer use above.
    token_endpoint: "http://dex:5556/dex/token"
    userinfo_endpoint: "http://dex:5556/dex/userinfo"
    jwks_uri: "http://dex:5556/dex/keys"
    scopes: ["openid", "profile", "email"]
    user_mapping_provider:
      config:
        # Dex's local-password connector doesn't populate
        # "preferred_username" by default; the email claim reliably does.
        localpart_template: "{{ user.email.split('@')[0] }}"
        display_name_template: "{{ user.name }}"
EOF

echo "Appended local-dev/CI overrides to $TARGET."
