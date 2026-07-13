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
import { checkUncleanPreviousSession } from "./observability/crashRecovery";
import { bootstrapSentry } from "./observability/instrument";
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

const [{ sentryEnabled }, uncleanPreviousSession] = await Promise.all([
  bootstrapSentry(),
  checkUncleanPreviousSession(),
]);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root showCrashRecoveryPrompt={uncleanPreviousSession && !sentryEnabled} />
  </React.StrictMode>,
);
