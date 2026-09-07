#!/usr/bin/env bash
# Build a disposable, Personal Team-signed iOS/iPadOS Charm install from an
# exact commit. This script intentionally never changes the source checkout.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source_root=$(cd "$script_dir/.." && pwd)
command_name=${1:-}

# Personal Team values belong in this ignored file, never in the repository.
# Its `:=` assignments make command-line environment values win over the
# convenience defaults kept on one developer machine.
local_config=${CHARM_IOS_LOCAL_CONFIG:-"$script_dir/personal-ios.env.local"}
if [[ -f $local_config ]]; then
  # shellcheck source=/dev/null
  source "$local_config"
fi

# A local config file assigns shell variables; make the build-mode override
# available to the nested pnpm process as well.
if [[ -n ${VITE_SENTRY_ENVIRONMENT:-} ]]; then
  export VITE_SENTRY_ENVIRONMENT
fi

usage() {
  cat <<'USAGE'
Usage: scripts/personal-ios.sh <prepare|build-install|collect-logs>

Required for prepare/build-install:
  CHARM_APPLE_TEAM_ID    10-character Personal Team identifier
  CHARM_IOS_BUNDLE_ID    unique development bundle identifier
  DEVELOPER_DIR          Xcode 27 developer directory

Optional:
  CHARM_IOS_DEVICE_ID    install only on this connected physical device;
                         otherwise install on every connected physical device
  CHARM_IOS_COMMIT       exact commit to prepare (default: HEAD)
  CHARM_IOS_WORK_DIR     reusable prepared worktree path
  CHARM_NODE_MODULES_DIR compatible existing node_modules directory
  CHARM_IOS_LOG_DIR      evidence output for collect-logs
  VITE_SENTRY_ENVIRONMENT build environment (local defaults use development)
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
  validate_xcode
  [[ $CHARM_APPLE_TEAM_ID =~ ^[A-Z0-9]{10}$ ]] || fail "CHARM_APPLE_TEAM_ID must be a 10-character uppercase identifier"
  [[ $CHARM_IOS_BUNDLE_ID =~ ^[A-Za-z0-9.-]+$ ]] || fail "CHARM_IOS_BUNDLE_ID is not a valid bundle identifier"
  [[ $CHARM_IOS_BUNDLE_ID != social.cloudhub.charm ]] || fail "use a unique Personal Team bundle identifier, never the canonical identifier"
}

install_device_ids=()
install_device_udids=()

resolve_install_devices() {
  install_device_ids=()
  install_device_udids=()

  local devices_json
  devices_json=$(mktemp -t charm-personal-ios-devices.XXXXXX.json)
  if ! DEVELOPER_DIR="$DEVELOPER_DIR" /usr/bin/xcrun devicectl list devices --json-output "$devices_json" >/dev/null 2>&1; then
    unlink "$devices_json"
    fail "could not list connected Apple devices"
  fi

  while IFS=$'\t' read -r device_id device_udid; do
    [[ -n $device_id && -n $device_udid ]] || continue
    install_device_ids+=("$device_id")
    install_device_udids+=("$device_udid")
  done < <(
    node -e '
      const fs = require("node:fs");
      const devices = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).result?.devices ?? [];
      const selectedDevice = process.argv[2];
      for (const device of devices) {
        const properties = device.properties ?? {};
        const udid = properties.hardware?.udid;
        if (
          properties.connection?.state === "connected" &&
          properties.hardware?.reality === "physical" &&
          typeof device.identifier === "string" &&
          typeof udid === "string" &&
          (!selectedDevice || selectedDevice === device.identifier || selectedDevice === udid)
        ) {
          console.log(`${device.identifier}\t${udid}`);
        }
      }
    ' "$devices_json" "${CHARM_IOS_DEVICE_ID:-}"
  )
  unlink "$devices_json"

  ((${#install_device_ids[@]} > 0)) || fail "no connected physical iPhone or iPad was found"
}

provision_install_devices() {
  local worktree=$1 output_root=$2 index device_id device_udid device_root
  for ((index = 0; index < ${#install_device_ids[@]}; index++)); do
    device_id=${install_device_ids[index]}
    device_udid=${install_device_udids[index]}
    device_root="$output_root/devices/$device_id"
    mkdir -p "$device_root"
    # Match `tauri ios build --ci`: Tauri's Xcode phase invokes pnpm, which
    # otherwise refuses its non-interactive dependency safety check.
    # The generated Xcode project names configurations `debug` and `release`.
    # `Release` is invalid and silently falls back to the dev-server path.
    CI=true "$DEVELOPER_DIR/usr/bin/xcodebuild" \
      -project "$worktree/src-tauri/gen/apple/charm.xcodeproj" \
      -scheme charm_iOS \
      -configuration release \
      -destination "id=$device_udid" \
      -allowProvisioningUpdates \
      -allowProvisioningDeviceRegistration \
      build 2>&1 | tee "$device_root/provision.log"
  done
}

verify_profile_devices() {
  local app_path=$1 output_root=$2 profile_plist profile_devices missing_udids
  profile_plist="$output_root/embedded.mobileprovision.plist"
  profile_devices="$output_root/provisioned-devices.json"
  [[ -f "$app_path/embedded.mobileprovision" ]] || fail "the signed app has no embedded provisioning profile"
  security cms -D -i "$app_path/embedded.mobileprovision" > "$profile_plist"
  /usr/bin/plutil -extract ProvisionedDevices json -o "$profile_devices" "$profile_plist" \
    || fail "the embedded provisioning profile has no registered-device list"
  missing_udids=$(node -e '
    const fs = require("node:fs");
    const provisioned = new Set(JSON.parse(fs.readFileSync(process.argv[1], "utf8")));
    for (const udid of process.argv.slice(2)) {
      if (!provisioned.has(udid)) console.log(udid);
    }
  ' "$profile_devices" "${install_device_udids[@]}")
  [[ -z $missing_udids ]] || fail "the signed provisioning profile does not include selected device UDID(s): $missing_udids; see the device provisioning logs under $output_root/devices"
}

commit_sha() {
  git -C "$source_root" rev-parse "${CHARM_IOS_COMMIT:-HEAD}^{commit}"
}

find_compatible_node_modules() {
  local selected_root=$1
  local candidate candidate_lock source_lock
  source_lock=$(shasum -a 256 "$selected_root/pnpm-lock.yaml" | awk '{print $1}')
  if [[ -n ${CHARM_NODE_MODULES_DIR:-} ]]; then
    [[ -d $CHARM_NODE_MODULES_DIR ]] || fail "CHARM_NODE_MODULES_DIR does not exist: $CHARM_NODE_MODULES_DIR"
    candidate_lock=$(dirname "$CHARM_NODE_MODULES_DIR")/pnpm-lock.yaml
    [[ -f $candidate_lock ]] || fail "CHARM_NODE_MODULES_DIR must belong to a checkout with pnpm-lock.yaml"
    [[ $(shasum -a 256 "$candidate_lock" | awk '{print $1}') == "$source_lock" ]] || fail "CHARM_NODE_MODULES_DIR does not match the selected commit's pnpm-lock.yaml"
    printf '%s\n' "$(cd "$CHARM_NODE_MODULES_DIR" && pwd -P)"
    return
  fi

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
  sha=$(commit_sha)
  short=${sha:0:12}
  run_root=${CHARM_IOS_RUN_ROOT:-"${TMPDIR:-/tmp}/charm-personal-ios"}
  worktree=${CHARM_IOS_WORK_DIR:-"$run_root/${short}-$(date -u +%Y%m%dT%H%M%SZ)-$$"}
  [[ ! -e $worktree ]] || fail "refusing to reuse or overwrite existing worktree: $worktree"

  git -C "$source_root" worktree add --detach "$worktree" "$sha"
  node "$worktree/scripts/check-ios-config.mjs"
  node_modules=$(find_compatible_node_modules "$worktree")
  if [[ ! -e "$worktree/node_modules" ]]; then
    ln -s "$node_modules" "$worktree/node_modules"
  fi
  CHARM_IOS_COMMIT=$sha node "$worktree/scripts/configure-personal-ios.mjs" \
    "$worktree" "$CHARM_APPLE_TEAM_ID" "$CHARM_IOS_BUNDLE_ID"

  printf 'Prepared disposable iOS worktree:\n%s\n' "$worktree"
  printf 'Run evidence will be written inside that disposable worktree.\n'
  PREPARED_WORKTREE=$worktree
}

validate_prepared_worktree() {
  local worktree=$1 marker expected_sha actual_sha recorded_team recorded_bundle recorded_commit
  marker=$worktree/.charm-personal-ios.json
  expected_sha=$(commit_sha)
  actual_sha=$(git -C "$worktree" rev-parse HEAD) || fail "CHARM_IOS_WORK_DIR is not a Git worktree: $worktree"
  IFS=$'\t' read -r recorded_team recorded_bundle recorded_commit < <(
    node -e '
      const fs = require("node:fs");
      const marker = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (![marker.teamId, marker.bundleId, marker.commit].every((value) => typeof value === "string")) process.exit(1);
      process.stdout.write(`${marker.teamId}\t${marker.bundleId}\t${marker.commit}\n`);
    ' "$marker"
  ) || fail "CHARM_IOS_WORK_DIR has invalid Personal Team metadata"
  [[ $recorded_team == "$CHARM_APPLE_TEAM_ID" ]] || fail "CHARM_IOS_WORK_DIR was prepared for a different Apple Team"
  [[ $recorded_bundle == "$CHARM_IOS_BUNDLE_ID" ]] || fail "CHARM_IOS_WORK_DIR was prepared for a different bundle identifier"
  [[ $recorded_commit == "$actual_sha" ]] || fail "CHARM_IOS_WORK_DIR metadata does not match its checked-out commit"
  [[ $recorded_commit == "$expected_sha" ]] || fail "CHARM_IOS_WORK_DIR was prepared for a different selected commit"
}

build_install() {
  validate_inputs
  local worktree sha output_root build_log app_path profile_plist index device_id device_root
  if [[ -n ${CHARM_IOS_WORK_DIR:-} ]]; then
    worktree=$CHARM_IOS_WORK_DIR
    [[ -f "$worktree/.charm-personal-ios.json" ]] || fail "CHARM_IOS_WORK_DIR is not a prepared Personal Team worktree"
    validate_prepared_worktree "$worktree"
  else
    prepare_worktree
    worktree=$PREPARED_WORKTREE
  fi

  sha=$(git -C "$worktree" rev-parse HEAD)
  resolve_install_devices
  output_root="$worktree/.personal-ios-evidence/${sha:0:12}"
  [[ ! -e "$output_root" ]] || fail "this prepared worktree already has build evidence; prepare a fresh worktree for a clean gate"
  mkdir -p "$output_root"
  build_log="$output_root/build.log"

  export CARGO_TARGET_DIR="$output_root/cargo-target"
  export DEVELOPER_DIR
  export PATH="$worktree/scripts/xcode27-swiftrs-tools:$PATH"
  rustup target add aarch64-apple-ios
  rustup component add llvm-tools-preview
  provision_install_devices "$worktree" "$output_root"

  (
    cd "$worktree"
    pnpm tauri ios build --target aarch64 --export-method debugging --ci --verbose
  ) 2>&1 | tee "$build_log"

  app_path=$(find "$worktree/src-tauri/gen/apple" -type d -path '*.xcarchive/Products/Applications/*.app' -print -quit)
  [[ -n $app_path ]] || fail "the signed .app was not found in the fresh Xcode archive; see $build_log"

  verify_profile_devices "$app_path" "$output_root"
  for ((index = 0; index < ${#install_device_ids[@]}; index++)); do
    device_id=${install_device_ids[index]}
    device_root="$output_root/devices/$device_id"
    xcrun devicectl device install app --device "$device_id" "$app_path" | tee "$device_root/install.log"
    xcrun devicectl device process launch --device "$device_id" --terminate-existing "$CHARM_IOS_BUNDLE_ID" | tee "$device_root/launch.log"
  done

  profile_plist="$output_root/embedded.mobileprovision.plist"
  {
    printf 'commit=%s\n' "$sha"
    "$DEVELOPER_DIR/usr/bin/xcodebuild" -version
    printf 'bundle_id=%s\n' "$CHARM_IOS_BUNDLE_ID"
    printf 'device_ids=%s\n' "${install_device_ids[*]}"
    printf 'app_path=%s\n' "$app_path"
    [[ -f $profile_plist ]] && /usr/libexec/PlistBuddy -c 'Print :ExpirationDate' "$profile_plist" || true
  } > "$output_root/build-metadata.txt"

  printf 'Installed and launched %s from %s on %s\n' "$CHARM_IOS_BUNDLE_ID" "$sha" "${install_device_ids[*]}"
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
