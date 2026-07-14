import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FEATURE_FLAG_CATALOG, FEATURE_FLAG_KEYS } from "./catalog";
import { resolveFlag } from "./resolve";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  addFeatureFlag: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock("@/lib/platform", () => ({ isTauri: () => mocks.isTauri() }));

vi.mock("@sentry/react", () => ({
  getClient: () => mocks.getClient(),
}));

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  mocks.isTauri.mockReturnValue(false);
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
