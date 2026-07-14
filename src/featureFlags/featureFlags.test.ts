import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FEATURE_FLAG_CATALOG, FEATURE_FLAG_KEYS } from "./catalog";
import { resolveFlag } from "./resolve";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  addFeatureFlag: vi.fn(),
  getClient: vi.fn(),
  load: vi.fn(),
}));

vi.mock("@/lib/platform", () => ({ isTauri: () => mocks.isTauri() }));

vi.mock("@sentry/react", () => ({
  getClient: () => mocks.getClient(),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: (...args: unknown[]) => mocks.load(...args),
}));

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  mocks.isTauri.mockReturnValue(false);
  mocks.load.mockReset().mockRejectedValue(new Error("store unavailable"));
  mocks.addFeatureFlag.mockReset();
  mocks.getClient.mockReset().mockReturnValue({
    getIntegrationByName: (name: string) =>
      name === "FeatureFlags" ? { addFeatureFlag: mocks.addFeatureFlag } : undefined,
  });
});

describe("resolveFlag", () => {
  it("returns the catalog default with no override", () => {
    expect(resolveFlag("canary", {})).toBe(FEATURE_FLAG_CATALOG.canary.default);
  });

  it("lets an override win over the default", () => {
    expect(resolveFlag("canary", { canary: true })).toBe(true);
    expect(resolveFlag("canary", { canary: false })).toBe(false);
  });

  it("has a catalog key for every exported flag key", () => {
    // FEATURE_FLAG_KEYS is derived from the record; this also fails to compile
    // if the record and the ts-rs union drift (the record is typed by it).
    expect(FEATURE_FLAG_KEYS.length).toBeGreaterThan(0);
    for (const key of FEATURE_FLAG_KEYS) {
      expect(FEATURE_FLAG_CATALOG[key]).toBeDefined();
    }
  });
});

describe("feature-flag client", () => {
  it("reports evaluations to Sentry when the integration is present", async () => {
    const { getFlag } = await import("./index");
    expect(getFlag("canary")).toBe(false);
    expect(mocks.addFeatureFlag).toHaveBeenCalledWith("canary", false);
  });

  it("does not throw when Sentry is disabled (no client)", async () => {
    mocks.getClient.mockReturnValue(undefined);
    const { getFlag } = await import("./index");
    expect(() => getFlag("canary")).not.toThrow();
    expect(mocks.addFeatureFlag).not.toHaveBeenCalled();
  });

  it("applies an override through the cache and persists it", async () => {
    const mod = await import("./index");
    await mod.setFeatureFlagOverride("canary", true);
    expect(mod.getFlag("canary")).toBe(true);
    expect(mod.getFeatureFlagOverrides()).toEqual({ canary: true });
    // Persisted to the localStorage mirror (non-Tauri path).
    expect(localStorage.getItem("charm:featureFlags")).toContain("canary");
  });

  it("clears an override back to the default", async () => {
    const mod = await import("./index");
    await mod.setFeatureFlagOverride("canary", true);
    await mod.clearFeatureFlagOverride("canary");
    expect(mod.getFlag("canary")).toBe(false);
    expect(mod.getFeatureFlagOverrides()).toEqual({});
  });

  it("seeds the cache from persisted overrides on initialize", async () => {
    localStorage.setItem(
      "charm:featureFlags",
      JSON.stringify({ state: { overrides: { canary: true } }, updatedAt: 1 }),
    );
    const mod = await import("./index");
    await mod.initializeFeatureFlags();
    expect(mod.getFlag("canary")).toBe(true);
  });

  it("ignores persisted overrides for unknown keys", async () => {
    localStorage.setItem(
      "charm:featureFlags",
      JSON.stringify({ state: { overrides: { not_a_real_flag: true } }, updatedAt: 1 }),
    );
    const mod = await import("./index");
    await mod.initializeFeatureFlags();
    expect(mod.getFeatureFlagOverrides()).toEqual({});
  });

  it("does not let a slow initialization overwrite a newer override", async () => {
    mocks.isTauri.mockReturnValue(true);
    let resolveLoad: ((store: object) => void) | undefined;
    const delayedLoad = new Promise((resolve) => {
      resolveLoad = resolve;
    });
    mocks.load.mockReturnValue(delayedLoad);

    const mod = await import("./index");
    const initialization = mod.initializeFeatureFlags();
    const update = mod.setFeatureFlagOverride("canary", true);
    expect(mod.getFeatureFlagOverrides()).toEqual({ canary: true });

    resolveLoad?.({
      get: vi.fn().mockResolvedValue({ state: { overrides: { canary: false } }, updatedAt: 1 }),
      set: vi.fn().mockResolvedValue(undefined),
      save: vi.fn().mockResolvedValue(undefined),
    });
    await Promise.all([initialization, update]);

    expect(mod.getFeatureFlagOverrides()).toEqual({ canary: true });
    expect(mod.getFlag("canary")).toBe(true);
  });

  it("rolls back an override when the durable Tauri write fails", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.load.mockResolvedValue({
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockRejectedValue(new Error("disk full")),
      save: vi.fn().mockResolvedValue(undefined),
    });

    const mod = await import("./index");
    await expect(mod.setFeatureFlagOverride("canary", true)).rejects.toThrow("disk full");

    expect(mod.getFeatureFlagOverrides()).toEqual({});
    expect(mod.getFlag("canary")).toBe(false);
    expect(localStorage.getItem("charm:featureFlags")).toBeNull();
  });

  it("rolls back a browser override when localStorage fails", async () => {
    const workingStorage = localStorage;
    vi.stubGlobal("localStorage", {
      get length() {
        return workingStorage.length;
      },
      clear: () => workingStorage.clear(),
      getItem: (key: string) => workingStorage.getItem(key),
      key: (index: number) => workingStorage.key(index),
      removeItem: (key: string) => workingStorage.removeItem(key),
      setItem: () => {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      },
    } satisfies Storage);

    try {
      const mod = await import("./index");

      await expect(mod.setFeatureFlagOverride("canary", true)).rejects.toThrow("quota exceeded");
      expect(mod.getFeatureFlagOverrides()).toEqual({});
      expect(mod.getFlag("canary")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("serializes durable writes so a superseded persist can't clobber a newer one", async () => {
    // Durable Tauri path: a fake store records what actually gets written. Even
    // with the first save artificially slow, the older (superseded) write must
    // short-circuit rather than land last and leave stale overrides on disk.
    mocks.isTauri.mockReturnValue(true);
    const saved: Array<Record<string, boolean>> = [];
    const store = {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn((_key: string, value: { state: { overrides: Record<string, boolean> } }) => {
        saved.push(value.state.overrides);
        return Promise.resolve();
      }),
      save: vi.fn().mockResolvedValue(undefined),
    };
    mocks.load.mockResolvedValue(store);

    const { persistOverrides } = await import("./store");
    await Promise.all([
      persistOverrides({ canary: false }, 1),
      persistOverrides({ canary: true }, 2),
    ]);

    // Only the newest write reaches disk; the superseded one short-circuited.
    expect(saved).toEqual([{ canary: true }]);
  });

  it("useFlag returns the default then re-renders when an override is set", async () => {
    const mod = await import("./index");
    const { result } = renderHook(() => mod.useFlag("canary"));
    expect(result.current).toBe(false);
    await act(async () => {
      await mod.setFeatureFlagOverride("canary", true);
    });
    expect(result.current).toBe(true);
  });
});
