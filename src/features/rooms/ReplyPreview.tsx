import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReplyRef } from "@/lib/matrix";

interface ReplyPreviewProps {
  reply: ReplyRef;
  /** Renders the compact quote shown above a reply bubble in the timeline. */
  variant?: "quote" | "composer";
  onClick?: () => void;
  onCancel?: () => void;
  className?: string;
}

/**
 * Renders a quoted `ReplyRef` — either as the small quote above a reply
 * bubble in the timeline (`variant="quote"`, clicking it scrolls to the
 * source via `onClick`), or as the "replying to …" bar shown above the
 * composer while composing a reply (`variant="composer"`, with a cancel
 * button wired to `onCancel`).
 */
export function ReplyPreview({
  reply,
  variant = "quote",
  onClick,
  onCancel,
  className,
}: ReplyPreviewProps) {
  if (variant === "composer") {
    return (
      <div
        className={cn(
          "flex items-center justify-between gap-2 rounded-md border border-border bg-secondary px-3 py-2 text-sm",
          className,
        )}
      >
        <div className="flex min-w-0 flex-col">
          <span className="text-xs font-semibold text-secondary-foreground">
            Replying to {reply.sender}
          </span>
          <span className="truncate text-muted-foreground">{reply.preview}</span>
        </div>
        <button
          type="button"
          aria-label="Cancel reply"
          onClick={onCancel}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full max-w-full flex-col items-start rounded-sm border-l-2 border-primary bg-primary/5 px-2 py-1 text-left text-xs",
        className,
      )}
    >
      <span className="font-semibold text-primary">{reply.sender}</span>
      <span className="truncate text-muted-foreground">{reply.preview}</span>
    </button>
  );
}
