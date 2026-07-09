import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openExternalUrl } from "./openExternalUrl";

const openUrl = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => openUrl(...args),
}));

describe("openExternalUrl", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_CHARM_BUILD_TARGET", "web");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    openUrl.mockClear();
  });

  it("opens absolute http, https, mailto, and tel URLs in web builds", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    await openExternalUrl("https://example.org/account");
    await openExternalUrl("http://example.org/account");
    await openExternalUrl("mailto:alice@example.org");
    await openExternalUrl("tel:+15551234567");

    expect(open).toHaveBeenCalledWith(
      "https://example.org/account",
      "_blank",
      "noopener,noreferrer",
    );
    expect(open).toHaveBeenCalledWith(
      "http://example.org/account",
      "_blank",
      "noopener,noreferrer",
    );
    expect(open).toHaveBeenCalledWith("mailto:alice@example.org", "_blank", "noopener,noreferrer");
    expect(open).toHaveBeenCalledWith("tel:+15551234567", "_blank", "noopener,noreferrer");
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("ignores invalid or unsafe URLs in web builds", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    await openExternalUrl("javascript:alert(1)");
    await openExternalUrl("data:text/html,hello");
    await openExternalUrl("/relative/path");
    await openExternalUrl("not a url");

    expect(open).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });
});
