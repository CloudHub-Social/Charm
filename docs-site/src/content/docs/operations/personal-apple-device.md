---
title: Personal iPad and iPhone installation
description: Build, install, verify, and re-sign a personal Charm daily-driver with Xcode Personal Team signing.
---

This runbook produces a personal daily-driver build without waiting for paid Apple
Developer Program enrollment. A free Apple Account and Xcode Personal Team can
install Charm directly on an iPad or iPhone. Paid membership is required for APNs,
TestFlight, and App Store distribution, but is not a prerequisite for this lane.

## Release boundary

| Capability | Personal Team daily-driver | Paid-program follow-up |
| --- | --- | --- |
| Install and launch on an owned iPad or iPhone | Supported | Supported |
| Login, sync, encryption, messaging, media, and foreground lifecycle | Supported after the checks below | Supported |
| Provisioning lifetime | Rebuild and reinstall after the approximately 7-day profile period | Distribution profile dependent |
| Remote killed-state push | Unavailable; document this honestly in the app and release record | Requires APNs credential, push-enabled profile, gateway, extension, and device proof |
| TestFlight or App Store | Unavailable | Requires paid membership and distribution signing |

Do not describe the paid-program row as a blocker for a Personal Team build.

## AltStore and SideStore nightly lane

The rolling CI source is for personal-device testing without putting an Apple
certificate, provisioning profile, or Apple Account credential in GitHub:

`https://github.com/CloudHub-Social/Charm/releases/download/ios-nightly/altstore-source.json`

Add that URL in AltStore or SideStore, then install the current Charm build. The IPA
is built for arm64 and is intentionally unsigned by Charm; AltStore or SideStore
re-signs it with the device owner's Personal Team. The source retains the current
build and two earlier builds for rollback. Its build number increases with the CI
run, while the displayed version tracks the repository version.

This is a separate testing channel, not TestFlight or App Store distribution. It
removes APNs, App Group, and remote-notification capabilities in the CI-only build
overlay because a free Personal Team cannot provision them reliably. Camera and
microphone prompts remain available. Foreground-resume sync, normal UI testing, and
local notifications are in scope; remote delivery while Charm is backgrounded or
killed is not.

Before trusting a build, compare its attached `.ipa.sha256` file with
`shasum -a 256 -c <filename>.ipa.sha256`, inspect the attached SPDX SBOM and GitHub
provenance attestation, and record the source SHA and workflow URL from the release
notes. Refresh before the Personal Team profile expires (normally about seven days)
and install an earlier retained build over the same app for rollback; do not clear
the Matrix store as a rollback technique.

## Select and prepare the source

1. Select an exact `origin/main` commit whose required GitHub Actions checks pass.
   Record the full SHA; simulator CI is repository evidence, not physical-device proof.
2. Use the repeatable, disposable installer from the exact selected commit. It
   creates a detached worktree, reuses only a lockfile-compatible `node_modules`,
   applies the Personal Team signing overlay outside Git, creates fresh build outputs,
   and installs the Release app with `devicectl`:

   ```sh
   CHARM_APPLE_TEAM_ID='<personal-team-id>' \
   CHARM_IOS_BUNDLE_ID='social.cloudhub.charm.personal.device' \
   CHARM_IOS_DEVICE_ID='<connected-device-uuid>' \
   DEVELOPER_DIR='/Applications/Xcode-beta.app/Contents/Developer' \
   scripts/personal-ios.sh build-install
   ```

   The command refuses a non-Xcode-27 toolchain, a canonical bundle identifier,
   stale output, or a missing compatible dependency tree. It does not write any
   identifier, profile, certificate, or entitlement downgrade into the repository.
   `prepare` and `collect-logs` are available as separate commands when evidence is
   needed after a failure.
3. Ensure Xcode is signed in with the device owner's Apple Account and the required
   Rust iOS targets and LLVM tools are installed. The installer runs these two
   `rustup` commands before building:

   ```sh
   rustup target add aarch64-apple-ios
   rustup component add llvm-tools-preview
   ```

   `swift-rs` uses `llvm-objcopy` from that component to export the Swift
   `@_cdecl` bridge functions. On a clean machine or cloud runner, omitting it can
   compile every dependency and then fail the final arm64 link with undefined
   `_register_plugin`, `_init_plugin_*`, or related symbols. Charm's iOS nightly
   and release workflows install the component explicitly.
4. The installer invokes `pnpm tauri ios build` in Release mode, which generates the
   standalone frontend bundle and the untracked assets consumed by Xcode. Do not use
   `pnpm tauri ios dev --open` for a daily-driver install because that path can depend
   on the development server. Xcode 27 also requires the generated app manifest to
   declare `TaoSceneDelegate`; without it, iPadOS terminates the app during launch in
   `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`. Charm tracks that
   declaration in both `project.yml` and `Info.plist` so regeneration preserves it.
5. If Xcode asks for renewed Apple-account authentication, complete that one UI step
   and rerun the same command. Otherwise no Xcode UI interaction is required.

## Manual Xcode fallback

The `build-install` command applies this disposable Personal Team signing overlay
automatically. Use these Xcode steps only when Xcode asks for account
authentication or automatic provisioning cannot complete from the command line;
do not make a second, differently configured install after the CLI path succeeds.

1. Select the `charm_iOS` target and the connected iPad as the run destination.
2. Enable automatic signing and choose the owner's Personal Team.
3. If the canonical identifier is unavailable to the Personal Team, use a unique,
   development-only identifier such as `social.cloudhub.charm.personal.device` in
   the disposable project. Never commit it over Charm's canonical identifier.
4. Personal Team profiles cannot sign the current APNs and App Group capabilities.
   If signing fails, remove `aps-environment` and
   `com.apple.security.application-groups` only from the disposable Xcode project.
   Do not commit that downgrade.
5. On iOS/iPadOS 16 or later, enable **Settings → Privacy & Security → Developer
   Mode**, restart the device when prompted, and confirm Developer Mode after the
   restart. If the setting is not visible yet, reconnect the unlocked device to Xcode
   and attempt **Run** once so iOS offers it, then complete the restart flow.
6. Unlock the device, press **Run** in Xcode, and accept the device's developer trust
   prompt if one appears.

Record the source SHA, Xcode version, device model and OS, development bundle
identifier, profile expiry, and enabled feature flags after installation.

## Cloud build evidence

The `iOS release evidence` workflow is a separate proof lane, not a distribution
mechanism. On iOS-, Tauri-, Cargo-, authentication-, or persistence-affecting
changes it selects Xcode 27, builds a release simulator app, installs and opens it,
delivers `charm://sso-callback`, and verifies that the process remains alive. It also
creates an unsigned arm64 device archive. The nightly workflow independently builds
and validates the distributable arm64 sideload IPA, then publishes it only through
the `ios-nightly` prerelease after its checksum, SBOM, and provenance are available.

The workflow retains these private CI artifacts for the exact commit:

- `charm-ios-simulator-release`;
- `charm-ios-device-unsigned-xcarchive`;
- `charm-ios-debug-symbols`;
- `charm-ios-build-metadata`, including the Xcode version, SPDX SBOM, checksums, and
  artifact-size report.

An unsigned device archive cannot be installed on an iPad. Never put Personal Team
profiles, certificates, or Apple credentials into GitHub merely to make that artifact
installable. The Personal Team command above remains the physical-device lane.

## Personal Matrix account safety gate

Before first login, keep a second verified Matrix client available and confirm an
independently stored recovery key or equivalent recovery route. Do not delete,
reset, or replace existing Matrix sessions to make the new installation work.

After login, verify the new iPad device from the trusted client and record its Matrix
device ID. Stop and return to the trusted client if Charm loses the session, cannot
decrypt newly received events, or appears to replace rather than add a device.

## Acceptance matrix

Start with default-off Labs features disabled, then enable and verify them one at a
time. A Personal Team build is accepted as a personal daily-driver when it passes:

- clean launch, login, verification, restart, and non-destructive explicit logout;
- same-device reauthentication and non-destructive soft logout only after the
  [Day-1 Spec 08](/specs/day-1/spec-08--settings-and-device-management/) recovery
  slice ([#531](https://github.com/CloudHub-Social/Charm/pull/531), or its successor)
  has merged into the recorded source SHA; it does not block the baseline before then;
- existing-history and new-message decryption in encrypted rooms;
- two-way text, reply, edit, reaction, redaction, media, voice message, receipts,
  typing, and invites;
- polls only after [Day-2 Spec 03](/specs/day-2/spec-03--polls/) has merged into the
  recorded source SHA, and threads only after
  [Day-2 Spec 01](/specs/day-2/spec-01--threads/) has landed; neither blocks the
  baseline while its implementation is unreleased;
- offline send and reconnect, Wi-Fi changes, foreground/background transitions (including a
  prompt timeline and badge catch-up after returning to a still-running app), process
  termination/relaunch, and device restart;
- supported foreground notification behavior and honest unavailable state for
  remote background push;
- calls after the hosted MatrixRTC work is released;
- no message loss or duplication, cross-account leakage, persistent undecryptable
  events, or repeated launch crashes.

Run a 24-hour basic messaging/lifecycle check, a 72-hour encrypted-media and
reconnect check, and a 7-day normal-use soak that includes one re-sign rehearsal.

## Upgrade and rollback

Keep the last known-good commit and its release record. Install a newer build over
the existing app using the same development bundle identifier so upgrade behavior
is tested without intentionally clearing local data. Do not uninstall or clear the
store until encrypted recovery has been independently proven.

On a blocking regression, disable the implicated default-off feature where possible
and reinstall the last known-good commit. Continue using the already verified Matrix
client while investigating; never treat deleting other devices or sessions as a
rollback step.

After the Personal Team profile expires, select the same target/team/identifier and
press **Run** again. Record whether the reinstall retained the session, store, device
identity, and enabled flags.

## Evidence record

For every accepted device build, retain:

- exact commit and required GitHub Actions links;
- device model/OS and Xcode version;
- bundle identifier, signing team type, and profile expiry, without certificate or
  credential contents;
- baseline and enabled feature-flag sets;
- clean-install, upgrade, rollback, login, encryption, messaging, lifecycle, and
  re-sign outcomes;
- known limitations, especially missing killed-state push;
- the last known-good commit and rollback result.

Repeat the condensed matrix on the iPhone using the identical source commit and a
distinct Matrix device identity. APNs and distribution evidence may be added later
without invalidating the Personal Team daily-driver result.
