import { describe, expect, it } from "vitest";
import config from "../../src-tauri/tauri.conf.json";
import macInfo from "../../src-tauri/Info.plist?raw";
import macEntitlements from "../../src-tauri/Entitlements.plist?raw";
import iosInfo from "../../src-tauri/gen/apple/charm_iOS/Info.plist?raw";

function plistValue(source: string, name: string) {
  const document = new DOMParser().parseFromString(source, "application/xml");
  expect(document.querySelector("parsererror")).toBeNull();
  return [...document.querySelectorAll("key")].find((key) => key.textContent === name)
    ?.nextElementSibling;
}

describe("voice platform configuration", () => {
  it("describes user-initiated voice recording in both Apple permission prompts", () => {
    for (const source of [macInfo, iosInfo]) {
      expect(plistValue(source, "NSMicrophoneUsageDescription")?.textContent).toContain(
        "voice messages you choose to send",
      );
    }
  });

  it("grants only audio input in the macOS recording entitlement file", () => {
    expect(config.bundle.macOS.entitlements).toBe("Entitlements.plist");
    expect(plistValue(macEntitlements, "com.apple.security.device.audio-input")?.tagName).toBe(
      "true",
    );
    const document = new DOMParser().parseFromString(macEntitlements, "application/xml");
    expect(document.querySelectorAll("key")).toHaveLength(1);
  });

  it("permits local blob preview only in the media CSP directive", () => {
    const policy = config.app.security.csp;
    expect(policy["media-src"].split(/\s+/)).toContain("blob:");
    expect(policy["media-src"].split(/\s+/)).not.toContain("*");
    for (const [directive, sources] of Object.entries(policy)) {
      if (directive !== "media-src") expect(sources.split(/\s+/)).not.toContain("blob:");
    }
  });
});
