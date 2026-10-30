import { useLayoutEffect, useRef } from "react";

/** Position the existing toolbar inside its timeline; Radix still owns its menus. */
export function useMessageActionPosition() {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const toolbar = ref.current;
    const row = toolbar?.closest<HTMLElement>('[id^="message-"]');
    const scroller = row?.closest<HTMLElement>("[data-virtuoso-scroller]");
    if (!toolbar || !row || !scroller) return;

    const visualViewport = window.visualViewport;
    let disposed = false;
    let hovering = false;
    let tracking = false;
    let resizeObserver: ResizeObserver | null = null;

    function position() {
      const rowBounds = row!.getBoundingClientRect();
      const viewport = scroller!.getBoundingClientRect();
      const visibleTop = visualViewport?.offsetTop ?? 0;
      const visibleBottom = visibleTop + (visualViewport?.height ?? window.innerHeight);
      const top = Math.max(viewport.top + scroller!.clientTop, visibleTop) + 4;
      const bottom = Math.min(viewport.bottom, visibleBottom) - 4;
      if (bottom <= top) return;

      const height = Math.min(toolbar!.getBoundingClientRect().height, bottom - top);
      let y = rowBounds.top - height;
      // Do not detach actions from a message that has left the visible timeline.
      if (rowBounds.bottom > top && rowBounds.top < bottom) {
        if (y < top) y = rowBounds.bottom + height <= bottom ? rowBounds.bottom : top;
        y = Math.max(top, Math.min(y, bottom - height));
      }
      toolbar!.style.top = y - rowBounds.top - row!.clientTop + "px";
      toolbar!.style.bottom = "auto";
      toolbar!.style.maxHeight = bottom - top + "px";
      toolbar!.style.overflowY = "auto";
    }

    function stopTracking() {
      tracking = false;
      resizeObserver?.disconnect();
      resizeObserver = null;
      scroller!.removeEventListener("scroll", position);
      window.removeEventListener("resize", position);
      visualViewport?.removeEventListener("resize", position);
      visualViewport?.removeEventListener("scroll", position);
    }

    function startTracking() {
      position();
      if (tracking) return;
      tracking = true;
      resizeObserver = new ResizeObserver(position);
      resizeObserver.observe(row!);
      resizeObserver.observe(toolbar!);
      resizeObserver.observe(scroller!);
      scroller!.addEventListener("scroll", position, { passive: true });
      window.addEventListener("resize", position);
      visualViewport?.addEventListener("resize", position);
      visualViewport?.addEventListener("scroll", position);
    }

    function reconcile() {
      if (disposed) return;
      if (
        hovering ||
        row!.contains(document.activeElement) ||
        toolbar!.querySelector('[data-state="open"]')
      ) {
        startTracking();
      } else {
        stopTracking();
      }
    }

    function enter() {
      hovering = true;
      startTracking();
    }
    function leave() {
      hovering = false;
      reconcile();
    }
    function focusOut() {
      // Allow native/Radix focus transfer into a portal to finish first.
      queueMicrotask(reconcile);
    }

    position();
    row.addEventListener("pointerenter", enter);
    row.addEventListener("pointerleave", leave);
    row.addEventListener("pointerdown", startTracking);
    row.addEventListener("pointercancel", leave);
    row.addEventListener("focusin", startTracking);
    row.addEventListener("focusout", focusOut);
    const stateObserver = new MutationObserver(reconcile);
    stateObserver.observe(toolbar, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-state"],
    });
    return () => {
      disposed = true;
      stopTracking();
      stateObserver.disconnect();
      row.removeEventListener("pointerenter", enter);
      row.removeEventListener("pointerleave", leave);
      row.removeEventListener("pointerdown", startTracking);
      row.removeEventListener("pointercancel", leave);
      row.removeEventListener("focusin", startTracking);
      row.removeEventListener("focusout", focusOut);
    };
  }, []);

  return ref;
}
