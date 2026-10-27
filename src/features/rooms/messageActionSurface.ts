import { useRef, type MouseEvent, type TouchEvent } from "react";
import type { MessageActionsHandle } from "./MessageActions";

/** A contextual toolbar must not contribute to the message's intrinsic width. */
export const messageActionSurfaceClassName =
  "pointer-events-none absolute right-0 top-0 z-20 max-w-full flex-wrap rounded-md border border-border bg-card p-1 opacity-0 shadow-sm transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100";

function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "a, button, input, textarea, select, audio, video, [contenteditable], [role=button], [role=link], [role=slider]",
    ) !== null
  );
}

function hasTextSelection(): boolean {
  return Boolean(window.getSelection()?.toString());
}

/**
 * Touch gestures reveal the native menu button, not a focusable message container.
 * Pointer hover and keyboard Tab use the same toolbar's CSS focus/hover states.
 */
export function useMessageActionTouch(getActions: () => MessageActionsHandle | undefined) {
  const eligibleTap = useRef(false);

  function cancelTouch() {
    eligibleTap.current = false;
    getActions()?.cancelLongPress();
  }

  function onTouchStart(event: TouchEvent<HTMLDivElement>) {
    cancelTouch();
    if (event.touches.length !== 1 || isInteractiveTarget(event.target) || hasTextSelection()) {
      return;
    }
    eligibleTap.current = true;
    getActions()?.startLongPress();
  }

  function onTouchEnd(event: TouchEvent<HTMLDivElement>) {
    const reveal = eligibleTap.current;
    cancelTouch();
    if (!reveal || event.touches.length !== 0 || hasTextSelection()) return;
    const trigger = event.currentTarget.querySelector<HTMLButtonElement>(
      '[data-message-actions] button[aria-haspopup="menu"]',
    );
    // A long press has already moved focus into the open Radix menu. Do not
    // steal that focus, or synthesize a click on a newly revealed control.
    if (!trigger || trigger.getAttribute("aria-expanded") === "true") return;
    event.preventDefault();
    trigger.focus({ preventScroll: true });
  }

  return {
    onTouchStart,
    onTouchEnd,
    onTouchMove: cancelTouch,
    onTouchCancel: cancelTouch,
  };
}

export function openMessageContextMenu(
  event: MouseEvent<HTMLDivElement>,
  actions: MessageActionsHandle | undefined,
): void {
  if (isInteractiveTarget(event.target) || hasTextSelection() || !actions?.openMenu) return;
  event.preventDefault();
  actions.openMenu();
}
