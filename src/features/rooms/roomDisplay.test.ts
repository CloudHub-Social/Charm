import { describe, expect, it, vi } from "vitest";
import { avatarColor, displayName, initials, resolveAvatar } from "./roomDisplay";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

describe("displayName", () => {
  it("prefers the room name when present", () => {
    expect(displayName("!abc:localhost", "general")).toBe("general");
  });

  it("falls back to the room id when name is null", () => {
    expect(displayName("!abc:localhost", null)).toBe("!abc:localhost");
  });
});

describe("initials", () => {
  it("derives two uppercase letters from a room name", () => {
    expect(initials("!abc:localhost", "general")).toBe("GE");
  });

  it("strips a leading # or @ before taking initials", () => {
    expect(initials("#general:localhost", null)).toBe("GE");
    expect(initials("@evie:localhost", null)).toBe("EV");
  });

  it("handles short names without throwing", () => {
    expect(initials("!x:localhost", "a")).toBe("A");
  });
});

describe("avatarColor", () => {
  it("is deterministic for the same id", () => {
    expect(avatarColor("!abc:localhost")).toBe(avatarColor("!abc:localhost"));
  });

  it("returns a CSS custom-property reference", () => {
    expect(avatarColor("!abc:localhost")).toMatch(/^var\(--/);
  });
});

describe("resolveAvatar", () => {
  it("converts a resolved local path to a webview-loadable URL", () => {
    expect(resolveAvatar("/cache/media/abc123")).toBe("asset://localhost//cache/media/abc123");
  });

  it("returns undefined (fallback to initials) when there's no path", () => {
    expect(resolveAvatar(null)).toBeUndefined();
  });
});
