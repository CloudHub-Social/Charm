import { useState } from "react";
import { Button } from "@/components/ui/button";
import { openSentryFeedbackDialog } from "@/observability/instrument";

/**
 * Rendered by the top-level `Sentry.ErrorBoundary` (see `main.tsx`) in place
 * of the entire app when a render error escapes every component below it.
 * Without a boundary at all, that same error unmounts React's root and
 * leaves a blank window with no recovery path — this at least gives the
 * user a way back in. When the user opted in under Settings -> Observability
 * and the build has a Sentry DSN, the surrounding boundary captures the error
 * before this renders.
 */
export function ErrorFallback({ resetError }: { resetError: () => void }) {
  const [feedbackStatus, setFeedbackStatus] = useState<string | null>(null);

  const sendFeedback = async () => {
    setFeedbackStatus(null);
    const opened = await openSentryFeedbackDialog();
    if (!opened) {
      setFeedbackStatus("Feedback is only available when Sentry observability is enabled.");
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center">
      <h1 className="text-lg font-semibold text-foreground">Something went wrong</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        Charm hit an unexpected error and couldn&apos;t continue. Your conversations are safe on the
        server — reloading usually fixes this.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="button" variant="outline" onClick={() => void sendFeedback()}>
          Send feedback
        </Button>
        <Button
          onClick={() => {
            resetError();
            window.location.reload();
          }}
        >
          Reload
        </Button>
      </div>
      {feedbackStatus ? (
        <output className="max-w-sm text-sm text-muted-foreground">{feedbackStatus}</output>
      ) : null}
    </div>
  );
}
