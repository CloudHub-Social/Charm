import { useRef, type MouseEvent, type PointerEvent, type TouchEvent } from "react";
import type { MessageActionsHandle } from "./MessageActions";

/**
 * Keep actions out of intrinsic width and above the message being acted on.
 * No gap separates the toolbar from its row, preserving the pointer hover path.
 * An open Radix trigger keeps the surface usable while its portal owns focus.
 */
export const messageActionSurfaceClassName =
  "pointer-events-none absolute right-0 bottom-full z-20 max-w-full flex-wrap rounded-md border border-border bg-card p-1 opacity-0 shadow-sm transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100";

function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "a, button, input, textarea, select, summary, audio, video, [contenteditable], [role=button], [role=link], [role=slider]",
    ) !== null
  );
}

function isMessageTarget(event: {
  target: EventTarget | null;
  currentTarget: HTMLDivElement;
}): boolean {
  // Portals bubble through React ownership, not through this DOM message row.
  return event.target instanceof Node && event.currentTarget.contains(event.target);
}

function hasTextSelection(): boolean {
  return Boolean(window.getSelection()?.toString());
}

/**
 * Message gestures reveal the native menu button, not a focusable message container.
 * Secondary clicks use pre-click selection; deliberate selections stay native.
 * Pointer hover and keyboard Tab use the same toolbar's CSS focus/hover states.
 */
export function useMessageActionTouch(getActions: () => MessageActionsHandle | undefined) {
  const eligibleTap = useRef(false);
  const selectionBeforeSecondaryClick = useRef<boolean | null>(null);

  function clearSecondaryClick() {
    selectionBeforeSecondaryClick.current = null;
  }

  function onPointerDownCapture(event: PointerEvent<HTMLDivElement>) {
    // Capture before the browser can select the clicked word on mousedown.
    // Touch selections and primary-button drags keep their native behavior.
    selectionBeforeSecondaryClick.current =
      event.pointerType !== "touch" &&
      (event.button === 2 || (event.button === 0 && event.ctrlKey)) &&
      isMessageTarget(event) &&
      !isInteractiveTarget(event.target)
        ? hasTextSelection()
        : null;
  }

  function onContextMenu(event: MouseEvent<HTMLDivElement>) {
    const selectedBeforeClick = selectionBeforeSecondaryClick.current;
    clearSecondaryClick();
    openMessageContextMenu(event, getActions(), selectedBeforeClick);
  }

  function cancelTouch() {
    eligibleTap.current = false;
    getActions()?.cancelLongPress();
  }

  function onTouchStart(event: TouchEvent<HTMLDivElement>) {
    cancelTouch();
    if (
      !isMessageTarget(event) ||
      event.touches.length !== 1 ||
      isInteractiveTarget(event.target) ||
      hasTextSelection()
    ) {
      return;
    }
    eligibleTap.current = true;
    getActions()?.startLongPress();
  }

  function onTouchEnd(event: TouchEvent<HTMLDivElement>) {
    const reveal = eligibleTap.current;
    cancelTouch();
    if (!reveal || !isMessageTarget(event) || event.touches.length !== 0 || hasTextSelection())
      return;
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
    onPointerDownCapture,
    onPointerCancelCapture: clearSecondaryClick,
    onKeyDownCapture: clearSecondaryClick,
    onContextMenu,
    onTouchStart,
    onTouchEnd,
    onTouchMove: cancelTouch,
    onTouchCancel: cancelTouch,
  };
}

function openMessageContextMenu(
  event: MouseEvent<HTMLDivElement>,
  actions: MessageActionsHandle | undefined,
  selectedBeforeClick: boolean | null,
): void {
  if (
    !isMessageTarget(event) ||
    isInteractiveTarget(event.target) ||
    (selectedBeforeClick ?? hasTextSelection()) ||
    !actions?.openMenu
  )
    return;
  event.preventDefault();
  actions.openMenu();
}
