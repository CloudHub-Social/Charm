import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/react";
import packageJson from "../../package.json";
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
  on: vi.fn(),
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
  vi.unstubAllEnvs();
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
