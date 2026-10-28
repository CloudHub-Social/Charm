import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { ReactionDetail } from "@bindings/ReactionDetail";
import { type ComponentProps, useRef } from "react";

interface WhoReactedDialogProps {
  open: boolean;
  reactionKey: string | null;
  details: ReactionDetail[];
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: ComponentProps<typeof DialogContent>["onCloseAutoFocus"];
}

/** Full "who reacted" list for a single reaction, beyond what comfortably fits in the hover tooltip. */
export function WhoReactedDialog({
  open,
  reactionKey,
  details,
  loading = false,
  error = false,
  onRetry,
  onOpenChange,
  onCloseAutoFocus,
}: WhoReactedDialogProps) {
  // Radix keeps the dialog content mounted during its exit animation. The
  // parent clears `reactionKey` as it closes, so retain the last real key
  // for those final frames instead of briefly rendering "Reacted with ".
  const lastReactionKeyRef = useRef(reactionKey);
  if (reactionKey !== null) {
    lastReactionKeyRef.current = reactionKey;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-sm"
        showCloseButton={false}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle className="break-all">
            Reacted with {reactionKey ?? lastReactionKeyRef.current}
          </DialogTitle>
          <DialogDescription aria-live="polite">
            {error
              ? "Reaction details are unavailable."
              : loading
                ? "Loading reactions…"
                : `${details.length} reaction${details.length === 1 ? "" : "s"}`}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <div role="alert" className="flex flex-col items-start gap-3 text-sm">
            <p>Could not load reactions.</p>
            {onRetry && (
              <Button
                type="button"
                variant="outline"
                className="min-h-11 min-w-11"
                onClick={onRetry}
              >
                Retry
              </Button>
            )}
          </div>
        ) : (
          <ul
            tabIndex={0}
            aria-label="Reactors"
            className="flex max-h-80 flex-col gap-1 overflow-auto text-sm"
          >
            {details.map((detail) => (
              <li key={`${detail.sender}-${detail.origin_server_ts}`} className="min-w-0 break-all">
                {detail.sender}
              </li>
            ))}
          </ul>
        )}
        <DialogClose asChild>
          <Button type="button" variant="ghost" className="min-h-11 min-w-11 justify-self-end">
            Close
          </Button>
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}
