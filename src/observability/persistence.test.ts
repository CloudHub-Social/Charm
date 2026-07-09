import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  OBSERVABILITY_LOCAL_STORAGE_KEY,
  persistObservabilitySettings,
  readObservabilitySettings,
} from "./persistence";
import { DEFAULT_OBSERVABILITY_SETTINGS } from "./settings";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
  load: vi.fn(),
  storeSet: vi.fn(),
  storeSave: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: (...args: unknown[]) => mocks.load(...args),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

vi.mock("@/lib/platform", () => ({
  isTauri: () => mocks.isTauri(),
}));

beforeEach(() => {
  localStorage.clear();
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.isTauri.mockReset().mockReturnValue(false);
  mocks.load.mockReset().mockRejectedValue(new Error("store unavailable"));
  mocks.storeSet.mockReset().mockResolvedValue(undefined);
  mocks.storeSave.mockReset().mockResolvedValue(undefined);
});

describe("observability persistence", () => {
  it("defaults every Sentry category off", async () => {
    await expect(readObservabilitySettings()).resolves.toEqual(DEFAULT_OBSERVABILITY_SETTINGS);
  });

  it("normalizes dependent toggles when reading", async () => {
    localStorage.setItem(
      OBSERVABILITY_LOCAL_STORAGE_KEY,
      JSON.stringify({
        state: {
          sentryEnabled: false,
          replayEnabled: true,
          canvasReplayEnabled: true,
          profilingEnabled: true,
          logsEnabled: true,
        },
        updatedAt: 1,
      }),
    );

    await expect(readObservabilitySettings()).resolves.toEqual(DEFAULT_OBSERVABILITY_SETTINGS);
  });

  it("persists a local mirror for plain-browser runs", async () => {
    await persistObservabilitySettings(
      {
        ...DEFAULT_OBSERVABILITY_SETTINGS,
        sentryEnabled: true,
        anonymousUserId: "anon-1",
      },
      42,
    );

    await expect(readObservabilitySettings()).resolves.toMatchObject({
      sentryEnabled: true,
      anonymousUserId: "anon-1",
    });
  });

  it("flushes successful store writes", async () => {
    mocks.load.mockResolvedValue({ get: vi.fn(), set: mocks.storeSet, save: mocks.storeSave });

    const settings = {
      ...DEFAULT_OBSERVABILITY_SETTINGS,
      sentryEnabled: true,
      anonymousUserId: "anon-1",
    };
    await persistObservabilitySettings(settings, 42);

    expect(mocks.load).toHaveBeenCalledWith("observability.json", {
      autoSave: false,
      defaults: {},
    });
    expect(mocks.storeSet).toHaveBeenCalledWith("observability", {
      state: settings,
      updatedAt: 42,
    });
    expect(mocks.storeSave).toHaveBeenCalledOnce();
    expect(mocks.storeSet.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.storeSave.mock.invocationCallOrder[0],
    );
  });

  it("warns when Tauri store persistence fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = new Error("store failed");
    mocks.isTauri.mockReturnValue(true);
    mocks.load.mockRejectedValue(error);

    await persistObservabilitySettings(DEFAULT_OBSERVABILITY_SETTINGS, 42);

    expect(warn).toHaveBeenCalledWith(
      "Failed to persist observability settings to the Tauri store",
      error,
    );
    warn.mockRestore();
  });

  it("does not sync log opt-ins to Rust when durable persistence fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.isTauri.mockReturnValue(true);
    mocks.load.mockRejectedValue(new Error("store failed"));

    await persistObservabilitySettings(
      {
        ...DEFAULT_OBSERVABILITY_SETTINGS,
        sentryEnabled: true,
        logsEnabled: true,
      },
      42,
    );

    expect(mocks.invoke).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("syncs log opt-outs to Rust before awaiting durable persistence", async () => {
    let resolveStoreWrite!: () => void;
    const storeWrite = new Promise<void>((resolve) => {
      resolveStoreWrite = resolve;
    });
    mocks.isTauri.mockReturnValue(true);
    mocks.load.mockResolvedValue({ set: mocks.storeSet, save: mocks.storeSave });
    mocks.storeSet.mockReturnValue(storeWrite);

    const persist = persistObservabilitySettings(
      {
        ...DEFAULT_OBSERVABILITY_SETTINGS,
        sentryEnabled: true,
        logsEnabled: false,
      },
      100,
    );

    await vi.waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("update_observability_log_consent", {
        logsEnabled: false,
      });
    });
    expect(mocks.invoke.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.storeSet.mock.invocationCallOrder[0],
    );

    resolveStoreWrite();
    await persist;
  });

  it("does not let an older opt-in overwrite a newer opt-out durable write or IPC sync", async () => {
    let resolveFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      resolveFirstWrite = resolve;
    });
    mocks.isTauri.mockReturnValue(true);
    mocks.load.mockResolvedValue({ set: mocks.storeSet, save: mocks.storeSave });
    mocks.storeSet.mockReturnValueOnce(firstWrite).mockResolvedValueOnce(undefined);

    const optIn = persistObservabilitySettings(
      {
        ...DEFAULT_OBSERVABILITY_SETTINGS,
        sentryEnabled: true,
        logsEnabled: true,
      },
      100,
    );
    await vi.waitFor(() => {
      expect(mocks.storeSet).toHaveBeenCalledTimes(1);
    });

    const optOut = persistObservabilitySettings(
      {
        ...DEFAULT_OBSERVABILITY_SETTINGS,
        sentryEnabled: true,
        logsEnabled: false,
      },
      101,
    );
    resolveFirstWrite();
    await Promise.all([optIn, optOut]);

    expect(mocks.storeSet).toHaveBeenNthCalledWith(2, "observability", {
      state: {
        ...DEFAULT_OBSERVABILITY_SETTINGS,
        sentryEnabled: true,
        logsEnabled: false,
      },
      updatedAt: 101,
    });
    expect(mocks.storeSave).toHaveBeenCalledOnce();
    expect(mocks.storeSet.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.storeSave.mock.invocationCallOrder[0],
    );
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("update_observability_log_consent", {
      logsEnabled: false,
    });
  });
});
