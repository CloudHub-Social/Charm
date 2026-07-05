import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider as JotaiProvider } from "jotai";

/**
 * App-wide TanStack Query client. Rust is the source of truth, so the frontend caches
 * what the IPC layer returns and invalidates on the matching `*:update` Tauri events
 * (see the feature specs under `15.12 Charm 2.0/specs`). Kept module-level so callers
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
 * TanStack Query client and an explicit Jotai store (explicit so tests — and a future
 * per-account reset — can supply their own). Reused by `main.tsx` and by test render
 * helpers so component tests get the same context as the running app.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <JotaiProvider>{children}</JotaiProvider>
    </QueryClientProvider>
  );
}
