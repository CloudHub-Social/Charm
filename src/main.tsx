import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import * as Sentry from "@sentry/react";
import { createStore } from "jotai";
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import App from "./App";
import { ErrorFallback } from "./components/ErrorFallback";
import { ThemeProvider } from "./features/appearance/ThemeProvider";
import { isTauri } from "./lib/platform";
import { initializeFeatureFlags } from "./featureFlags";
import { initializePrivacySettings } from "./features/privacy/privacySettings";
import { checkUncleanPreviousSession } from "./observability/crashRecovery";
import { bootstrapSentryWithTimeout } from "./observability/instrument";
import { AppProviders } from "./providers";
import "./styles/tokens.css";

// eslint-disable-next-line @typescript-eslint/unbound-method -- Sentry's own FallbackRender type shapes resetError as a method signature, but the actual value it passes is already an arrow function (`() => this.resetErrorBoundary()`) with no `this` dependency
function ErrorBoundaryFallback({
  eventId,
  resetError,
}: {
  eventId?: string;
  resetError: () => void;
}) {
  return <ErrorFallback resetError={resetError} sentryEventId={eventId} />;
}

/**
 * Owns the Jotai store as replaceable state (rather than letting
 * `AppProviders` create its own internal one) so `App`'s logout handler can
 * swap in a brand-new store — discarding every atom's value, including
 * account-scoped ones (`settingsOpenAtom`, the per-room reply/edit
 * `atomFamily`s) that live above `App` and would otherwise survive into the
 * next signed-in account, the same way `queryClient.clear()` already does
 * for TanStack Query.
 */
function Root({ showCrashRecoveryPrompt }: { showCrashRecoveryPrompt: boolean }) {
  const [jotaiStore, setJotaiStore] = useState(() => createStore());

  return (
    <Sentry.ErrorBoundary fallback={ErrorBoundaryFallback}>
      <AppProviders store={jotaiStore}>
        <ThemeProvider>
          <App
            onLoggedOut={() => setJotaiStore(createStore())}
            showCrashRecoveryPrompt={showCrashRecoveryPrompt}
          />
        </ThemeProvider>
      </AppProviders>
    </Sentry.ErrorBoundary>
  );
}

// Bounded, not `await bootstrapSentry()` directly: this gates React's first
// render, so a hung settings read (e.g. a stuck Tauri IPC round-trip) must
// never be able to leave the app permanently blank. Run alongside the
// crash-recovery check rather than after it, so neither adds to the other's
// latency.
// Load persisted feature-flag overrides in the background — deliberately not
// awaited, so a slow/hung store read can't delay first paint. Components read
// catalog defaults until it resolves, then re-render (the no-flag-flicker
// contract). Overrides are dev/Labs-only today, so there's no user-visible flip.
void initializeFeatureFlags();
void initializePrivacySettings();

const [settings, uncleanPreviousSession] = await Promise.all([
  bootstrapSentryWithTimeout(),
  checkUncleanPreviousSession(),
]);

if (isTauri()) {
  // Forwards the native side's `tauri-plugin-log` Webview target into this
  // window's actual DevTools console — without this call the Rust logger's
  // Webview target is configured but silently inert (per the plugin's own
  // docs). Dynamically imported so `@tauri-apps/plugin-log` isn't pulled
  // into the web build, which has no Tauri IPC to attach to.
  const { attachConsole } = await import("@tauri-apps/plugin-log");
  void attachConsole();
}

// `settings === null` means the read timed out, not that Sentry is
// definitely disabled — `!settings?.sentryEnabled` would be `true` in that
// case too (`undefined` is falsy), wrongly nudging a user who actually has
// crash reporting on just because the settings read was slow. Only show the
// prompt when we positively know it's off.
const sentryDefinitelyDisabled = settings !== null && !settings.sentryEnabled;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root showCrashRecoveryPrompt={uncleanPreviousSession && sentryDefinitelyDisabled} />
  </React.StrictMode>,
);
