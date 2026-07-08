import * as Sentry from "@sentry/react";
import packageJson from "../../package.json";
import { readObservabilitySettings } from "./persistence";
import { scrubSensitiveText, scrubSentryValue } from "./scrubbers";
import { DEFAULT_OBSERVABILITY_SETTINGS, type ObservabilitySettings } from "./settings";

const MAX_ERRORS_PER_SESSION = 50;

let initialized = false;
let sentErrorCount = 0;
type FeedbackDialog = Awaited<
  ReturnType<NonNullable<ReturnType<typeof Sentry.getFeedback>>["createForm"]>
>;
let feedbackDialog: FeedbackDialog | null = null;
let feedbackDialogPromise: Promise<FeedbackDialog | null> | null = null;
let feedbackDialogGeneration = 0;
let feedbackSubmissionContext: SentryFeedbackDialogOptions = {};

export interface SentryFeedbackDialogOptions {
  associatedEventId?: string;
  surface?: "crash-fallback" | "manual" | "settings";
}

function removeFeedbackDialog(dialog: { removeFromDom?: unknown } | null | undefined): void {
  if (!dialog || typeof dialog.removeFromDom !== "function") return;
  try {
    dialog.removeFromDom();
  } catch {
    // Closing observability should not fail the settings flow.
  }
}

type SentryIntegration =
  | ReturnType<typeof Sentry.browserTracingIntegration>
  | ReturnType<typeof Sentry.replayIntegration>
  | ReturnType<typeof Sentry.replayCanvasIntegration>
  | ReturnType<typeof Sentry.browserProfilingIntegration>
  | ReturnType<typeof Sentry.consoleLoggingIntegration>
  | ReturnType<typeof Sentry.feedbackIntegration>;

function environment(): string {
  return import.meta.env.VITE_SENTRY_ENVIRONMENT || import.meta.env.MODE || "production";
}

function release(): string {
  return import.meta.env.VITE_SENTRY_RELEASE || `charm@${packageJson.version}`;
}

function sampleRate(): number {
  return environment() === "production" ? 0.5 : 1.0;
}

function integrations(settings: ObservabilitySettings): SentryIntegration[] {
  const enabledIntegrations: SentryIntegration[] = [Sentry.browserTracingIntegration()];
  if (settings.replayEnabled) {
    enabledIntegrations.push(
      Sentry.replayIntegration({
        maskAllText: true,
        blockAllMedia: true,
        maskAllInputs: true,
      }),
    );
  }
  if (settings.replayEnabled && settings.canvasReplayEnabled) {
    enabledIntegrations.push(Sentry.replayCanvasIntegration());
  }
  if (settings.profilingEnabled) {
    enabledIntegrations.push(Sentry.browserProfilingIntegration());
  }
  if (settings.logsEnabled) {
    enabledIntegrations.push(Sentry.consoleLoggingIntegration({ levels: ["error", "warn"] }));
  }
  enabledIntegrations.push(
    Sentry.feedbackIntegration({
      autoInject: false,
      enableScreenshot: true,
      showEmail: false,
      showName: false,
      showBranding: false,
      triggerLabel: "Send feedback",
      triggerAriaLabel: "Send feedback to Charm",
      formTitle: "Send feedback",
      messagePlaceholder:
        "What happened? Avoid Matrix IDs, room names, recovery keys, or other private details.",
      submitButtonLabel: "Send",
    }),
  );
  return enabledIntegrations;
}

export function initializeSentry(settings: ObservabilitySettings): boolean {
  if (!import.meta.env.VITE_SENTRY_DSN) {
    return false;
  }
  if (initialized) {
    setSentryClientEnabled(settings.sentryEnabled);
    return settings.sentryEnabled;
  }
  if (!settings.sentryEnabled) return false;

  const rate = sampleRate();
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    enabled: true,
    sendDefaultPii: false,
    release: release(),
    environment: environment(),
    tracesSampleRate: rate,
    tracePropagationTargets: ["localhost", /^https?:\/\/localhost(?::\d+)?\//],
    replaysSessionSampleRate: settings.replayEnabled ? rate : 0,
    replaysOnErrorSampleRate: settings.replayEnabled ? 1.0 : 0,
    profilesSampleRate: settings.profilingEnabled ? rate : 0,
    enableLogs: settings.logsEnabled,
    integrations: integrations(settings),
    initialScope: {
      tags: {
        platform: "webview",
      },
      user: settings.anonymousUserId ? { id: settings.anonymousUserId } : undefined,
    },
    beforeSend(event) {
      if (sentErrorCount >= MAX_ERRORS_PER_SESSION) return null;
      sentErrorCount += 1;
      return scrubSentryValue(event);
    },
    beforeBreadcrumb(breadcrumb) {
      return scrubSentryValue(breadcrumb);
    },
    beforeSendTransaction(event) {
      return scrubSentryValue(event);
    },
    beforeSendSpan(span) {
      return scrubSentryValue(span);
    },
    beforeSendLog(log) {
      if (environment() === "production" && log.level === "debug") return null;
      return scrubSentryValue(log);
    },
  });
  Sentry.getClient()?.on("beforeSendFeedback", (event) => {
    const surface = feedbackSubmissionContext.surface ?? "manual";
    event.tags = {
      ...event.tags,
      "charm.feedback.surface": surface,
      "charm.feedback.screenshot": "optional",
    };
    if (feedbackSubmissionContext.associatedEventId) {
      event.contexts.feedback.associated_event_id = feedbackSubmissionContext.associatedEventId;
    }
    Object.assign(event, scrubSentryValue(event));
  });
  Sentry.setTag("platform", "webview");
  initialized = true;
  return true;
}

function setSentryClientEnabled(enabled: boolean): void {
  const client = Sentry.getClient();
  if (!client) return;
  client.getOptions().enabled = enabled;
}

export async function bootstrapSentry(): Promise<ObservabilitySettings> {
  const settings = await readObservabilitySettings();
  initializeSentry(settings);
  return settings;
}

export async function closeSentry(): Promise<void> {
  if (!initialized) return;
  sentErrorCount = 0;
  feedbackDialogGeneration += 1;
  setSentryClientEnabled(false);
  feedbackDialogPromise = null;
  const dialog = feedbackDialog;
  feedbackDialog = null;
  removeFeedbackDialog(dialog);
}

export async function openSentryFeedbackDialog(
  options: SentryFeedbackDialogOptions = {},
): Promise<boolean> {
  const client = Sentry.getClient();
  if (!client?.getOptions().enabled) return false;

  const feedback = Sentry.getFeedback();
  if (!feedback || typeof feedback.createForm !== "function") return false;

  feedbackSubmissionContext = { ...options };
  const generation = feedbackDialogGeneration;
  if (!feedbackDialog && !feedbackDialogPromise) {
    feedbackDialogPromise = feedback
      .createForm({
        tags: {
          "charm.feedback.surface": options.surface ?? "manual",
          "charm.feedback.screenshot": "optional",
        },
      })
      .then((dialog) => {
        if (generation !== feedbackDialogGeneration || !Sentry.getClient()?.getOptions().enabled) {
          dialog?.removeFromDom?.();
          return null;
        }
        if (
          !dialog ||
          typeof dialog.appendToDom !== "function" ||
          typeof dialog.open !== "function" ||
          typeof dialog.removeFromDom !== "function"
        ) {
          return null;
        }
        if (generation !== feedbackDialogGeneration || !Sentry.getClient()?.getOptions().enabled) {
          removeFeedbackDialog(dialog);
          return null;
        }
        try {
          dialog.appendToDom();
        } catch {
          removeFeedbackDialog(dialog);
          return null;
        }
        return dialog;
      })
      .catch(() => null)
      .finally(() => {
        if (generation === feedbackDialogGeneration) {
          feedbackDialogPromise = null;
        }
      });
  }

  const dialog = feedbackDialog ?? (await feedbackDialogPromise);
  if (generation !== feedbackDialogGeneration || !client.getOptions().enabled) {
    removeFeedbackDialog(dialog);
    return false;
  }
  feedbackDialog = dialog;
  if (!feedbackDialog) return false;

  try {
    feedbackDialog.open();
  } catch {
    removeFeedbackDialog(feedbackDialog);
    feedbackDialog = null;
    return false;
  }
  return true;
}

export const observabilityTestHooks = {
  reset() {
    initialized = false;
    sentErrorCount = 0;
    feedbackDialog = null;
    feedbackDialogPromise = null;
    feedbackDialogGeneration = 0;
    feedbackSubmissionContext = {};
  },
  scrubSensitiveText,
  defaultSettings: DEFAULT_OBSERVABILITY_SETTINGS,
};
