import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  OBSERVABILITY_LOCAL_STORAGE_KEY,
  persistObservabilitySettings,
  readObservabilitySettings,
} from "./persistence";
import { DEFAULT_OBSERVABILITY_SETTINGS } from "./settings";

const load = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-store", () => ({
  load: (...args: unknown[]) => load(...args),
}));

beforeEach(() => {
  localStorage.clear();
  load.mockReset().mockRejectedValue(new Error("store unavailable"));
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
    const storeSet = vi.fn().mockResolvedValue(undefined);
    const storeSave = vi.fn().mockResolvedValue(undefined);
    load.mockResolvedValue({ get: vi.fn(), set: storeSet, save: storeSave });

    const settings = {
      ...DEFAULT_OBSERVABILITY_SETTINGS,
      sentryEnabled: true,
      anonymousUserId: "anon-1",
    };
    await persistObservabilitySettings(settings, 42);

    expect(storeSet).toHaveBeenCalledWith("observability", { state: settings, updatedAt: 42 });
    expect(storeSave).toHaveBeenCalledOnce();
    expect(storeSet.mock.invocationCallOrder[0]).toBeLessThan(
      storeSave.mock.invocationCallOrder[0],
    );
  });
});
