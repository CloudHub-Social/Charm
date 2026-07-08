import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  OBSERVABILITY_LOCAL_STORAGE_KEY,
  persistObservabilitySettings,
  readObservabilitySettings,
} from "./persistence";
import { DEFAULT_OBSERVABILITY_SETTINGS } from "./settings";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn().mockRejectedValue(new Error("store unavailable")),
}));

beforeEach(() => {
  localStorage.clear();
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
});
