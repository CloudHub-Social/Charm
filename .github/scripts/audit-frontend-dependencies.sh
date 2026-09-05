#!/usr/bin/env bash

set -euo pipefail

max_attempts=${AUDIT_MAX_ATTEMPTS:-2}
retry_delay_seconds=${AUDIT_RETRY_DELAY_SECONDS:-20}
pnpm_bin=${PNPM_BIN:-pnpm}
attempt=1
audit_log=""

cleanup() {
  if [[ -n "$audit_log" && -f "$audit_log" ]]; then
    rm -f "$audit_log"
  fi
}
trap cleanup EXIT

while (( attempt <= max_attempts )); do
  audit_log=$(mktemp)

  set +e
  "$pnpm_bin" audit --audit-level=high >"$audit_log" 2>&1
  audit_status=$?
  set -e

  cat "$audit_log"

  if (( audit_status == 0 )); then
    exit 0
  fi

  # A real advisory failure must fail immediately. Retry only pnpm/network
  # failures observed from the npm bulk-advisory endpoint in issue #502.
  if ! grep -Eqi \
    'TimeoutError:|operation was aborted due to timeout|ERR_PNPM_(META_FETCH_FAIL|AUDIT_BAD_RESPONSE)|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up' \
    "$audit_log"; then
    exit "$audit_status"
  fi

  if (( attempt == max_attempts )); then
    echo "::error::Frontend dependency audit still could not reach the advisory service after ${max_attempts} attempts"
    exit "$audit_status"
  fi

  echo "::notice::Frontend dependency audit hit a retryable advisory-service/network failure; retrying once in ${retry_delay_seconds}s"
  rm -f "$audit_log"
  audit_log=""
  sleep "$retry_delay_seconds"
  ((attempt += 1))
done
