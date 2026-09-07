#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [worktree, teamId, bundleId] = process.argv.slice(2);

if (!worktree || !teamId || !bundleId) {
  throw new Error("usage: configure-personal-ios.mjs <worktree> <team-id> <bundle-id>");
}

if (!/^[A-Z0-9]{10}$/.test(teamId)) {
  throw new Error("the Apple Personal Team ID must be a 10-character uppercase identifier");
}

if (!/^[A-Za-z0-9.-]+$/.test(bundleId) || bundleId === "social.cloudhub.charm") {
  throw new Error("use a unique development bundle identifier, not Charm's canonical identifier");
}

const root = resolve(worktree);
const read = (path) => readFileSync(join(root, path), "utf8");
const write = (path, content) => writeFileSync(join(root, path), content);

const tauriPath = "src-tauri/tauri.conf.json";
const tauri = JSON.parse(read(tauriPath));
tauri.identifier = bundleId;
tauri.bundle ??= {};
tauri.bundle.iOS = {
  ...tauri.bundle.iOS,
  minimumSystemVersion: "15.0",
  developmentTeam: teamId,
};
write(tauriPath, `${JSON.stringify(tauri, null, 2)}\n`);

const projectPath = "src-tauri/gen/apple/project.yml";
let project = read(projectPath);
const projectWithIdentifiers = project
  .replace(/^  bundleIdPrefix: social\.cloudhub\.charm$/m, `  bundleIdPrefix: ${bundleId}`)
  .replace(
    /^      PRODUCT_BUNDLE_IDENTIFIER: social\.cloudhub\.charm$/m,
    `      PRODUCT_BUNDLE_IDENTIFIER: ${bundleId}`,
  );
if (projectWithIdentifiers === project) {
  throw new Error("could not set the Personal Team bundle identifier in project.yml");
}
project = projectWithIdentifiers;

// XcodeGen owns the committed project. Remove only the charm_iOS entitlement
// block in this disposable copy, because Personal Team provisioning cannot sign
// APNs or the App Group capability. Its target-level build settings force
// automatic provisioning without touching the canonical project.
const entitlementsStart = project.indexOf("    entitlements:\n", project.indexOf("  charm_iOS:\n"));
const schemeStart = project.indexOf("    scheme:\n", entitlementsStart);
if (entitlementsStart === -1 || schemeStart === -1) {
  throw new Error("could not locate the charm_iOS entitlements block in project.yml");
}
project = `${project.slice(0, entitlementsStart)}${project.slice(schemeStart)}`;
const projectWithSigning = project.replace(
  /    settings:\n      base:\n        ENABLE_BITCODE: false/m,
  `    settings:\n      base:\n        CODE_SIGN_STYLE: Automatic\n        DEVELOPMENT_TEAM: ${teamId}\n        ENABLE_BITCODE: false`,
);
if (projectWithSigning === project) {
  throw new Error("could not add Personal Team signing settings to project.yml");
}
project = projectWithSigning;
write(projectPath, project);

const pbxprojPath = "src-tauri/gen/apple/charm.xcodeproj/project.pbxproj";
if (existsSync(join(root, pbxprojPath))) {
  let pbxproj = read(pbxprojPath)
    .replaceAll(
      "PRODUCT_BUNDLE_IDENTIFIER = social.cloudhub.charm;",
      `PRODUCT_BUNDLE_IDENTIFIER = ${bundleId};`,
    )
    .replace(/^\s*CODE_SIGN_ENTITLEMENTS = charm_iOS\/charm_iOS\.entitlements;\n/gm, "")
    .replace(
      /^(\s*CODE_SIGN_IDENTITY = "iPhone Developer";\n)/gm,
      `$1\t			CODE_SIGN_STYLE = Automatic;\n\t\t\t\tDEVELOPMENT_TEAM = ${teamId};\n`,
    );
  write(pbxprojPath, pbxproj);
}

// Leave no capability-bearing entitlement in the disposable project even if a
// future XcodeGen invocation has not yet rewritten the generated pbxproj.
write(
  "src-tauri/gen/apple/charm_iOS/charm_iOS.entitlements",
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict/></plist>\n`,
);

// A Run action ordinarily means Debug, which asks Tauri for a Vite dev server.
// Personal-device installs must be standalone Release builds, so change only
// the disposable shared scheme; the committed development scheme stays Debug.
const schemePath = "src-tauri/gen/apple/charm.xcodeproj/xcshareddata/xcschemes/charm_iOS.xcscheme";
if (existsSync(join(root, schemePath))) {
  const scheme = read(schemePath).replace(
    /(<LaunchAction\s+buildConfiguration = ")debug("[\s\S]*?<\/LaunchAction>)/,
    "$1release$2",
  );
  if (scheme === read(schemePath)) {
    throw new Error("could not set the Personal Team Xcode Run scheme to Release");
  }
  write(schemePath, scheme);
}

write(
  ".charm-personal-ios.json",
  `${JSON.stringify({ bundleId, commit: process.env.CHARM_IOS_COMMIT ?? "unknown", teamId }, null, 2)}\n`,
);
