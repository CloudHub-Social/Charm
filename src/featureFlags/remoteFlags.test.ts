import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  getClient: vi.fn(() => undefined),
  load: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("@/lib/platform", () => ({ isTauri: () => mocks.isTauri() }));
vi.mock("@sentry/react", () => ({ getClient: () => mocks.getClient() }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: (...args: unknown[]) => mocks.load(...args),
}));
vi.mock("@/lib/matrixTransport", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

beforeEach(async () => {
  localStorage.clear();
  vi.resetModules();
  mocks.isTauri.mockReturnValue(false);
  mocks.load.mockReset().mockRejectedValue(new Error("store unavailable"));
  mocks.invoke.mockReset().mockRejectedValue(new Error("no ipc"));
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
    // Tauri path fetches via the Rust IPC command.
    mocks.invoke.mockResolvedValue({ flags: [{ key: "canary", value: true }] });
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

  it("immediately reconciles native search storage when remote disables it", async () => {
    vi.stubEnv("VITE_CHARM_OFREP_URL", "https://flags.example.com");
    mocks.isTauri.mockReturnValue(true);
    mocks.load.mockResolvedValue({
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      save: vi.fn().mockResolvedValue(undefined),
    });
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "fetch_remote_flags") {
        return Promise.resolve({
          flags: [{ key: "encrypted_local_message_search", value: false }],
        });
      }
      if (command === "reconcile_message_search_flag") return Promise.resolve(undefined);
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });

    const mod = await import("./index");
    mod.featureFlagTestHooks.setRemoteCache({ encrypted_local_message_search: true });
    await mod.refreshRemoteFlags();

    expect(mod.getFlag("encrypted_local_message_search")).toBe(false);
    expect(mocks.invoke).toHaveBeenCalledWith("reconcile_message_search_flag");
  });
});

describe("message search reconciliation", () => {
  beforeEach(() => {
    mocks.isTauri.mockReturnValue(true);
    mocks.load.mockResolvedValue({
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      save: vi.fn().mockResolvedValue(undefined),
    });
    mocks.invoke.mockResolvedValue(undefined);
  });

  it("keeps unrelated remote flags updating when cleanup repeatedly fails", async () => {
    vi.stubEnv("VITE_CHARM_OFREP_URL", "https://flags.example.com");
    let searchEnabled = false;
    let canaryEnabled = true;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "fetch_remote_flags") {
        return Promise.resolve({
          flags: [
            { key: "encrypted_local_message_search", value: searchEnabled },
            { key: "canary", value: canaryEnabled },
          ],
        });
      }
      return Promise.reject(new Error("cleanup unavailable"));
    });
    const mod = await import("./index");
    mod.featureFlagTestHooks.setRemoteCache({ encrypted_local_message_search: true });
    await mod.refreshRemoteFlags();
    expect(mod.getFlag("encrypted_local_message_search")).toBe(false);
    expect(mod.getFlag("canary")).toBe(true);

    searchEnabled = true;
    canaryEnabled = false;
    await mod.refreshRemoteFlags();
    expect(mod.getFlag("encrypted_local_message_search")).toBe(false);
    expect(mod.getFlag("canary")).toBe(false);
    expect(localStorage.getItem("charm:featureFlagsRemote")).toContain('"canary":false');
    expect(localStorage.getItem("charm:featureFlagsRemote")).toContain(
      '"encrypted_local_message_search":false',
    );
  });

  it("reconciles a disabled-to-disabled renderer startup", async () => {
    vi.stubEnv("VITE_CHARM_OFREP_URL", "");
    const mod = await import("./index");
    await mod.initializeFeatureFlags();

    expect(mod.getFlag("encrypted_local_message_search")).toBe(false);
    expect(mocks.invoke).toHaveBeenCalledWith("reconcile_message_search_flag");
  });

  it("keeps enabled search unavailable until native startup reconciliation succeeds", async () => {
    vi.stubEnv("VITE_CHARM_OFREP_URL", "");
    localStorage.setItem(
      "charm:featureFlags",
      JSON.stringify({
        state: { overrides: { encrypted_local_message_search: true, canary: true } },
        updatedAt: Date.now(),
      }),
    );
    let rejectCleanup: ((error: Error) => void) | undefined;
    mocks.invoke.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectCleanup = reject;
        }),
    );
    const mod = await import("./index");
    const initializing = mod.initializeFeatureFlags();
    await vi.waitFor(() => expect(rejectCleanup).toBeTypeOf("function"));
    expect(mod.getFlag("encrypted_local_message_search")).toBe(false);
    expect(mod.getFlag("canary")).toBe(true);
    rejectCleanup?.(new Error("cleanup pending"));
    await initializing;
    expect(mod.getFlag("encrypted_local_message_search")).toBe(false);
    expect(mod.getFeatureFlagOverrides().encrypted_local_message_search).toBe(true);

    mocks.invoke.mockResolvedValue(undefined);
    await mod.setFeatureFlagOverride("encrypted_local_message_search", true);
    expect(mod.getFlag("encrypted_local_message_search")).toBe(true);
    expect(
      mocks.invoke.mock.calls.filter(([name]) => name === "reconcile_message_search_flag"),
    ).toHaveLength(2);
  });

  it("does not persist a re-enable until disable cleanup finishes", async () => {
    let finishCleanup: (() => void) | undefined;
    mocks.invoke.mockImplementation(
      (command: string) =>
        new Promise<void>((resolve, reject) => {
          if (command === "reconcile_message_search_flag") finishCleanup = resolve;
          else reject(new Error(`unexpected command: ${command}`));
        }),
    );

    const mod = await import("./index");
    mod.featureFlagTestHooks.setCache({ encrypted_local_message_search: true });
    const disable = mod.setFeatureFlagOverride("encrypted_local_message_search", false);
    await vi.waitFor(() => expect(finishCleanup).toBeTypeOf("function"));

    const reenable = mod.setFeatureFlagOverride("encrypted_local_message_search", true);
    expect(mod.getFeatureFlagOverrides().encrypted_local_message_search).toBe(false);

    finishCleanup?.();
    await Promise.all([disable, reenable]);
    expect(mod.getFeatureFlagOverrides().encrypted_local_message_search).toBe(true);
  });

  it("retries rejected cleanup after a renderer module reload", async () => {
    vi.stubEnv("VITE_CHARM_OFREP_URL", "");
    mocks.invoke.mockRejectedValueOnce(new Error("index locked"));

    const first = await import("./index");
    await first.initializeFeatureFlags();
    vi.resetModules();
    mocks.invoke.mockResolvedValue(undefined);

    const reloaded = await import("./index");
    await reloaded.initializeFeatureFlags();

    expect(
      mocks.invoke.mock.calls.filter(([name]) => name === "reconcile_message_search_flag"),
    ).toHaveLength(2);
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

  it("applies a cache with no recorded install id rather than clearing it", async () => {
    vi.useFakeTimers();
    vi.stubEnv("VITE_CHARM_OFREP_URL", "https://flags.example.com");
    // No `installId` field (e.g. an intermediate build's cache) — must not be
    // treated as a different cohort and cleared.
    localStorage.setItem(
      "charm:featureFlagsRemote",
      JSON.stringify({ state: { remote: { canary: true } }, updatedAt: 3 }),
    );
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    const mod = await import("./index");
    await mod.initializeFeatureFlags();
    expect(mod.getFlag("canary")).toBe(true);
  });

  it("keeps the cached remote if the stale-clear durable save fails (JS matches the file Rust reads)", async () => {
    vi.useFakeTimers();
    vi.stubEnv("VITE_CHARM_OFREP_URL", "https://flags.example.com");
    localStorage.setItem("charm:featureFlagsInstallId", "new-install");
    mocks.isTauri.mockReturnValue(true);
    mocks.load.mockResolvedValue({
      get: vi.fn(async (key: string) =>
        key === "featureFlagsRemote"
          ? { state: { remote: { canary: true } }, updatedAt: 9, installId: "old-install" }
          : undefined,
      ),
      set: vi.fn().mockResolvedValue(undefined),
      save: vi.fn().mockRejectedValue(new Error("disk full")),
      reload: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    const mod = await import("./index");
    await mod.initializeFeatureFlags();
    // The clear failed to persist, so the file still holds the old value; JS
    // keeps showing it too rather than diverging to defaults.
    expect(mod.getFlag("canary")).toBe(true);
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
