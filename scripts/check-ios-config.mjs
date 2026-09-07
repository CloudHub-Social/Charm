#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const errors = [];

function requireCondition(condition, message) {
  if (!condition) errors.push(message);
}

const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
const project = read("src-tauri/gen/apple/project.yml");
const podfile = read("src-tauri/gen/apple/Podfile");
const pbxproj = read("src-tauri/gen/apple/charm.xcodeproj/project.pbxproj");
const plist = read("src-tauri/gen/apple/charm_iOS/Info.plist");
const cargoLock = read("Cargo.lock");
const cargoManifest = read("Cargo.toml");
const swiftRsNmWrapper = read("scripts/xcode27-swiftrs-tools/nm");
const altstoreSource = JSON.parse(read(".github/templates/altstore-source.json"));

requireCondition(
  tauri.bundle?.iOS?.minimumSystemVersion === "15.0",
  "tauri.conf.json must set bundle.iOS.minimumSystemVersion to 15.0",
);
requireCondition(
  /^\s+iOS: 15\.0$/m.test(project),
  "project.yml must set the iOS deployment target to 15.0",
);
requireCondition(
  /^platform :ios, '15\.0'$/m.test(podfile),
  "Podfile must set the iOS platform to 15.0",
);
requireCondition(
  (pbxproj.match(/IPHONEOS_DEPLOYMENT_TARGET = 15\.0;/g) ?? []).length >= 2,
  "the generated Xcode project must set every project configuration to iOS 15.0",
);
requireCondition(
  !/IPHONEOS_DEPLOYMENT_TARGET = (?:1[0-4](?:\.[0-9]+)?);/.test(pbxproj),
  "the generated Xcode project contains an iOS deployment target below 15.0",
);

requireCondition(
  tauri.identifier === "social.cloudhub.charm",
  "the committed Tauri bundle identifier must remain social.cloudhub.charm",
);
requireCondition(
  /PRODUCT_BUNDLE_IDENTIFIER: social\.cloudhub\.charm/.test(project),
  "project.yml must retain the canonical bundle identifier",
);
requireCondition(
  (pbxproj.match(/PRODUCT_BUNDLE_IDENTIFIER = social\.cloudhub\.charm;/g) ?? []).length >= 2,
  "the generated Xcode project must retain the canonical bundle identifier",
);

const mobileSchemes =
  tauri.plugins?.["deep-link"]?.mobile?.flatMap((entry) =>
    Array.isArray(entry.scheme) ? entry.scheme : [entry.scheme],
  ) ?? [];
requireCondition(
  mobileSchemes.includes("charm"),
  "tauri.conf.json must register the charm mobile URL scheme",
);
requireCondition(
  /<key>CFBundleURLSchemes<\/key>[\s\S]*?<string>charm<\/string>/.test(plist),
  "Info.plist must register the charm URL scheme",
);
requireCondition(
  /UISceneDelegateClassName: TaoSceneDelegate/.test(project) &&
    /<key>UISceneDelegateClassName<\/key>\s*<string>TaoSceneDelegate<\/string>/.test(plist),
  "project.yml and Info.plist must both declare the static TaoSceneDelegate",
);

const swiftRsBlock =
  cargoLock.match(/\[\[package\]\]\nname = "swift-rs"\n[\s\S]*?(?=\n\[\[package\]\]|$)/)?.[0] ?? "";
requireCondition(
  /version = "1\.0\.8"/.test(swiftRsBlock) &&
    /source = "registry\+https:\/\/github\.com\/rust-lang\/crates\.io-index"/.test(swiftRsBlock),
  "Cargo.lock must use the official crates.io swift-rs 1.0.8 release",
);
requireCondition(
  !/fix-ios-swiftrs-archive\.sh/.test(project + pbxproj),
  "the generated Apple build phase must not call the retired custom Swift archive repair",
);
requireCondition(
  /swift-rs Xcode 27 bridge repair/.test(swiftRsNmWrapper) &&
    /--globalize-symbol=_release_object/.test(swiftRsNmWrapper) &&
    /--globalize-symbol=_retain_object/.test(swiftRsNmWrapper) &&
    /--globalize-symbol=_string_from_bytes/.test(swiftRsNmWrapper),
  "the Xcode 27 swift-rs bridge repair must export the required Swift runtime symbols",
);
requireCondition(
  /&& test -f [^\n]*libapp\.a/.test(project) && /&& test -f [^\n]*libapp\.a/.test(pbxproj),
  "the generated Apple build phase must fail fast and verify the fresh Rust archive",
);

requireCondition(
  /tao = \{ git = "https:\/\/github\.com\/Just-Insane\/tao", rev = "[0-9a-f]{40}" \}/.test(
    cargoManifest,
  ),
  "the temporary Tao iOS 27 backport must remain pinned to an exact revision",
);
requireCondition(
  /tauri-macros = \{ git = "https:\/\/github\.com\/Just-Insane\/tauri", rev = "[0-9a-f]{40}" \}/.test(
    cargoManifest,
  ),
  "the temporary Tauri async-command backport must remain pinned to an exact revision",
);

const committedAppleConfiguration = [project, pbxproj, JSON.stringify(tauri)].join("\n");
requireCondition(
  !/social\.cloudhub\.charm\.personal(?:\.|\b)/.test(committedAppleConfiguration),
  "a Personal Team bundle identifier was committed to canonical Apple configuration",
);
requireCondition(
  !/DEVELOPMENT_TEAM\s*=\s*[A-Z0-9]{10}\s*;/.test(committedAppleConfiguration),
  "a concrete Apple development team identifier was committed",
);

const altstoreApp = altstoreSource.apps?.[0];
const plistString = (key) =>
  plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`))?.[1];
requireCondition(
  altstoreSource.identifier === "social.cloudhub.charm.ios-nightly.source" &&
    altstoreApp?.bundleIdentifier === "social.cloudhub.charm",
  "AltStore source must identify the canonical Charm nightly app",
);
requireCondition(
  Array.isArray(altstoreApp?.appPermissions?.entitlements) &&
    altstoreApp.appPermissions.entitlements.length === 0,
  "Personal Team AltStore source must not advertise APNs or App Group entitlements",
);
requireCondition(
  altstoreApp?.appPermissions?.privacy?.NSCameraUsageDescription ===
    plistString("NSCameraUsageDescription") &&
    altstoreApp.appPermissions.privacy.NSMicrophoneUsageDescription ===
      plistString("NSMicrophoneUsageDescription"),
  "AltStore source privacy declarations must match Charm's iOS Info.plist",
);

if (errors.length > 0) {
  process.stderr.write(
    `iOS configuration consistency check failed:\n${errors.map((error) => `- ${error}`).join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    "iOS configuration is consistent (iOS 15+, canonical ID, deep link, scene delegate, swift-rs 1.0.8).\n",
  );
}
