import { describe, expect, it } from "vitest";
import { isSettingsSection, parseSettingsHash, settingsHash } from "./settingsAtoms";

describe("settingsHash / parseSettingsHash", () => {
  it("round-trips every valid section", () => {
    const sections = [
      "account",
      "notifications",
      "devices",
      "appearance",
      "general",
      "desktop",
      "about",
      "keyboard-shortcuts",
    ] as const;
    for (const section of sections) {
      expect(parseSettingsHash(settingsHash(section))).toBe(section);
    }
  });

  it("returns null for a hash that isn't a settings deep link", () => {
    expect(parseSettingsHash("")).toBeNull();
    expect(parseSettingsHash("#/room/!abc:localhost")).toBeNull();
  });

  it("returns null for an unrecognized section", () => {
    expect(parseSettingsHash("#/settings/nonexistent")).toBeNull();
  });
});

describe("isSettingsSection", () => {
  it("accepts only known sections", () => {
    expect(isSettingsSection("account")).toBe(true);
    expect(isSettingsSection("bogus")).toBe(false);
  });
});
