#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const emptyEntitlements = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict/></plist>
`;

function replaceOnce(source, pattern, replacement, description) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matches = [...source.matchAll(new RegExp(pattern.source, flags))];
  if (matches.length !== 1) {
    throw new Error(`expected one ${description}, found ${matches.length}`);
  }
  return source.replace(pattern, replacement);
}

function removeTargetEntitlements(project) {
  const target = project.indexOf("  charm_iOS:\n");
  const start = project.indexOf("    entitlements:\n", target);
  const end = project.indexOf("    scheme:\n", start);
  if (target === -1 || start === -1 || end === -1) {
    throw new Error("could not locate the charm_iOS entitlements block in project.yml");
  }
  return `${project.slice(0, start)}${project.slice(end)}`;
}

function removeRemoteNotificationBackgroundMode(project) {
  return replaceOnce(
    project,
    /        # Spec 11: lets the app receive remote \(APNs\) notifications,[\s\S]*?        UIBackgroundModes:\n          - remote-notification\n/,
    "",
    "remote-notification UIBackgroundModes block",
  );
}

function replacePlistString(plist, key, value) {
  return replaceOnce(
    plist,
    new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`),
    `$1${value}$2`,
    `${key} plist string`,
  );
}

export function configureSideloadIos(worktree, version, build) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("version must be three period-separated numeric components");
  }
  if (!/^\d+$/.test(build) || BigInt(build) < 1n) {
    throw new Error("build must be a positive numeric CFBundleVersion");
  }

  const root = resolve(worktree);
  const read = (path) => readFileSync(join(root, path), "utf8");
  const write = (path, content) => writeFileSync(join(root, path), content);
  const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
  if (tauri.identifier !== "social.cloudhub.charm") {
    throw new Error("sideload builds must retain the canonical Charm bundle identifier");
  }
  if (tauri.version !== version) {
    throw new Error(
      `Tauri version ${tauri.version} does not match requested sideload version ${version}`,
    );
  }

  let project = read("src-tauri/gen/apple/project.yml");
  project = removeTargetEntitlements(project);
  project = removeRemoteNotificationBackgroundMode(project);
  project = replaceOnce(
    project,
    /^        CFBundleShortVersionString: .+$/m,
    `        CFBundleShortVersionString: ${version}`,
    "CFBundleShortVersionString project value",
  );
  project = replaceOnce(
    project,
    /^        CFBundleVersion: .+$/m,
    `        CFBundleVersion: "${build}"`,
    "CFBundleVersion project value",
  );
  write("src-tauri/gen/apple/project.yml", project);

  let plist = read("src-tauri/gen/apple/charm_iOS/Info.plist");
  plist = replacePlistString(plist, "CFBundleShortVersionString", version);
  plist = replacePlistString(plist, "CFBundleVersion", build);
  plist = replaceOnce(
    plist,
    /\s*<!-- Spec 11: lets the app receive remote \(APNs\) notifications,[\s\S]*?<key>UIBackgroundModes<\/key>\s*<array>\s*<string>remote-notification<\/string>\s*<\/array>/,
    "",
    "remote-notification plist block",
  );
  write("src-tauri/gen/apple/charm_iOS/Info.plist", plist);

  const pbxprojPath = "src-tauri/gen/apple/charm.xcodeproj/project.pbxproj";
  if (existsSync(join(root, pbxprojPath))) {
    const pbxproj = read(pbxprojPath).replace(
      /^\s*CODE_SIGN_ENTITLEMENTS = charm_iOS\/charm_iOS\.entitlements;\n/gm,
      "",
    );
    if (pbxproj === read(pbxprojPath)) {
      throw new Error("could not remove generated CODE_SIGN_ENTITLEMENTS settings");
    }
    write(pbxprojPath, pbxproj);
  }

  write("src-tauri/gen/apple/charm_iOS/charm_iOS.entitlements", emptyEntitlements);
}

const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const [worktree, version, build] = process.argv.slice(2);
  if (!worktree || !version || !build) {
    throw new Error("usage: configure-sideload-ios.mjs <worktree> <version> <build>");
  }
  configureSideloadIos(worktree, version, build);
}
