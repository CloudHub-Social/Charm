#!/usr/bin/env bash
# Build a disposable, Personal Team-signed iOS/iPadOS Charm install from an
# exact commit. This script intentionally never changes the source checkout.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source_root=$(cd "$script_dir/.." && pwd)
command_name=${1:-}

usage() {
  cat <<'USAGE'
Usage: scripts/personal-ios.sh <prepare|build-install|collect-logs>

Required for prepare/build-install:
  CHARM_APPLE_TEAM_ID    10-character Personal Team identifier
  CHARM_IOS_BUNDLE_ID    unique development bundle identifier
  CHARM_IOS_DEVICE_ID    connected device UUID/UDID
  DEVELOPER_DIR          Xcode 27 developer directory

Optional:
  CHARM_IOS_COMMIT       exact commit to prepare (default: HEAD)
  CHARM_IOS_WORK_DIR     reusable prepared worktree path
  CHARM_NODE_MODULES_DIR compatible existing node_modules directory
  CHARM_IOS_LOG_DIR      evidence output for collect-logs
USAGE
}

fail() {
  printf 'personal-ios: %s\n' "$*" >&2
  exit 1
}

require_env() {
  local name=$1
  [[ -n ${!name:-} ]] || fail "$name is required"
}

validate_xcode() {
  [[ -n ${DEVELOPER_DIR:-} ]] || fail "DEVELOPER_DIR must point to Xcode 27"
  [[ -x "$DEVELOPER_DIR/usr/bin/xcodebuild" ]] || fail "DEVELOPER_DIR is not an Xcode developer directory: $DEVELOPER_DIR"
  local version
  version=$("$DEVELOPER_DIR/usr/bin/xcodebuild" -version | awk '/^Xcode / { version = $2 } END { print version }')
  [[ $version == 27.* ]] || fail "Xcode 27 is required; found ${version:-unknown}"
}

validate_inputs() {
  require_env CHARM_APPLE_TEAM_ID
  require_env CHARM_IOS_BUNDLE_ID
  require_env CHARM_IOS_DEVICE_ID
  validate_xcode
  [[ $CHARM_APPLE_TEAM_ID =~ ^[A-Z0-9]{10}$ ]] || fail "CHARM_APPLE_TEAM_ID must be a 10-character uppercase identifier"
  [[ $CHARM_IOS_BUNDLE_ID =~ ^[A-Za-z0-9.-]+$ ]] || fail "CHARM_IOS_BUNDLE_ID is not a valid bundle identifier"
  [[ $CHARM_IOS_BUNDLE_ID != social.cloudhub.charm ]] || fail "use a unique Personal Team bundle identifier, never the canonical identifier"
}

commit_sha() {
  git -C "$source_root" rev-parse "${CHARM_IOS_COMMIT:-HEAD}^{commit}"
}

find_compatible_node_modules() {
  if [[ -n ${CHARM_NODE_MODULES_DIR:-} ]]; then
    [[ -d $CHARM_NODE_MODULES_DIR ]] || fail "CHARM_NODE_MODULES_DIR does not exist: $CHARM_NODE_MODULES_DIR"
    printf '%s\n' "$(cd "$CHARM_NODE_MODULES_DIR" && pwd -P)"
    return
  fi

  local candidate candidate_lock source_lock
  source_lock=$(shasum -a 256 "$source_root/pnpm-lock.yaml" | awk '{print $1}')
  for candidate in "$source_root"/../Charm*/node_modules; do
    [[ -d $candidate ]] || continue
    candidate_lock=$(dirname "$candidate")/pnpm-lock.yaml
    [[ -f $candidate_lock ]] || continue
    [[ $(shasum -a 256 "$candidate_lock" | awk '{print $1}') == "$source_lock" ]] || continue
    printf '%s\n' "$(cd "$candidate" && pwd -P)"
    return
  done
  fail "no compatible node_modules directory found; set CHARM_NODE_MODULES_DIR or install dependencies outside this script"
}

prepare_worktree() {
  validate_inputs
  local sha short run_root worktree node_modules
  node "$source_root/scripts/check-ios-config.mjs"
  sha=$(commit_sha)
  short=${sha:0:12}
  run_root=${CHARM_IOS_RUN_ROOT:-"${TMPDIR:-/tmp}/charm-personal-ios"}
  worktree=${CHARM_IOS_WORK_DIR:-"$run_root/${short}-$(date -u +%Y%m%dT%H%M%SZ)-$$"}
  [[ ! -e $worktree ]] || fail "refusing to reuse or overwrite existing worktree: $worktree"

  git -C "$source_root" worktree add --detach "$worktree" "$sha"
  node_modules=$(find_compatible_node_modules)
  if [[ ! -e "$worktree/node_modules" ]]; then
    ln -s "$node_modules" "$worktree/node_modules"
  fi
  CHARM_IOS_COMMIT=$sha node "$source_root/scripts/configure-personal-ios.mjs" \
    "$worktree" "$CHARM_APPLE_TEAM_ID" "$CHARM_IOS_BUNDLE_ID"

  printf 'Prepared disposable iOS worktree:\n%s\n' "$worktree"
  printf 'Run evidence will be written inside that disposable worktree.\n'
  PREPARED_WORKTREE=$worktree
}

build_install() {
  validate_inputs
  local worktree sha output_root build_log app_path metadata profile_plist
  if [[ -n ${CHARM_IOS_WORK_DIR:-} ]]; then
    worktree=$CHARM_IOS_WORK_DIR
    [[ -f "$worktree/.charm-personal-ios.json" ]] || fail "CHARM_IOS_WORK_DIR is not a prepared Personal Team worktree"
  else
    prepare_worktree
    worktree=$PREPARED_WORKTREE
  fi

  sha=$(git -C "$worktree" rev-parse HEAD)
  output_root="$worktree/.personal-ios-evidence/${sha:0:12}"
  [[ ! -e "$output_root" ]] || fail "this prepared worktree already has build evidence; prepare a fresh worktree for a clean gate"
  mkdir -p "$output_root"
  build_log="$output_root/build.log"

  export CARGO_TARGET_DIR="$output_root/cargo-target"
  export DEVELOPER_DIR
  rustup target add aarch64-apple-ios
  rustup component add llvm-tools-preview

  (
    cd "$worktree"
    pnpm tauri ios build --target aarch64 --export-method debugging --ci --verbose
  ) 2>&1 | tee "$build_log"

  app_path=$(find "$worktree/src-tauri/gen/apple" -type d -path '*.xcarchive/Products/Applications/*.app' -print -quit)
  [[ -n $app_path ]] || fail "the signed .app was not found in the fresh Xcode archive; see $build_log"

  xcrun devicectl device install app --device "$CHARM_IOS_DEVICE_ID" "$app_path" | tee "$output_root/install.log"
  xcrun devicectl device process launch --device "$CHARM_IOS_DEVICE_ID" --terminate-existing "$CHARM_IOS_BUNDLE_ID" | tee "$output_root/launch.log"

  profile_plist="$output_root/embedded.mobileprovision.plist"
  if [[ -f "$app_path/embedded.mobileprovision" ]]; then
    security cms -D -i "$app_path/embedded.mobileprovision" > "$profile_plist"
  fi
  {
    printf 'commit=%s\n' "$sha"
    "$DEVELOPER_DIR/usr/bin/xcodebuild" -version
    printf 'bundle_id=%s\n' "$CHARM_IOS_BUNDLE_ID"
    printf 'device_id=%s\n' "$CHARM_IOS_DEVICE_ID"
    printf 'app_path=%s\n' "$app_path"
    [[ -f $profile_plist ]] && /usr/libexec/PlistBuddy -c 'Print :ExpirationDate' "$profile_plist" || true
  } > "$output_root/build-metadata.txt"

  printf 'Installed and launched %s from %s\n' "$CHARM_IOS_BUNDLE_ID" "$sha"
  printf 'Evidence: %s\n' "$output_root"
}

collect_logs() {
  validate_xcode
  require_env CHARM_IOS_DEVICE_ID
  local log_root
  log_root=${CHARM_IOS_LOG_DIR:-"${TMPDIR:-/tmp}/charm-personal-ios-logs/$(date -u +%Y%m%dT%H%M%SZ)"}
  mkdir -p "$log_root"
  "$DEVELOPER_DIR/usr/bin/xcodebuild" -version > "$log_root/xcode-version.txt"
  xcrun devicectl list devices --json-output "$log_root/devices.json"
  xcrun devicectl device copy from --device "$CHARM_IOS_DEVICE_ID" \
    --domain-type systemCrashLogs --source . --destination "$log_root/crash-reports" || true
  printf 'Collected available device evidence: %s\n' "$log_root"
}

case "$command_name" in
  prepare) prepare_worktree ;;
  build-install) build_install ;;
  collect-logs) collect_logs ;;
  *) usage; exit 2 ;;
esac
