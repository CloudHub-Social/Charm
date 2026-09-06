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

## Select and prepare the source

1. Select an exact `origin/main` commit whose required GitHub Actions checks pass.
   Record the full SHA; simulator CI is repository evidence, not physical-device proof.
2. Use a disposable worktree or copy. Do not edit a shared checkout or reuse an
   uncommitted generated Xcode scheme.
3. Inspect `node_modules` before bootstrapping dependencies. If it is a working
   symlink created by Charm's `post-checkout` hook and the worktree and symlink-target
   `pnpm-lock.yaml` files are identical, reuse it and do not run an install. If
   `node_modules` is absent, obtain the repository owner's dependency-install
   confirmation and run `pnpm install --frozen-lockfile`. If the symlink is broken or
   the lockfiles differ, stop: remove only that worktree's symlink (never its target;
   an agent also needs deletion authorization), then obtain dependency-install
   confirmation before installing. The generated Xcode pre-build phase invokes the
   repository-local Tauri CLI, so an unbootstrapped worktree cannot build.
4. Ensure Xcode is signed in with the device owner's Apple Account and the required
   Rust iOS targets and LLVM tools are installed:

   ```sh
   rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
   rustup component add llvm-tools-preview
   ```

   `swift-rs` uses `llvm-objcopy` from that component to export the Swift
   `@_cdecl` bridge functions. On a clean machine or cloud runner, omitting it can
   compile every dependency and then fail the final arm64 link with undefined
   `_register_plugin`, `_init_plugin_*`, or related symbols. Charm's iOS nightly
   and release workflows install the component explicitly.
5. Prepare the standalone mobile bundle and open the generated project with
   `pnpm tauri ios build --open`. This outer Tauri build is required: it generates
   the frontend bundle and the untracked assets consumed by Xcode. Do not use
   `pnpm tauri ios dev --open` for a daily-driver install because that path can depend
   on the development server. Xcode 27 also requires the generated app manifest to
   declare `TaoSceneDelegate`; without it, iPadOS terminates the app during launch in
   `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`. Charm tracks that
   declaration in both `project.yml` and `Info.plist` so regeneration preserves it.
6. In Xcode, edit the `charm_iOS` scheme so its **Run** build configuration is
   **Release**, then use that scheme for the physical-device install (or archive and
   install the Release build when Xcode offers that path for the selected Personal
   Team). Automated agents do not invoke Tauri/Xcode device builds or perform signing
   actions. Documentation changes still follow the validation policy in
   `docs-site/AGENTS.md`.

## Personal Team signing

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
- offline send and reconnect, Wi-Fi changes, foreground/background transitions,
  process termination/relaunch, and device restart;
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
