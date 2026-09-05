#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
test_root=$(mktemp -d)
fake_pnpm="$test_root/pnpm"
count_file="$test_root/count"

cleanup() {
  rm -f "$fake_pnpm" "$count_file"
  rmdir "$test_root"
}
trap cleanup EXIT

cat >"$fake_pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

count=0
if [[ -f "$FAKE_AUDIT_COUNT_FILE" ]]; then
  count=$(<"$FAKE_AUDIT_COUNT_FILE")
fi
count=$((count + 1))
printf '%s' "$count" >"$FAKE_AUDIT_COUNT_FILE"

case "$FAKE_AUDIT_MODE" in
  advisory)
    echo 'high severity advisory found'
    exit 1
    ;;
  retry-then-pass)
    if (( count == 1 )); then
      echo 'TimeoutError: The operation was aborted due to timeout'
      exit 1
    fi
    echo 'No known vulnerabilities found'
    ;;
  network-failure)
    echo 'ERR_PNPM_META_FETCH_FAIL GET https://registry.npmjs.org'
    exit 1
    ;;
  *)
    echo "unexpected fake mode: $FAKE_AUDIT_MODE" >&2
    exit 2
    ;;
esac
EOF
chmod +x "$fake_pnpm"

run_wrapper() {
  PNPM_BIN="$fake_pnpm" \
    AUDIT_MAX_ATTEMPTS=2 \
    AUDIT_RETRY_DELAY_SECONDS=0 \
    FAKE_AUDIT_COUNT_FILE="$count_file" \
    FAKE_AUDIT_MODE="$1" \
    bash "$script_dir/audit-frontend-dependencies.sh"
}

printf '0' >"$count_file"
if run_wrapper advisory; then
  echo 'advisory failure unexpectedly passed' >&2
  exit 1
fi
[[ $(<"$count_file") == 1 ]]

printf '0' >"$count_file"
run_wrapper retry-then-pass
[[ $(<"$count_file") == 2 ]]

printf '0' >"$count_file"
if run_wrapper network-failure; then
  echo 'repeated network failure unexpectedly passed' >&2
  exit 1
fi
[[ $(<"$count_file") == 2 ]]
