import * as Sentry from "@sentry/react";
import packageJson from "../../package.json";
import { readObservabilitySettings } from "./persistence";
import { scrubSensitiveText, scrubSentryValue } from "./scrubbers";
import { DEFAULT_OBSERVABILITY_SETTINGS, type ObservabilitySettings } from "./settings";

const MAX_ERRORS_PER_SESSION = 50;

let initialized = false;
let closedForSession = false;
let sentErrorCount = 0;

type SentryIntegration =
  | ReturnType<typeof Sentry.browserTracingIntegration>
  | ReturnType<typeof Sentry.replayIntegration>
  | ReturnType<typeof Sentry.replayCanvasIntegration>
  | ReturnType<typeof Sentry.browserProfilingIntegration>
  | ReturnType<typeof Sentry.consoleLoggingIntegration>;

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
  return enabledIntegrations;
}

export function initializeSentry(settings: ObservabilitySettings): boolean {
  if (
    initialized ||
    closedForSession ||
    !settings.sentryEnabled ||
    !import.meta.env.VITE_SENTRY_DSN
  ) {
    return false;
  }

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
  Sentry.setTag("platform", "webview");
  initialized = true;
  return true;
}

export async function bootstrapSentry(): Promise<ObservabilitySettings> {
  const settings = await readObservabilitySettings();
  initializeSentry(settings);
  return settings;
}

export async function closeSentry(): Promise<void> {
  if (!initialized || closedForSession) return;
  closedForSession = true;
  sentErrorCount = 0;
  await Sentry.close(2_000);
}

export const observabilityTestHooks = {
  reset() {
    initialized = false;
    closedForSession = false;
    sentErrorCount = 0;
  },
  scrubSensitiveText,
  defaultSettings: DEFAULT_OBSERVABILITY_SETTINGS,
};
