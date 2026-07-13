import * as Sentry from "@sentry/react";
import packageJson from "../../package.json";
import { getBuildId } from "../lib/buildId";
import { isTauri, platformTag, preloadPlatformTag } from "../lib/platform";
import { recordCount } from "./metrics";
import { readObservabilitySettings } from "./persistence";
import { scrubSensitiveText, scrubSentryValue } from "./scrubbers";
import { DEFAULT_OBSERVABILITY_SETTINGS, type ObservabilitySettings } from "./settings";

type BaseTransportOptions = Parameters<typeof Sentry.createTransport>[0];

/**
 * Encodes an envelope body (which for replay/profiling attachments is binary,
 * not just text) as base64 for the Tauri IPC bridge — `invoke` arguments are
 * JSON-encoded, so they can't carry arbitrary bytes directly.
 */
function encodeEnvelopeBody(body: string | Uint8Array): string {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  // Builds an array of chars and joins once, rather than repeated `+=` in a
  // loop (O(n²) in the worst case for large replay/profiling envelopes,
  // which can run several megabytes).
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary);
}

/**
 * Routes every outgoing Sentry envelope (errors, sessions, replays, logs,
 * transactions — anything the SDK would otherwise `fetch`/`XHR` straight to
 * Sentry's ingest host) through the `forward_sentry_envelope` Tauri command
 * instead. Necessary because `src-tauri/tauri.conf.json`'s CSP
 * (`connect-src: 'self' ipc: http://ipc.localhost`) blocks the webview from
 * reaching Sentry's ingest host directly — the default `makeFetchTransport`
 * would just fail silently on every send. The Rust side re-parses the DSN and
 * makes the real HTTP request itself, which isn't CSP-constrained (see
 * `forward_sentry_envelope` in `src-tauri/src/lib.rs`), so the webview's CSP
 * stays as locked-down as it is today rather than adding an external
 * `connect-src` allowlist entry.
 */
interface SentryEnvelopeForwardResult {
  status_code: number;
  "x-sentry-rate-limits": string | null;
  "retry-after": string | null;
}

function makeTauriIpcTransport(
  options: BaseTransportOptions,
): ReturnType<typeof Sentry.createTransport> {
  return Sentry.createTransport(options, async (request) => {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<SentryEnvelopeForwardResult>("forward_sentry_envelope", {
      envelopeBase64: encodeEnvelopeBody(request.body),
    });
    // Pass rate-limit headers through so the SDK can back off per-category
    // (errors vs. replays vs. logs) instead of only seeing a bare status
    // code and treating every 429 the same way.
    return {
      statusCode: result.status_code,
      headers: {
        "x-sentry-rate-limits": result["x-sentry-rate-limits"],
        "retry-after": result["retry-after"],
      },
    };
  });
}

const MAX_ERRORS_PER_SESSION = 50;

let initialized = false;
let sentErrorCount = 0;
type FeedbackDialog = Awaited<
  ReturnType<NonNullable<ReturnType<typeof Sentry.getFeedback>>["createForm"]>
>;
let feedbackDialog: FeedbackDialog | null = null;
let feedbackDialogPromise: Promise<FeedbackDialog | null> | null = null;
let feedbackDialogPromiseKey: string | null = null;
let feedbackDialogGeneration = 0;
let feedbackSubmissionContext: SentryFeedbackDialogOptions = {};

/**
 * Two categories only for v1 (Spec 22) — a third bucket (e.g. "Question") is
 * a future consideration, not designed in now.
 */
export type FeedbackCategory = "bug" | "feature_request";

export interface SentryFeedbackDialogOptions {
  associatedEventId?: string;
  surface?: "crash-fallback" | "manual" | "settings";
  category?: FeedbackCategory;
}

function removeFeedbackDialog(dialog: { removeFromDom?: unknown } | null | undefined): void {
  if (!dialog || typeof dialog.removeFromDom !== "function") return;
  try {
    dialog.removeFromDom();
  } catch {
    // Closing observability should not fail the settings flow.
  }
}

function feedbackOptionsKey(options: SentryFeedbackDialogOptions): string {
  return `${options.surface ?? "manual"}:${options.associatedEventId ?? ""}:${options.category ?? ""}`;
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

/**
 * Origins the browser SDK is allowed to attach `sentry-trace`/`baggage`
 * headers to (`browserTracingIntegration`'s outbound `fetch` instrumentation
 * checks this list before injecting anything, so an unmatched origin never
 * gets trace headers at all). Always includes `charm-web-server`'s real API
 * origin — `VITE_CHARM_WEB_API_BASE_URL`, the same env var
 * `lib/matrixTransport.ts`'s `apiBase()` reads — so a web-build trace
 * actually continues into the backend it's deployed against, not just
 * localhost. When that env var is unset, the web build calls relative paths
 * against its own origin (`matrixTransport.ts`'s `apiBase()` falls back to
 * `""`), so `window.location.origin` is included too. `localhost` stays for
 * local dev regardless of either.
 */
function tracePropagationTargets(): (string | RegExp)[] {
  const targets: (string | RegExp)[] = ["localhost", /^https?:\/\/localhost(?::\d+)?\//];
  const apiBase = import.meta.env.VITE_CHARM_WEB_API_BASE_URL;
  if (apiBase) {
    // Trim trailing slashes the same way `matrixTransport.ts`'s `apiBase()`
    // does before every fetch — this must match the actual request URL
    // (`${apiBase()}${path}`), or a configured value with extra trailing
    // slashes (e.g. `https://example.com/charm///`) never matches the
    // trimmed request Sentry's string matcher sees, and no trace headers
    // ever get attached.
    targets.push(apiBase.replace(/\/+$/, ""));
  } else if (typeof window !== "undefined") {
    targets.push(window.location.origin);
  }
  return targets;
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
    // Requires the Document-Policy: js-profiling response header (set in
    // vite.config.ts and the web Worker in build-web-worker/action.yml) or the
    // browser's Profiler API silently no-ops. Tauri's packaged desktop builds
    // can't set this header — its app.security.headers config only allows a
    // fixed whitelist that doesn't include Document-Policy — so profiling only
    // takes effect on the web target until that's solved (e.g. a custom
    // on_web_resource_request webview hook).
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
    tracePropagationTargets: tracePropagationTargets(),
    replaysSessionSampleRate: settings.replayEnabled ? rate : 0,
    replaysOnErrorSampleRate: settings.replayEnabled ? 1.0 : 0,
    profilesSampleRate: settings.profilingEnabled ? rate : 0,
    enableLogs: settings.logsEnabled,
    enableMetrics: true,
    transport: isTauri() ? makeTauriIpcTransport : undefined,
    integrations: integrations(settings),
    initialScope: {
      tags: {
        "charm.platform": platformTag(),
        "charm.build.id": getBuildId(),
        "charm.build.version": packageJson.version,
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
      ...(feedbackSubmissionContext.category
        ? { "charm.feedback.category": feedbackSubmissionContext.category }
        : {}),
    };
    if (feedbackSubmissionContext.associatedEventId && event.contexts?.feedback) {
      event.contexts.feedback.associated_event_id = feedbackSubmissionContext.associatedEventId;
    }
    Object.assign(event, scrubSentryValue(event));
  });
  Sentry.setTag("charm.platform", platformTag());
  Sentry.setTag("charm.build.id", getBuildId());
  Sentry.setTag("charm.build.version", packageJson.version);
  initialized = true;
  recordCount("app.boot", 1, { platform: platformTag() });
  return true;
}

function setSentryClientEnabled(enabled: boolean): void {
  const client = Sentry.getClient();
  if (!client) return;
  client.getOptions().enabled = enabled;
}

async function readBootstrapSettings(): Promise<ObservabilitySettings> {
  const [settings] = await Promise.all([readObservabilitySettings(), preloadPlatformTag()]);
  return settings;
}

export async function bootstrapSentry(): Promise<ObservabilitySettings> {
  const settings = await readBootstrapSettings();
  initializeSentry(settings);
  return settings;
}

/**
 * Milliseconds to wait for {@link bootstrapSentry} before giving up and letting
 * `main.tsx` render anyway. `readObservabilitySettings` awaits a Tauri IPC
 * round-trip (the `plugin-store` `load()`/`get()` calls in `persistence.ts`)
 * that has no built-in timeout — if it ever hangs (a locked store file, a
 * stuck IPC channel), the app was left permanently blank, because
 * `main.tsx` used a top-level `await bootstrapSentry()` gating the very
 * first `ReactDOM.createRoot(...).render(...)` call. See the 2026-07-13
 * blank-page-on-launch investigation.
 */
export const BOOTSTRAP_TIMEOUT_MS = 3000;

/**
 * Runs the same settings read {@link bootstrapSentry} does, but never blocks
 * the caller past {@link BOOTSTRAP_TIMEOUT_MS} — `main.tsx` awaits this
 * instead of `bootstrapSentry()` directly so a stuck settings read can no
 * longer keep React from ever mounting. If the timeout wins, Sentry stays
 * uninitialized for this session (same as `VITE_SENTRY_DSN` being unset)
 * rather than the whole app staying blank forever.
 *
 * Deliberately does *not* delegate to `bootstrapSentry()` — the read and the
 * `initializeSentry` call only happen together, gated on this function's own
 * timeout, so a settings read that keeps running in the background after
 * losing the race (there is no way to cancel an in-flight Tauri IPC call)
 * can never reach `initializeSentry` at all. Without that separation, a slow
 * (not hung) read could resolve after the user already opened Settings and
 * turned Sentry off, silently re-enabling it.
 */
export async function bootstrapSentryWithTimeout(
  timeoutMs: number = BOOTSTRAP_TIMEOUT_MS,
): Promise<ObservabilitySettings | null> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), timeoutMs);
  });
  try {
    const result = await Promise.race([readBootstrapSettings(), timeout]);
    if (result === "timed-out") return null;
    initializeSentry(result);
    return result;
  } finally {
    clearTimeout(timer!);
  }
}

export async function closeSentry(): Promise<void> {
  if (!initialized) return;
  sentErrorCount = 0;
  feedbackDialogGeneration += 1;
  setSentryClientEnabled(false);
  feedbackDialogPromise = null;
  feedbackDialogPromiseKey = null;
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

  const generation = feedbackDialogGeneration;
  const optionsKey = feedbackOptionsKey(options);
  if (feedbackDialogPromise && feedbackDialogPromiseKey !== optionsKey) {
    return false;
  }
  if (feedbackDialog && !feedbackDialogPromise) {
    const dialog = feedbackDialog;
    feedbackDialog = null;
    removeFeedbackDialog(dialog);
  }
  if (!feedbackDialog && !feedbackDialogPromise) {
    try {
      feedbackDialogPromise = Promise.resolve(
        feedback.createForm({
          tags: {
            "charm.feedback.surface": options.surface ?? "manual",
            "charm.feedback.screenshot": "optional",
            ...(options.category ? { "charm.feedback.category": options.category } : {}),
          },
        }),
      )
        .then((dialog) => {
          if (
            generation !== feedbackDialogGeneration ||
            !Sentry.getClient()?.getOptions().enabled
          ) {
            removeFeedbackDialog(dialog);
            return null;
          }
          if (
            !dialog ||
            typeof dialog.appendToDom !== "function" ||
            typeof dialog.open !== "function" ||
            typeof dialog.removeFromDom !== "function"
          ) {
            removeFeedbackDialog(dialog);
            return null;
          }
          if (
            generation !== feedbackDialogGeneration ||
            !Sentry.getClient()?.getOptions().enabled
          ) {
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
            feedbackDialogPromiseKey = null;
          }
        });
      feedbackDialogPromiseKey = optionsKey;
    } catch {
      feedbackDialogPromise = null;
      feedbackDialogPromiseKey = null;
      return false;
    }
  }

  const dialog = feedbackDialog ?? (await feedbackDialogPromise);
  if (generation !== feedbackDialogGeneration || !client.getOptions().enabled) {
    removeFeedbackDialog(dialog);
    return false;
  }
  feedbackDialog = dialog;
  if (!feedbackDialog) return false;

  try {
    feedbackSubmissionContext = { ...options };
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
    feedbackDialogPromiseKey = null;
    feedbackDialogGeneration = 0;
    feedbackSubmissionContext = {};
  },
  scrubSensitiveText,
  defaultSettings: DEFAULT_OBSERVABILITY_SETTINGS,
};
