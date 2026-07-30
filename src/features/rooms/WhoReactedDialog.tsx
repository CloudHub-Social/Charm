import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { ReactionDetail } from "@bindings/ReactionDetail";
import { useRef } from "react";

interface WhoReactedDialogProps {
  open: boolean;
  reactionKey: string | null;
  details: ReactionDetail[];
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
  onOpenChange: (open: boolean) => void;
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
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Reacted with {reactionKey ?? lastReactionKeyRef.current}</DialogTitle>
          <DialogDescription>
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
              <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                Retry
              </Button>
            )}
          </div>
        ) : (
          <ul className="flex max-h-80 flex-col gap-1 overflow-auto text-sm">
            {details.map((detail) => (
              <li key={`${detail.sender}-${detail.origin_server_ts}`} className="truncate">
                {detail.sender}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
