import { afterEach, describe, expect, it } from "vitest";
import { isTauri } from "./platform";

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
