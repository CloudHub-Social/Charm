import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { configureSideloadIos } from "./configure-sideload-ios.mjs";

const root = new URL("..", import.meta.url).pathname;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "charm-sideload-ios-"));
  for (const path of [
    "src-tauri/tauri.conf.json",
    "src-tauri/gen/apple/project.yml",
    "src-tauri/gen/apple/charm_iOS/Info.plist",
    "src-tauri/gen/apple/charm_iOS/charm_iOS.entitlements",
    "src-tauri/gen/apple/charm.xcodeproj/project.pbxproj",
  ]) {
    const destination = join(directory, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(root, path), destination, { recursive: false });
  }
  return directory;
}

test("creates a canonical capability-reduced sideload overlay", () => {
  const directory = fixture();
  try {
    configureSideloadIos(directory, "0.1.3", "123");
    const project = readFileSync(join(directory, "src-tauri/gen/apple/project.yml"), "utf8");
    const plist = readFileSync(join(directory, "src-tauri/gen/apple/charm_iOS/Info.plist"), "utf8");
    const entitlements = readFileSync(
      join(directory, "src-tauri/gen/apple/charm_iOS/charm_iOS.entitlements"),
      "utf8",
    );
    const pbxproj = readFileSync(
      join(directory, "src-tauri/gen/apple/charm.xcodeproj/project.pbxproj"),
      "utf8",
    );

    assert.match(project, /CFBundleShortVersionString: 0\.1\.3/);
    assert.match(project, /CFBundleVersion: "123"/);
    assert.doesNotMatch(project, /entitlements:|remote-notification/);
    assert.match(plist, /<string>0\.1\.3<\/string>/);
    assert.match(plist, /<string>123<\/string>/);
    assert.doesNotMatch(plist, /UIBackgroundModes|remote-notification/);
    assert.equal(entitlements.includes("aps-environment"), false);
    assert.equal(entitlements.includes("application-groups"), false);
    assert.doesNotMatch(pbxproj, /CODE_SIGN_ENTITLEMENTS/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects non-Apple version values before editing", () => {
  const directory = fixture();
  try {
    assert.throws(() => configureSideloadIos(directory, "0.1", "123"), /three period-separated/);
    assert.throws(() => configureSideloadIos(directory, "0.1.3", "0"), /positive numeric/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("writes a newest-first, entitlement-free AltStore source", () => {
  const directory = mkdtempSync(join(tmpdir(), "charm-altstore-source-"));
  try {
    const template = join(root, ".github/templates/altstore-source.json");
    const output = join(directory, "altstore-source.json");
    execFileSync(
      process.execPath,
      [
        join(root, "scripts/update-altstore-source.mjs"),
        template,
        output,
        "0.1.3",
        "123",
        "456",
        "https://github.com/CloudHub-Social/Charm/releases/download/ios-nightly/Charm.ipa",
        "2026-09-07T00:00:00Z",
        "Charm 0.1.3 nightly.123",
      ],
      { stdio: "pipe" },
    );
    const source = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(source.apps[0].versions[0].version, "0.1.3");
    assert.equal(source.apps[0].versions[0].buildVersion, "123");
    assert.equal(source.apps[0].versions[0].minOSVersion, "15.0");
    assert.deepEqual(source.apps[0].appPermissions.entitlements, []);

    source.apps[0].versions.push({ buildVersion: "122" }, { buildVersion: "121" }, { buildVersion: "120" });
    writeFileSync(output, `${JSON.stringify(source)}\n`);
    execFileSync(
      process.execPath,
      [
        join(root, "scripts/update-altstore-source.mjs"),
        output,
        output,
        "0.1.3",
        "124",
        "457",
        "https://github.com/CloudHub-Social/Charm/releases/download/ios-nightly/Charm-new.ipa",
        "2026-09-08T00:00:00Z",
        "Charm 0.1.3 nightly.124",
      ],
      { stdio: "pipe" },
    );
    const updated = JSON.parse(readFileSync(output, "utf8"));
    assert.deepEqual(
      updated.apps[0].versions.map((entry) => entry.buildVersion),
      ["124", "123", "122"],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
