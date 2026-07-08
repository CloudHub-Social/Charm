import { describe, expect, it, vi } from "vitest";
import { toLoadableMediaUrl } from "./mediaUrl";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

describe("toLoadableMediaUrl", () => {
  it("passes through absolute HTTP URLs", () => {
    expect(toLoadableMediaUrl("http://example.org/media.png")).toBe("http://example.org/media.png");
    expect(toLoadableMediaUrl("https://example.org/media.png")).toBe(
      "https://example.org/media.png",
    );
  });

  it("passes through companion API paths", () => {
    expect(toLoadableMediaUrl("/api/rooms/!r%3Aexample.org/avatar")).toBe(
      "/api/rooms/!r%3Aexample.org/avatar",
    );
  });

  it("converts local file paths into loadable asset URLs", () => {
    expect(toLoadableMediaUrl("/cache/media/avatar.png")).toBe(
      "asset://localhost//cache/media/avatar.png",
    );
  });
});
