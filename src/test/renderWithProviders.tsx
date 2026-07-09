import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { AppProviders } from "@/providers";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * Wraps `ui` in the same provider tree `renderWithProviders` uses, without
 * rendering it — for tests that need to call RTL's `rerender` (which
 * replaces the whole tree it was given, so a bare `rerender(<Component />)`
 * would drop the QueryClient/TooltipProvider context and throw).
 */
export function wrapWithProviders(ui: ReactElement, client: QueryClient) {
  return (
    <AppProviders client={client}>
      <TooltipProvider>{ui}</TooltipProvider>
    </AppProviders>
  );
}

/**
 * Fresh, retry-disabled `QueryClient` per test, wrapped in the app's full
 * provider tree (`AppProviders`, i.e. TanStack Query + Jotai) plus a
 * `TooltipProvider` — several components render a `Tooltip` when gated/
 * disabled, and in the app that ancestor comes from a higher-level layout
 * component, but components under test here are often rendered standalone.
 */
export function renderWithProviders(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { ...render(wrapWithProviders(ui, client)), client };
}
