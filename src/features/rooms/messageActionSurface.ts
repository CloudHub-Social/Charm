import type { KeyboardEvent, MouseEvent } from "react";
import type { MessageActionsHandle } from "./MessageActions";

/** A contextual toolbar must not contribute to the message's intrinsic width. */
export const messageActionSurfaceClassName =
  "pointer-events-none absolute right-0 top-0 z-20 max-w-full flex-wrap rounded-md border border-border bg-card p-1 opacity-0 shadow-sm transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100";

function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("a, button, input, textarea, select, [contenteditable=true], [role=button]") !== null
  );
}

/** A normal tap reveals actions without stealing links, media, or text selection. */
export function focusMessageActions(event: MouseEvent<HTMLDivElement>): void {
  if (isInteractiveTarget(event.target) || window.getSelection()?.toString()) return;
  event.currentTarget.focus({ preventScroll: true });
}

export function openMessageContextMenu(
  event: MouseEvent<HTMLDivElement>,
  actions: MessageActionsHandle | undefined,
): void {
  if (isInteractiveTarget(event.target) || !actions?.openMenu) return;
  event.preventDefault();
  actions.openMenu();
}

export function handleMessageActionKey(
  event: KeyboardEvent<HTMLDivElement>,
  actions: MessageActionsHandle | undefined,
): void {
  if (event.target !== event.currentTarget) return;
  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
    event.preventDefault();
    actions?.openMenu?.();
  } else if (event.key === "Escape") {
    event.currentTarget.blur();
  }
}
