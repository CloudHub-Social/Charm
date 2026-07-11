import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyAppearanceToDom, resolveEffectiveTheme, resolveSystemTheme } from "./dom";
import { DEFAULT_APPEARANCE } from "./atoms";

// `Object.defineProperty` (not `vi.stubGlobal`) is what actually reaches
// `window.matchMedia` in this jsdom setup. Because it's a real property
// mutation rather than a vi-tracked stub, `vi.unstubAllGlobals()`/
// `vi.restoreAllMocks()` do NOT undo it — so every test file in this module
// that mocks matchMedia must restore jsdom's original descriptor itself, or
// a mocked `matches: false`/no-op `addEventListener` can leak into whichever
// test file vitest happens to run next in the same worker (observed as
// flaky failures in `ThemeProvider.test.tsx` only under full-suite/parallel
// runs, never in isolation).
const originalMatchMediaDescriptor = Object.getOwnPropertyDescriptor(window, "matchMedia");

function mockMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

function restoreMatchMedia() {
  if (originalMatchMediaDescriptor) {
    Object.defineProperty(window, "matchMedia", originalMatchMediaDescriptor);
  } else {
    Reflect.deleteProperty(window, "matchMedia");
  }
}

describe("resolveSystemTheme", () => {
  afterEach(() => {
    restoreMatchMedia();
    vi.unstubAllGlobals();
  });

  it("returns dark when the OS prefers dark", () => {
    mockMatchMedia(true);
    expect(resolveSystemTheme()).toBe("dark");
  });

  it("returns light when the OS prefers light", () => {
    mockMatchMedia(false);
    expect(resolveSystemTheme()).toBe("light");
  });
});

describe("resolveEffectiveTheme", () => {
  afterEach(() => {
    restoreMatchMedia();
  });

  it("passes through literal choices", () => {
    expect(resolveEffectiveTheme("light")).toBe("light");
    expect(resolveEffectiveTheme("midnight")).toBe("midnight");
    expect(resolveEffectiveTheme("dark")).toBe("dark");
  });

  it("resolves system against the OS preference", () => {
    mockMatchMedia(true);
    expect(resolveEffectiveTheme("system")).toBe("dark");
    mockMatchMedia(false);
    expect(resolveEffectiveTheme("system")).toBe("light");
  });
});

describe("applyAppearanceToDom", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-density");
    document.documentElement.removeAttribute("data-font-size");
    document.documentElement.removeAttribute("data-reduced-motion");
  });

  afterEach(() => {
    restoreMatchMedia();
  });

  it("sets all four dataset attributes on <html>", () => {
    applyAppearanceToDom({
      theme: "midnight",
      fontSize: "lg",
      density: "compact",
      reducedMotion: "on",
      messageLayout: "bubble",
    });
    expect(document.documentElement.dataset.theme).toBe("midnight");
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(document.documentElement.dataset.fontSize).toBe("lg");
    expect(document.documentElement.dataset.reducedMotion).toBe("on");
  });

  it("resolves system theme before writing data-theme", () => {
    mockMatchMedia(false);
    applyAppearanceToDom({ ...DEFAULT_APPEARANCE, theme: "system" });
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
