#!/usr/bin/env bash
set -euo pipefail

missing=()
required=(SENTRY_AUTH_TOKEN SENTRY_ORG SENTRY_PROJECT)
if [ "${REQUIRE_VITE_SENTRY_DSN:-false}" = "true" ]; then
  required+=(VITE_SENTRY_DSN)
fi

for name in "${required[@]}"; do
  if [ -z "${!name:-}" ]; then
    missing+=("$name")
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  printf '::error::Missing required Sentry secret(s): %s\n' "${missing[*]}"
  exit 1
fi

release="${RELEASE_INPUT:-}"
if [ -z "$release" ]; then
  if [ "${GITHUB_REF_TYPE:-}" = "tag" ]; then
    release="${GITHUB_REF_NAME}"
  else
    release="${GITHUB_SHA}"
  fi
fi

if [[ "$release" == *$'\n'* || "$release" == *$'\r'* ]]; then
  echo "::error::Sentry release names must be single-line values"
  exit 1
fi

{
  printf 'SENTRY_RELEASE=%s\n' "$release"
} >> "$GITHUB_ENV"

if [ "${WRITE_FRONTEND_UPLOAD_ENV:-false}" = "true" ]; then
  environment="${ENVIRONMENT_INPUT:-}"
  if [ -z "$environment" ]; then
    environment="production"
  fi

  if [[ "$environment" == *$'\n'* || "$environment" == *$'\r'* ]]; then
    echo "::error::Sentry environment names must be single-line values"
    exit 1
  fi

  {
    printf 'SENTRY_UPLOAD=true\n'
    printf 'VITE_SENTRY_RELEASE=%s\n' "$release"
    printf 'SENTRY_ENVIRONMENT=%s\n' "$environment"
    printf 'VITE_SENTRY_ENVIRONMENT=%s\n' "$environment"
  } >> "$GITHUB_ENV"
fi

if [ "${WRITE_RUST_DEBUG_ENV:-false}" = "true" ]; then
  {
    printf 'CARGO_PROFILE_RELEASE_DEBUG=1\n'
  } >> "$GITHUB_ENV"
fi
