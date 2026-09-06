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
    <div
      role="separator"
      aria-label="Resize room sidebar"
      aria-orientation="vertical"
      aria-valuemin={MIN_ROOM_SIDEBAR_WIDTH}
      aria-valuemax={MAX_ROOM_SIDEBAR_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      className="group relative z-20 -mx-1 w-2 shrink-0 cursor-col-resize touch-none focus-visible:outline-none"
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
    >
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-[var(--ux-shell-focus)] group-focus-visible:bg-[var(--ux-shell-focus)]" />
    </div>
  );
}
