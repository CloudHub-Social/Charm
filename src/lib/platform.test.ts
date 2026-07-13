import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { isTauri, platformTag, platformTestHooks, preloadPlatformTag } from "./platform";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("isTauri", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("is false in a plain browser/jsdom environment", () => {
    expect(isTauri()).toBe(false);
  });

  it("is true once __TAURI_INTERNALS__ is present on window", () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(isTauri()).toBe(true);
  });
});

describe("platformTag / preloadPlatformTag", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    vi.mocked(invoke).mockReset();
    platformTestHooks.reset();
  });

  it("resolves to 'web' outside a Tauri shell without invoking a command", async () => {
    await expect(preloadPlatformTag()).resolves.toBe("web");
    expect(platformTag()).toBe("web");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("caches the get_platform command's value inside a Tauri shell", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockResolvedValue("macos");

    await expect(preloadPlatformTag()).resolves.toBe("macos");
    expect(invoke).toHaveBeenCalledWith("get_platform");
    expect(platformTag()).toBe("macos");

    await preloadPlatformTag();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("falls back to 'webview' when the get_platform command fails", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockRejectedValue(new Error("no handler"));

    await expect(preloadPlatformTag()).resolves.toBe("webview");
    expect(platformTag()).toBe("webview");
  });
});
