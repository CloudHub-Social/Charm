import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider as JotaiProvider } from "jotai";
import type { createStore } from "jotai";

/**
 * App-wide TanStack Query client. Rust is the source of truth, so the frontend caches
 * what the IPC layer returns and invalidates on the matching `*:update` Tauri events
 * (see the feature specs under `docs-site/src/content/docs/specs`). Kept module-level so callers
 * can `queryClient.invalidateQueries(...)` from event listeners.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * Composition root for the app's client-state providers. Wraps the tree in the
 * TanStack Query client and a Jotai store. Reused by `main.tsx` and by test render
 * helpers so component tests get the same context as the running app.
 *
 * Both providers are overridable: pass `store` (from jotai's `createStore()`) for an
 * isolated Jotai store — per test, or a future per-account reset — and `client` for a
 * fresh QueryClient (test isolation). Both default to the app-wide singletons; when
 * `store` is omitted, Jotai falls back to its own default store.
 */
export function AppProviders({
  children,
  client = queryClient,
  store,
}: {
  children: ReactNode;
  client?: QueryClient;
  store?: ReturnType<typeof createStore>;
}) {
  return (
    <QueryClientProvider client={client}>
      <JotaiProvider store={store}>{children}</JotaiProvider>
    </QueryClientProvider>
  );
}
