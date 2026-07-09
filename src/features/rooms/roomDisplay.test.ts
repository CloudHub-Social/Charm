import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("converts a resolved local path to a webview-loadable URL", () => {
    expect(resolveAvatar("/cache/media/abc123")).toBe("asset://localhost//cache/media/abc123");
  });

  it("resolves an mxc avatar URL through the web companion when no path exists", () => {
    vi.stubEnv("VITE_CHARM_BUILD_TARGET", "web");

    expect(resolveAvatar(null, "mxc://example.org/abc123")).toBe(
      "/api/media/avatar?mxc=mxc%3A%2F%2Fexample.org%2Fabc123",
    );
  });

  it("resolves web companion avatar URLs under a configured path prefix", () => {
    vi.stubEnv("VITE_CHARM_BUILD_TARGET", "web");
    vi.stubEnv("VITE_CHARM_WEB_API_BASE_URL", "/charm/");

    expect(resolveAvatar(null, "mxc://example.org/abc123")).toBe(
      "/charm/api/media/avatar?mxc=mxc%3A%2F%2Fexample.org%2Fabc123",
    );
  });

  it("resolves web companion avatar URLs under a configured absolute base", () => {
    vi.stubEnv("VITE_CHARM_BUILD_TARGET", "web");
    vi.stubEnv("VITE_CHARM_WEB_API_BASE_URL", "https://api.example/charm");

    expect(resolveAvatar(null, "mxc://example.org/abc123")).toBe(
      "https://api.example/charm/api/media/avatar?mxc=mxc%3A%2F%2Fexample.org%2Fabc123",
    );
  });

  it("falls back to initials for unresolved desktop mxc avatar URLs", () => {
    expect(resolveAvatar(null, "mxc://example.org/abc123")).toBeUndefined();
  });

  it("returns undefined (fallback to initials) when there's no path", () => {
    expect(resolveAvatar(null)).toBeUndefined();
  });
});
