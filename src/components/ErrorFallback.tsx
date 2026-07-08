import { Button } from "@/components/ui/button";

/**
 * Rendered by the top-level `Sentry.ErrorBoundary` (see `main.tsx`) in place
 * of the entire app when a render error escapes every component below it.
 * Without a boundary at all, that same error unmounts React's root and
 * leaves a blank window with no recovery path — this at least gives the
 * user a way back in, and Sentry has already captured the error by the time
 * this renders when the user opted in under Settings -> Observability.
 */
export function ErrorFallback({ resetError }: { resetError: () => void }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center">
      <h1 className="text-lg font-semibold text-foreground">Something went wrong</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        Charm hit an unexpected error and couldn&apos;t continue. Your conversations are safe on the
        server — reloading usually fixes this.
      </p>
      <Button
        onClick={() => {
          resetError();
          window.location.reload();
        }}
      >
        Reload
      </Button>
    </div>
  );
}
