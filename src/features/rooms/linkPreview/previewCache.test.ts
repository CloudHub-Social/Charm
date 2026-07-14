import { beforeEach, describe, expect, it, vi } from "vitest";

const getUrlPreview = vi.fn();

vi.mock("@/lib/matrix", () => ({
  getUrlPreview: (...args: unknown[]) => getUrlPreview(...args),
}));

import { clearUrlPreviewCache, fetchUrlPreview } from "./previewCache";

beforeEach(() => {
  getUrlPreview.mockReset();
  clearUrlPreviewCache();
});

describe("fetchUrlPreview", () => {
  it("fetches once and serves subsequent calls from the cache", async () => {
    getUrlPreview.mockResolvedValueOnce({
      title: "Example",
      description: null,
      imageUrl: null,
      imageWidth: null,
      imageHeight: null,
      siteName: null,
    });

    const first = await fetchUrlPreview("!room:localhost", "https://example.com");
    const second = await fetchUrlPreview("!room:localhost", "https://example.com");

    expect(first).toEqual(second);
    expect(getUrlPreview).toHaveBeenCalledTimes(1);
  });

  it("caches a null (no preview) result too, so it isn't re-fetched", async () => {
    getUrlPreview.mockResolvedValueOnce(null);

    const first = await fetchUrlPreview("!room:localhost", "https://example.com/missing");
    const second = await fetchUrlPreview("!room:localhost", "https://example.com/missing");

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(getUrlPreview).toHaveBeenCalledTimes(1);
  });

  it("fetches independently per room/url pair", async () => {
    getUrlPreview.mockResolvedValue(null);

    await fetchUrlPreview("!room-a:localhost", "https://example.com");
    await fetchUrlPreview("!room-b:localhost", "https://example.com");

    expect(getUrlPreview).toHaveBeenCalledTimes(2);
  });
});
