import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/react";
import packageJson from "../../package.json";
import * as platformModule from "../lib/platform";
import {
  bootstrapSentryWithTimeout,
  closeSentry,
  initializeSentry,
  observabilityTestHooks,
  openSentryFeedbackDialog,
} from "./instrument";
import * as persistenceModule from "./persistence";
import { DEFAULT_OBSERVABILITY_SETTINGS, type ObservabilitySettings } from "./settings";

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
  on: vi.fn(),
};

vi.mock("../lib/platform", () => ({
  platformTag: vi.fn(() => "web"),
  preloadPlatformTag: vi.fn(() => Promise.resolve("web")),
}));

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
  metrics: {
    count: vi.fn(),
    gauge: vi.fn(),
    distribution: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("VITE_SENTRY_DSN", "https://public@example.invalid/1");
  clientOptions.enabled = true;
  observabilityTestHooks.reset();
  vi.mocked(platformModule.platformTag).mockReturnValue("web");
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

  it("tags events with charm.build.id from VITE_BUILD_ID (Spec 24)", () => {
    vi.stubEnv("VITE_BUILD_ID", "0.4.2+pr187.a1b2c3d");

    initializeSentry({
      ...DEFAULT_OBSERVABILITY_SETTINGS,
      sentryEnabled: true,
    });

    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        initialScope: expect.objectContaining({
          tags: expect.objectContaining({ "charm.build.id": "0.4.2+pr187.a1b2c3d" }),
        }),
      }),
    );
    expect(Sentry.setTag).toHaveBeenCalledWith("charm.build.id", "0.4.2+pr187.a1b2c3d");
  });

  it("falls back to the package version for charm.build.id when VITE_BUILD_ID is unset", () => {
    initializeSentry({
      ...DEFAULT_OBSERVABILITY_SETTINGS,
      sentryEnabled: true,
    });

    expect(Sentry.setTag).toHaveBeenCalledWith("charm.build.id", packageJson.version);
  });

  it("tags events with charm.build.version from the package version", () => {
    initializeSentry({
      ...DEFAULT_OBSERVABILITY_SETTINGS,
      sentryEnabled: true,
    });

    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        initialScope: expect.objectContaining({
          tags: expect.objectContaining({ "charm.build.version": packageJson.version }),
        }),
      }),
    );
    expect(Sentry.setTag).toHaveBeenCalledWith("charm.build.version", packageJson.version);
  });

  it("trims trailing slashes from VITE_CHARM_WEB_API_BASE_URL before adding it to tracePropagationTargets", () => {
    vi.stubEnv("VITE_CHARM_WEB_API_BASE_URL", "https://example.com/charm///");

    initializeSentry({
      ...DEFAULT_OBSERVABILITY_SETTINGS,
      sentryEnabled: true,
    });

    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        tracePropagationTargets: expect.arrayContaining(["https://example.com/charm"]),
      }),
    );
  });

  it("falls back to window.location.origin when VITE_CHARM_WEB_API_BASE_URL is unset", () => {
    initializeSentry({
      ...DEFAULT_OBSERVABILITY_SETTINGS,
      sentryEnabled: true,
    });

    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        tracePropagationTargets: expect.arrayContaining([window.location.origin]),
      }),
    );
  });

  it("tags events with the real per-OS charm.platform value (Spec 23)", () => {
    vi.mocked(platformModule.platformTag).mockReturnValue("macos");

    initializeSentry({
      ...DEFAULT_OBSERVABILITY_SETTINGS,
      sentryEnabled: true,
    });

    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        initialScope: expect.objectContaining({
          tags: expect.objectContaining({ "charm.platform": "macos" }),
        }),
      }),
    );
    expect(Sentry.setTag).toHaveBeenCalledWith("charm.platform", "macos");
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
    await expect(
      openSentryFeedbackDialog({
        associatedEventId: "event-123",
        surface: "crash-fallback",
      }),
    ).resolves.toBe(true);

    expect(feedbackIntegration.createForm).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: expect.objectContaining({
          "charm.feedback.surface": "crash-fallback",
          "charm.feedback.screenshot": "optional",
        }),
      }),
    );
    expect(feedbackDialog.appendToDom).toHaveBeenCalledTimes(1);
    expect(feedbackDialog.open).toHaveBeenCalledTimes(1);
  });

  it("scrubs feedback events and associates crash feedback with the captured event", async () => {
    initializeSentry({
      ...DEFAULT_OBSERVABILITY_SETTINGS,
      sentryEnabled: true,
    });

    await openSentryFeedbackDialog({
      associatedEventId: "event-123",
      surface: "crash-fallback",
    });

    type FeedbackHook = (event: {
      tags?: Record<string, string>;
      contexts?: {
        feedback?: {
          associated_event_id?: string;
          message: string;
        };
      };
    }) => void;
    const beforeSendFeedback = client.on.mock.calls.find(
      ([hook]) => hook === "beforeSendFeedback",
    )?.[1] as FeedbackHook | undefined;
    expect(beforeSendFeedback).toBeDefined();

    const event = {
      contexts: {
        feedback: {
          message: "Crash in !room:example.org with access_token=secret",
        },
      },
      tags: {},
    };
    beforeSendFeedback?.(event);

    expect(event.contexts.feedback).toEqual(
      expect.objectContaining({
        associated_event_id: "event-123",
        message: "Crash in ![redacted]:[redacted] with access_token=[redacted]",
      }),
    );
    expect(event.tags).toEqual(
      expect.objectContaining({
        "charm.feedback.surface": "crash-fallback",
        "charm.feedback.screenshot": "optional",
      }),
    );

    expect(() => beforeSendFeedback?.({})).not.toThrow();
  });

  it.each([
    ["bug", "bug"],
    ["feature_request", "feature_request"],
  ] as const)(
    "tags submissions with charm.feedback.category=%s when %s is selected",
    async (category, expectedTag) => {
      initializeSentry({
        ...DEFAULT_OBSERVABILITY_SETTINGS,
        sentryEnabled: true,
      });

      await openSentryFeedbackDialog({ surface: "settings", category });

      expect(feedbackIntegration.createForm).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: expect.objectContaining({
            "charm.feedback.category": expectedTag,
          }),
        }),
      );

      type FeedbackHook = (event: { tags?: Record<string, string> }) => void;
      const beforeSendFeedback = client.on.mock.calls.find(
        ([hook]) => hook === "beforeSendFeedback",
      )?.[1] as FeedbackHook | undefined;
      expect(beforeSendFeedback).toBeDefined();

      const event = { tags: {} };
      beforeSendFeedback?.(event);

      expect(event.tags).toEqual(
        expect.objectContaining({
          "charm.feedback.category": expectedTag,
        }),
      );
    },
  );

  it("omits the category tag when no category was provided", async () => {
    initializeSentry({
      ...DEFAULT_OBSERVABILITY_SETTINGS,
      sentryEnabled: true,
    });

    await openSentryFeedbackDialog({ surface: "settings" });

    type FeedbackHook = (event: { tags?: Record<string, string> }) => void;
    const beforeSendFeedback = client.on.mock.calls.find(
      ([hook]) => hook === "beforeSendFeedback",
    )?.[1] as FeedbackHook | undefined;

    const event = { tags: {} };
    beforeSendFeedback?.(event);

    expect(event.tags).not.toHaveProperty("charm.feedback.category");
  });

  it("replaces an existing feedback dialog before creating the next one", async () => {
    await expect(openSentryFeedbackDialog()).resolves.toBe(true);
    await expect(openSentryFeedbackDialog()).resolves.toBe(true);

    expect(feedbackIntegration.createForm).toHaveBeenCalledTimes(2);
    expect(feedbackDialog.removeFromDom).toHaveBeenCalledTimes(1);
    expect(feedbackDialog.appendToDom).toHaveBeenCalledTimes(2);
    expect(feedbackDialog.open).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight feedback dialog creation across concurrent opens", async () => {
    let resolveForm!: (dialog: typeof feedbackDialog) => void;
    feedbackIntegration.createForm.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveForm = resolve;
      }),
    );

    const first = openSentryFeedbackDialog();
    const second = openSentryFeedbackDialog();
    resolveForm(feedbackDialog);

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(feedbackIntegration.createForm).toHaveBeenCalledTimes(1);
    expect(feedbackDialog.appendToDom).toHaveBeenCalledTimes(1);
    expect(feedbackDialog.open).toHaveBeenCalledTimes(2);
  });

  it("does not share an in-flight feedback dialog across different metadata", async () => {
    let resolveForm!: (dialog: typeof feedbackDialog) => void;
    feedbackIntegration.createForm.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveForm = resolve;
      }),
    );

    const first = openSentryFeedbackDialog({
      associatedEventId: "event-123",
      surface: "crash-fallback",
    });
    const second = openSentryFeedbackDialog({ surface: "settings" });
    resolveForm(feedbackDialog);

    await expect(Promise.all([first, second])).resolves.toEqual([true, false]);
    expect(feedbackIntegration.createForm).toHaveBeenCalledTimes(1);
    expect(feedbackDialog.appendToDom).toHaveBeenCalledTimes(1);
    expect(feedbackDialog.open).toHaveBeenCalledTimes(1);
  });

  it("does not share an in-flight feedback dialog across different categories", async () => {
    let resolveForm!: (dialog: typeof feedbackDialog) => void;
    feedbackIntegration.createForm.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveForm = resolve;
      }),
    );

    const first = openSentryFeedbackDialog({ surface: "settings", category: "bug" });
    const second = openSentryFeedbackDialog({ surface: "settings", category: "feature_request" });
    resolveForm(feedbackDialog);

    await expect(Promise.all([first, second])).resolves.toEqual([true, false]);
    expect(feedbackIntegration.createForm).toHaveBeenCalledTimes(1);
    expect(feedbackDialog.appendToDom).toHaveBeenCalledTimes(1);
    expect(feedbackDialog.open).toHaveBeenCalledTimes(1);
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

  it("ignores feedback dialog cleanup failures when Sentry is closed", async () => {
    initializeSentry({
      ...DEFAULT_OBSERVABILITY_SETTINGS,
      sentryEnabled: true,
    });
    await openSentryFeedbackDialog();
    feedbackDialog.removeFromDom.mockImplementationOnce(() => {
      throw new Error("cleanup failed");
    });

    await expect(closeSentry()).resolves.toBeUndefined();
  });

  it("returns false when the Feedback SDK returns an incomplete dialog", async () => {
    const incompleteDialog = {
      appendToDom: vi.fn(),
      removeFromDom: vi.fn(),
    };
    feedbackIntegration.createForm.mockResolvedValueOnce(
      incompleteDialog as unknown as typeof feedbackDialog,
    );

    await expect(openSentryFeedbackDialog()).resolves.toBe(false);

    expect(feedbackDialog.open).not.toHaveBeenCalled();
    expect(incompleteDialog.removeFromDom).toHaveBeenCalledTimes(1);
  });

  it("does not show an in-flight feedback dialog after Sentry is closed", async () => {
    initializeSentry({
      ...DEFAULT_OBSERVABILITY_SETTINGS,
      sentryEnabled: true,
    });
    let resolveForm!: (dialog: typeof feedbackDialog) => void;
    feedbackIntegration.createForm.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveForm = resolve;
      }),
    );

    const open = openSentryFeedbackDialog();
    await closeSentry();
    resolveForm(feedbackDialog);

    await expect(open).resolves.toBe(false);
    expect(feedbackDialog.appendToDom).not.toHaveBeenCalled();
    expect(feedbackDialog.open).not.toHaveBeenCalled();
    expect(feedbackDialog.removeFromDom).toHaveBeenCalledTimes(1);
  });

  it("does not open feedback when the Sentry client is disabled", async () => {
    clientOptions.enabled = false;

    await expect(openSentryFeedbackDialog()).resolves.toBe(false);

    expect(feedbackIntegration.createForm).not.toHaveBeenCalled();
  });

  it("returns false when the Feedback SDK cannot create the form", async () => {
    feedbackIntegration.createForm.mockRejectedValueOnce(new Error("unsupported"));

    await expect(openSentryFeedbackDialog()).resolves.toBe(false);

    expect(feedbackDialog.appendToDom).not.toHaveBeenCalled();
    expect(feedbackDialog.open).not.toHaveBeenCalled();
  });

  it("returns false when the Feedback SDK throws while creating the form", async () => {
    feedbackIntegration.createForm.mockImplementationOnce(() => {
      throw new Error("unsupported");
    });

    await expect(openSentryFeedbackDialog()).resolves.toBe(false);

    expect(feedbackDialog.appendToDom).not.toHaveBeenCalled();
    expect(feedbackDialog.open).not.toHaveBeenCalled();
  });
});

describe("bootstrapSentryWithTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the settings once the underlying bootstrap finishes before the timeout", async () => {
    const settings = { ...DEFAULT_OBSERVABILITY_SETTINGS, sentryEnabled: true };
    vi.spyOn(persistenceModule, "readObservabilitySettings").mockResolvedValue(settings);

    await expect(bootstrapSentryWithTimeout(3000)).resolves.toEqual(settings);
  });

  it("resolves with null instead of hanging forever when the settings read never resolves (2026-07-13 blank-page regression)", async () => {
    vi.useFakeTimers();
    // Simulates a stuck Tauri IPC round-trip (e.g. plugin-store's `load()`
    // never calling back) — the exact failure mode that left the app
    // permanently blank, since `main.tsx` previously gated its first render
    // on this promise with no timeout at all.
    vi.spyOn(persistenceModule, "readObservabilitySettings").mockReturnValue(
      new Promise(() => {
        // Never resolves.
      }),
    );

    const result = bootstrapSentryWithTimeout(3000);
    await vi.advanceTimersByTimeAsync(3000);

    await expect(result).resolves.toBeNull();
  });

  it("does not initialize Sentry when the timeout wins the race", async () => {
    vi.useFakeTimers();
    vi.spyOn(persistenceModule, "readObservabilitySettings").mockReturnValue(
      new Promise(() => {
        // Never resolves.
      }),
    );

    const result = bootstrapSentryWithTimeout(3000);
    await vi.advanceTimersByTimeAsync(3000);
    await result;

    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it("never initializes Sentry from a settings read that resolves after the timeout already gave up", async () => {
    // A *slow* read (unlike the permanently-hung case above) still resolves
    // eventually — if it could reach `initializeSentry` after losing the
    // race, a user who opened Settings and disabled Sentry in that window
    // would find it silently re-enabled once this stale read landed.
    vi.useFakeTimers();
    let resolveSettings!: (settings: ObservabilitySettings) => void;
    vi.spyOn(persistenceModule, "readObservabilitySettings").mockReturnValue(
      new Promise((resolve) => {
        resolveSettings = resolve;
      }),
    );

    const result = bootstrapSentryWithTimeout(3000);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(result).resolves.toBeNull();

    resolveSettings({ ...DEFAULT_OBSERVABILITY_SETTINGS, sentryEnabled: true });
    await vi.runOnlyPendingTimersAsync();

    expect(Sentry.init).not.toHaveBeenCalled();
  });
});
