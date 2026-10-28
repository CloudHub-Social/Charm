import { forwardRef, useEffect, useId, useRef, type ButtonHTMLAttributes } from "react";
import type { ReactionGroup } from "@/lib/matrix";
import { cn } from "@/lib/utils";

interface ReactionChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  reaction: ReactionGroup;
  onToggle: () => void;
  onViewDetails?: (trigger: HTMLButtonElement) => void;
}

/** One ordinary toggle target; hold/context/Shift+F10 only opens read-only details. */
export const ReactionChip = forwardRef<HTMLButtonElement, ReactionChipProps>(function ReactionChip(
  { reaction, onToggle, onViewDetails, disabled, ...props },
  ref,
) {
  const hintId = useId();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClickRef = useRef(false);
  function cancelHold() {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  }
  useEffect(() => cancelHold, [disabled]);

  return (
    <>
      <button
        {...props}
        ref={ref}
        type="button"
        disabled={disabled}
        aria-pressed={reaction.reacted_by_me}
        aria-describedby={
          [props["aria-describedby"], onViewDetails ? hintId : undefined]
            .filter(Boolean)
            .join(" ") || undefined
        }
        onClick={(event) => {
          props.onClick?.(event);
          event.stopPropagation();
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            event.preventDefault();
            return;
          }
          onToggle();
        }}
        onContextMenu={(event) => {
          if (!onViewDetails || disabled) return;
          event.preventDefault();
          event.stopPropagation();
          cancelHold();
          suppressClickRef.current = true;
          onViewDetails(event.currentTarget);
        }}
        onKeyDown={(event) => {
          props.onKeyDown?.(event);
          suppressClickRef.current = false;
          if (
            onViewDetails &&
            (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
          ) {
            event.preventDefault();
            event.stopPropagation();
            onViewDetails(event.currentTarget);
          }
        }}
        onPointerDown={(event) => {
          props.onPointerDown?.(event);
          // A fresh physical activation must not inherit a previous hold's
          // compatibility-click suppression (some browsers emit no click).
          suppressClickRef.current = false;
        }}
        onTouchStart={(event) => {
          event.stopPropagation();
          cancelHold();
          suppressClickRef.current = false;
          if (!onViewDetails || disabled || event.touches.length !== 1) return;
          const trigger = event.currentTarget;
          timerRef.current = setTimeout(() => {
            timerRef.current = null;
            suppressClickRef.current = true;
            onViewDetails(trigger);
          }, 600);
        }}
        onTouchEnd={(event) => {
          event.stopPropagation();
          cancelHold();
          if (suppressClickRef.current) event.preventDefault();
        }}
        onTouchMove={(event) => {
          event.stopPropagation();
          cancelHold();
          suppressClickRef.current = true;
        }}
        onTouchCancel={(event) => {
          event.stopPropagation();
          cancelHold();
          suppressClickRef.current = true;
        }}
        className={cn(
          "flex min-h-11 min-w-11 max-w-full items-center justify-center gap-1 rounded-full border px-2 text-xs disabled:pointer-events-none disabled:opacity-40",
          reaction.reacted_by_me
            ? "border-primary bg-primary/10 text-primary"
            : "border-border bg-secondary text-secondary-foreground",
        )}
      >
        <span className="min-w-0 break-all">{reaction.key}</span>
        <span className="shrink-0 font-mono">{reaction.count}</span>
      </button>
      {onViewDetails && (
        <span id={hintId} className="sr-only">
          Hold or press Shift+F10 for reactor details. Tab to View reactors for read-only access.
        </span>
      )}
    </>
  );
});
