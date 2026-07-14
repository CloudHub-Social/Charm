import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  getClient: vi.fn(() => undefined),
  load: vi.fn(),
}));

vi.mock("@/lib/platform", () => ({ isTauri: () => mocks.isTauri() }));
vi.mock("@sentry/react", () => ({ getClient: () => mocks.getClient() }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: (...args: unknown[]) => mocks.load(...args),
}));

beforeEach(async () => {
  localStorage.clear();
  vi.resetModules();
  mocks.isTauri.mockReturnValue(false);
  mocks.load.mockReset().mockRejectedValue(new Error("store unavailable"));
  const { featureFlagTestHooks } = await import("./index");
  featureFlagTestHooks.reset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("remote layer resolution", () => {
  it("uses the remote value when there is no override", async () => {
    const mod = await import("./index");
    mod.featureFlagTestHooks.setRemoteCache({ canary: true });
    expect(mod.getFlag("canary")).toBe(true);
  });

  it("lets a local override beat remote", async () => {
    const mod = await import("./index");
    mod.featureFlagTestHooks.setRemoteCache({ canary: true });
    await mod.setFeatureFlagOverride("canary", false);
    expect(mod.getFlag("canary")).toBe(false);
  });
});

describe("refreshRemoteFlags", () => {
  it("fetches, applies, and caches remote evaluations", async () => {
    vi.stubEnv("VITE_CHARM_OFREP_URL", "https://flags.example.com");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ flags: [{ key: "canary", value: true }] }),
      }),
    );
    const mod = await import("./index");
    await mod.refreshRemoteFlags();
    expect(mod.getFlag("canary")).toBe(true);
    // Cached to the remote localStorage mirror for the next launch.
    expect(localStorage.getItem("charm:featureFlagsRemote")).toContain("canary");
  });

  it("is a no-op when no endpoint is configured", async () => {
    vi.stubEnv("VITE_CHARM_OFREP_URL", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("./index");
    await mod.refreshRemoteFlags();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mod.getFlag("canary")).toBe(false);
  });

  it("keeps the last-known-good cache when a refresh fails (fail-open)", async () => {
    vi.stubEnv("VITE_CHARM_OFREP_URL", "https://flags.example.com");
    const mod = await import("./index");
    mod.featureFlagTestHooks.setRemoteCache({ canary: true });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await mod.refreshRemoteFlags();
    expect(mod.getFlag("canary")).toBe(true); // previous cache stands
  });

  it("does not apply remote values when the durable Tauri save fails", async () => {
    vi.stubEnv("VITE_CHARM_OFREP_URL", "https://flags.example.com");
    mocks.isTauri.mockReturnValue(true);
    const reload = vi.fn().mockResolvedValue(undefined);
    const del = vi.fn().mockResolvedValue(undefined);
    mocks.load.mockResolvedValue({
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      save: vi.fn().mockRejectedValue(new Error("disk full")),
      reload,
      delete: del,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ flags: [{ key: "canary", value: true }] }),
      }),
    );
    const mod = await import("./index");
    await mod.refreshRemoteFlags();
    // Durable write failed → the frontend must stay consistent with the file
    // Rust reads (default), not the not-yet-persisted remote value.
    expect(mod.getFlag("canary")).toBe(false);
    // And the localStorage mirror must not be written either, or it would win
    // (newer timestamp) on the next launch and diverge from the durable file.
    expect(localStorage.getItem("charm:featureFlagsRemote")).toBeNull();
    // The in-memory store is rolled back — reload() plus an explicit delete of
    // the unsaved key (reload merges and won't drop it), so the failed remote
    // value can't be flushed to disk by a later override save.
    expect(reload).toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith("featureFlagsRemote");
  });
});

describe("remote cache when no endpoint is configured", () => {
  it("ignores and clears a stale cache so the layer is inert", async () => {
    vi.stubEnv("VITE_CHARM_OFREP_URL", "");
    localStorage.setItem(
      "charm:featureFlagsRemote",
      JSON.stringify({ state: { remote: { canary: true } }, updatedAt: 1 }),
    );
    const mod = await import("./index");
    await mod.initializeFeatureFlags();
    expect(mod.getFlag("canary")).toBe(false);
    // Stale cache cleared from the durable mirror (so the Rust core also ignores it).
    expect(
      JSON.parse(localStorage.getItem("charm:featureFlagsRemote") ?? "{}").state.remote,
    ).toEqual({});
  });

  it("does not mint a durable install id when no endpoint is configured", async () => {
    vi.stubEnv("VITE_CHARM_OFREP_URL", "");
    const mod = await import("./index");
    await mod.initializeFeatureFlags();
    // No OFREP request can happen, so no per-install identifier should exist.
    expect(localStorage.getItem("charm:featureFlagsInstallId")).toBeNull();
  });
});

describe("remote cache install-id binding", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores a cached cohort computed for a different install id", async () => {
    vi.useFakeTimers();
    vi.stubEnv("VITE_CHARM_OFREP_URL", "https://flags.example.com");
    // Cache says canary on, but was computed for a different install id (e.g.
    // localStorage install id was cleared/rotated while the file survived).
    localStorage.setItem(
      "charm:featureFlagsRemote",
      JSON.stringify({
        state: { remote: { canary: true } },
        updatedAt: 5,
        installId: "old-install",
      }),
    );
    localStorage.setItem("charm:featureFlagsInstallId", "new-install");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    const mod = await import("./index");
    await mod.initializeFeatureFlags();
    // Mismatched cohort must not apply — falls through to the catalog default.
    expect(mod.getFlag("canary")).toBe(false);
  });
});

describe("initializeFeatureFlags", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("seeds caches and starts the remote refresh loop when configured", async () => {
    vi.useFakeTimers();
    vi.stubEnv("VITE_CHARM_OFREP_URL", "https://flags.example.com");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ flags: [{ key: "canary", value: true }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("./index");
    await mod.initializeFeatureFlags();
    // startRemoteRefresh kicked an immediate fetch; let its microtasks settle.
    await vi.runOnlyPendingTimersAsync();

    expect(fetchMock).toHaveBeenCalled();
    expect(mod.getFlag("canary")).toBe(true);
  });
});
