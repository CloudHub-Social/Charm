import { beforeEach, describe, expect, it, vi } from "vitest";

const getUrlPreview = vi.fn();

vi.mock("@/lib/matrix", () => ({
  getUrlPreview: (...args: unknown[]) => getUrlPreview(...args),
}));

import { fetchUrlPreview } from "./previewCache";

beforeEach(() => {
  getUrlPreview.mockReset();
});

describe("fetchUrlPreview", () => {
  it("delegates straight through to getUrlPreview with the given room/url", async () => {
    getUrlPreview.mockResolvedValueOnce({
      title: "Example",
      description: null,
      imageUrl: null,
      imageWidth: null,
      imageHeight: null,
      siteName: null,
    });

    const preview = await fetchUrlPreview("!room:localhost", "https://example.com", 1700000000000);

    expect(preview?.title).toBe("Example");
    expect(getUrlPreview).toHaveBeenCalledExactlyOnceWith(
      "!room:localhost",
      "https://example.com",
      1700000000000,
    );
  });

  it("passes through a null (no preview) result unchanged", async () => {
    getUrlPreview.mockResolvedValueOnce(null);

    const preview = await fetchUrlPreview("!room:localhost", "https://example.com/missing");

    expect(preview).toBeNull();
  });
});
