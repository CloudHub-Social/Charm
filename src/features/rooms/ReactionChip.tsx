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
  const touchOriginRef = useRef<{ identifier: number; x: number; y: number } | null>(null);
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
        disabled={disabled && !onViewDetails}
        aria-label={
          disabled && onViewDetails
            ? `View ${reaction.count} reactors for ${reaction.key}`
            : undefined
        }
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
          if (disabled) onViewDetails?.(event.currentTarget);
          else onToggle();
        }}
        onContextMenu={(event) => {
          if (!onViewDetails) return;
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
          if (event.touches.length !== 1) return;
          const touch = event.touches[0];
          touchOriginRef.current = {
            identifier: touch.identifier,
            x: touch.clientX,
            y: touch.clientY,
          };
          if (!onViewDetails) return;
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
          touchOriginRef.current = null;
          if (suppressClickRef.current) event.preventDefault();
        }}
        onTouchMove={(event) => {
          event.stopPropagation();
          const origin = touchOriginRef.current;
          const touch = Array.from(event.touches).find(
            (candidate) => candidate.identifier === origin?.identifier,
          );
          if (
            origin &&
            touch &&
            Math.hypot(touch.clientX - origin.x, touch.clientY - origin.y) <= 10
          )
            return;
          cancelHold();
          suppressClickRef.current = true;
        }}
        onTouchCancel={(event) => {
          event.stopPropagation();
          cancelHold();
          suppressClickRef.current = true;
        }}
        className={cn(
          disabled && onViewDetails && "opacity-70",
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
          {disabled ? "Read-only reaction. Activate to view reactors. " : ""}
          Hold or press Shift+F10 for reactor details. Tab to View reactors for read-only access.
        </span>
      )}
    </>
  );
});
