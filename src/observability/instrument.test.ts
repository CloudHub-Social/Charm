import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/react";
import {
  closeSentry,
  initializeSentry,
  observabilityTestHooks,
  openSentryFeedbackDialog,
} from "./instrument";
import { DEFAULT_OBSERVABILITY_SETTINGS } from "./settings";

const clientOptions = { enabled: true };
const feedbackDialog = {
  appendToDom: vi.fn(),
  open: vi.fn(),
  removeFromDom: vi.fn(),
};
const feedbackIntegration = {
  name: "Feedback",
  createForm: vi.fn(async () => feedbackDialog),
};
const client = {
  getOptions: vi.fn(() => clientOptions),
};

vi.mock("@sentry/react", () => ({
  browserTracingIntegration: vi.fn(() => ({ name: "BrowserTracing" })),
  replayIntegration: vi.fn(() => ({ name: "Replay" })),
  replayCanvasIntegration: vi.fn(() => ({ name: "ReplayCanvas" })),
  browserProfilingIntegration: vi.fn(() => ({ name: "BrowserProfiling" })),
  consoleLoggingIntegration: vi.fn(() => ({ name: "ConsoleLogging" })),
  feedbackIntegration: vi.fn(() => feedbackIntegration),
  init: vi.fn(),
  setTag: vi.fn(),
  getClient: vi.fn(() => client),
  getFeedback: vi.fn(() => feedbackIntegration),
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

  it("registers the feedback integration without auto-injecting Sentry UI", () => {
    initializeSentry({
      ...DEFAULT_OBSERVABILITY_SETTINGS,
      sentryEnabled: true,
    });

    expect(Sentry.feedbackIntegration).toHaveBeenCalledWith(
      expect.objectContaining({
        autoInject: false,
        enableScreenshot: true,
        showEmail: false,
        showName: false,
      }),
    );
  });

  it("opens the screenshot-capable feedback dialog when the client is enabled", async () => {
    await expect(openSentryFeedbackDialog()).resolves.toBe(true);

    expect(feedbackIntegration.createForm).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: expect.objectContaining({
          "charm.feedback.surface": "manual",
          "charm.feedback.screenshot": "optional",
        }),
      }),
    );
    expect(feedbackDialog.appendToDom).toHaveBeenCalledTimes(1);
    expect(feedbackDialog.open).toHaveBeenCalledTimes(1);
  });

  it("reuses an existing feedback dialog instead of appending duplicates", async () => {
    await expect(openSentryFeedbackDialog()).resolves.toBe(true);
    await expect(openSentryFeedbackDialog()).resolves.toBe(true);

    expect(feedbackIntegration.createForm).toHaveBeenCalledTimes(1);
    expect(feedbackDialog.appendToDom).toHaveBeenCalledTimes(1);
    expect(feedbackDialog.open).toHaveBeenCalledTimes(2);
  });

  it("removes the feedback dialog when Sentry is closed", async () => {
    initializeSentry({
      ...DEFAULT_OBSERVABILITY_SETTINGS,
      sentryEnabled: true,
    });
    await openSentryFeedbackDialog();
    await closeSentry();

    expect(feedbackDialog.removeFromDom).toHaveBeenCalledTimes(1);
  });

  it("does not open feedback when the Sentry client is disabled", async () => {
    clientOptions.enabled = false;

    await expect(openSentryFeedbackDialog()).resolves.toBe(false);

    expect(feedbackIntegration.createForm).not.toHaveBeenCalled();
  });
});
