import { useRef } from "react";
import { MAX_ROOM_SIDEBAR_WIDTH, MIN_ROOM_SIDEBAR_WIDTH } from "./navigationState";

export function PaneResizeHandle({
  width,
  onWidthChange,
}: {
  width: number;
  onWidthChange: (width: number) => void;
}) {
  const startRef = useRef<{ x: number; width: number } | null>(null);

  return (
    <div className="group relative z-20 -mx-1 w-2 shrink-0">
      <hr className="pointer-events-none absolute inset-y-0 left-1/2 m-0 h-full w-px -translate-x-1/2 border-0 bg-transparent group-hover:bg-[var(--ux-shell-focus)] group-focus-within:bg-[var(--ux-shell-focus)]" />
      <button
        type="button"
        aria-label="Resize room sidebar"
        title={`Room sidebar width: ${width}px (${MIN_ROOM_SIDEBAR_WIDTH}–${MAX_ROOM_SIDEBAR_WIDTH}px)`}
        className="absolute inset-0 cursor-col-resize touch-none focus-visible:outline-none"
        onPointerDown={(event) => {
          startRef.current = { x: event.clientX, width };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!startRef.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
          onWidthChange(startRef.current.width + event.clientX - startRef.current.x);
        }}
        onPointerUp={(event) => {
          startRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          onWidthChange(width + (event.key === "ArrowRight" ? 8 : -8));
        }}
      />
    </div>
  );
}
