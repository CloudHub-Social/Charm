#!/usr/bin/env bash
set -euo pipefail

if [ -z "${GITHUB_ENV:-}" ]; then
  GITHUB_ENV="$(mktemp)"
  trap 'cat "$GITHUB_ENV"; rm -f "$GITHUB_ENV"' EXIT
fi

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

# The canonical build id (Spec 24) is computed once, in
# scripts/compute-build-id.mjs, and reused here as the Sentry release name —
# the "unify VITE_BUILD_ID with SENTRY_RELEASE" option from that spec's open
# question, so a build's Sentry release and its in-app "Build" row always
# show the same string. RELEASE_INPUT (the workflow_dispatch `release` input
# on sentry-release-artifacts.yml) still overrides this outright, so a manual
# dispatch can name an arbitrary Sentry release.
release="${RELEASE_INPUT:-}"
if [ -z "$release" ]; then
  release=$(SHA="${BUILD_ID_SHA:-$GITHUB_SHA}" BUILD_KIND="${BUILD_ID_KIND:-}" PR_NUMBER="${BUILD_ID_PR_NUMBER:-}" node "$(dirname "${BASH_SOURCE[0]}")/../../scripts/compute-build-id.mjs")
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
    printf 'VITE_BUILD_ID=%s\n' "$release"
    printf 'SENTRY_ENVIRONMENT=%s\n' "$environment"
    printf 'VITE_SENTRY_ENVIRONMENT=%s\n' "$environment"
  } >> "$GITHUB_ENV"
fi

if [ "${WRITE_RUST_DEBUG_ENV:-false}" = "true" ]; then
  {
    printf 'CARGO_PROFILE_RELEASE_DEBUG=1\n'
    # Baked into the Rust binary at compile time via option_env!("BUILD_ID")
    # in src-tauri/src/lib.rs, mirroring how sentry::release_name!() already
    # captures CARGO_PKG_VERSION at compile time — see that file for why a
    # runtime env var alone isn't enough (an installed app's launch
    # environment won't have this set).
    printf 'BUILD_ID=%s\n' "$release"
    # Native release/debug-file jobs (e.g. apple-debug-files) run Tauri's
    # own frontend build via beforeBuildCommand, bundling the JS AboutPanel
    # straight into the native app — that build needs VITE_BUILD_ID too, not
    # just the Rust-side BUILD_ID above, or it falls back to the bare
    # package version even though this job doesn't set
    # WRITE_FRONTEND_UPLOAD_ENV (that flag is for the separate web/desktop
    # sourcemap-upload job, which is a different frontend build entirely).
    printf 'VITE_BUILD_ID=%s\n' "$release"
  } >> "$GITHUB_ENV"
fi
