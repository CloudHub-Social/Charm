#!/usr/bin/env bash
# Keep resource evidence in the job log even if the job-level timeout prevents
# artifact upload. Never print process arguments or environment variables.
set -euo pipefail

phase=$1
shift
case "$phase" in
  simulator|archive) ;;
  *) echo 'Expected simulator or archive phase' >&2; exit 2 ;;
esac

mkdir -p .artifacts/ios/diagnostics
resource_log=".artifacts/ios/diagnostics/$phase-resources.log"

sample_resources() {
  while true; do
    if ! {
      echo "ios-resource-sample phase=$phase utc=$(date -u +%FT%TZ)"
      # comm contains the executable name, never argv (which can contain keys).
      ps -axo pid=,ppid=,state=,etime=,time=,%cpu=,rss=,comm= \
        | awk '/rustc|cargo|clang|swift|xcode|XCBBuild|ld$|node|tauri|Simulator|simulator|Charm/ { print }' \
        | sort -k6,6nr | awk 'NR <= 40' || echo 'diagnostic-warning: process sample failed'
      vm_stat || echo 'diagnostic-warning: memory sample failed'
      sysctl vm.swapusage || echo 'diagnostic-warning: swap sample failed'
      df -k . || echo 'diagnostic-warning: disk sample failed'
    } >> "$resource_log" 2>&1; then
      echo '::warning::iOS resource log could not be written; stopping sampler'
      return
    fi
    # Also stream each sample: hard job cancellation may skip artifact steps.
    tail -n 80 "$resource_log" || echo '::warning::iOS resource log could not be read'
    sleep 60
  done
}

sample_resources &
sampler_pid=$!
cleanup() {
  kill "$sampler_pid" 2>/dev/null || true
  wait "$sampler_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "ios-build-start phase=$phase utc=$(date -u +%FT%TZ)"
# Preserve the build's nonzero exit status; diagnostics must never pass a failed
# build. Tauri verbosity exposes native compiler progress in the hosted job log.
"$@"
echo "ios-build-finish phase=$phase utc=$(date -u +%FT%TZ)"
