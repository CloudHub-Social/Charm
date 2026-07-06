import React from "react";
import ReactDOM from "react-dom/client";
import * as Sentry from "@sentry/react";
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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Sentry's own FallbackRender type shapes resetError as a method signature, but the actual value it passes is already an arrow function (`() => this.resetErrorBoundary()`) with no `this` dependency
      fallback={({ resetError }) => <ErrorFallback resetError={resetError} />}
    >
      <AppProviders>
        <App />
      </AppProviders>
    </Sentry.ErrorBoundary>
  </React.StrictMode>,
);
