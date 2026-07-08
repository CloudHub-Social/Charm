import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/react";
import { closeSentry, initializeSentry, observabilityTestHooks } from "./instrument";
import { DEFAULT_OBSERVABILITY_SETTINGS } from "./settings";

const clientOptions = { enabled: true };
const client = {
  getOptions: vi.fn(() => clientOptions),
};

vi.mock("@sentry/react", () => ({
  browserTracingIntegration: vi.fn(() => ({ name: "BrowserTracing" })),
  replayIntegration: vi.fn(() => ({ name: "Replay" })),
  replayCanvasIntegration: vi.fn(() => ({ name: "ReplayCanvas" })),
  browserProfilingIntegration: vi.fn(() => ({ name: "BrowserProfiling" })),
  consoleLoggingIntegration: vi.fn(() => ({ name: "ConsoleLogging" })),
  init: vi.fn(),
  setTag: vi.fn(),
  getClient: vi.fn(() => client),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("VITE_SENTRY_DSN", "https://public@example.invalid/1");
  clientOptions.enabled = true;
  observabilityTestHooks.reset();
});

describe("Sentry instrumentation", () => {
  it("toggles the existing client instead of initializing twice", async () => {
    const enabledSettings = {
      ...DEFAULT_OBSERVABILITY_SETTINGS,
      sentryEnabled: true,
    };

    expect(initializeSentry(enabledSettings)).toBe(true);
    expect(Sentry.init).toHaveBeenCalledTimes(1);

    await closeSentry();
    expect(clientOptions.enabled).toBe(false);

    expect(initializeSentry(enabledSettings)).toBe(true);
    expect(clientOptions.enabled).toBe(true);
    expect(Sentry.init).toHaveBeenCalledTimes(1);
  });
});
