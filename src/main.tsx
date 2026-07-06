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
import { AppProviders } from "./providers";
import "./styles/tokens.css";

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  enabled: Boolean(import.meta.env.VITE_SENTRY_DSN),
});

// eslint-disable-next-line @typescript-eslint/unbound-method -- Sentry's own FallbackRender type shapes resetError as a method signature, but the actual value it passes is already an arrow function (`() => this.resetErrorBoundary()`) with no `this` dependency
function ErrorBoundaryFallback({ resetError }: { resetError: () => void }) {
  return <ErrorFallback resetError={resetError} />;
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
function Root() {
  const [jotaiStore, setJotaiStore] = useState(() => createStore());

  return (
    <Sentry.ErrorBoundary fallback={ErrorBoundaryFallback}>
      <AppProviders store={jotaiStore}>
        <App onLoggedOut={() => setJotaiStore(createStore())} />
      </AppProviders>
    </Sentry.ErrorBoundary>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
