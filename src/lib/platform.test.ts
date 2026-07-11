import { afterEach, describe, expect, it, vi } from "vitest";
import * as pluginOs from "@tauri-apps/plugin-os";
import { isTauri, platformTag } from "./platform";

vi.mock("@tauri-apps/plugin-os", () => ({
  platform: vi.fn(),
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

describe("platformTag", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    vi.mocked(pluginOs.platform).mockReset();
  });

  it("returns 'web' outside a Tauri shell", () => {
    expect(platformTag()).toBe("web");
    expect(pluginOs.platform).not.toHaveBeenCalled();
  });

  it("returns the plugin-os platform value inside a Tauri shell", () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    vi.mocked(pluginOs.platform).mockReturnValue("macos");

    expect(platformTag()).toBe("macos");
  });

  it("falls back to 'webview' when the OS plugin internals aren't available", () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    vi.mocked(pluginOs.platform).mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined");
    });

    expect(platformTag()).toBe("webview");
  });
});
