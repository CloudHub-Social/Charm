import { useEffect } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useMediaSource } from "./useMediaSource";

interface LightboxProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roomId: string;
  eventId: string;
  kind: "image" | "video";
  alt: string;
  /** Optional prev/next handlers to wire arrow-key navigation across a set (e.g. all images in a room). */
  onPrev?: () => void;
  onNext?: () => void;
}

/**
 * Full-res image/video viewer. Built on the existing Radix `Dialog` wrapper
 * (`components/ui/dialog.tsx`) rather than a bespoke overlay, so it inherits
 * the same focus-trap/Escape-to-close/portal behavior already used
 * elsewhere. Arrow-key navigation is opt-in via `onPrev`/`onNext` — omit
 * both for a single-image view.
 */
export function Lightbox({
  open,
  onOpenChange,
  roomId,
  eventId,
  kind,
  alt,
  onPrev,
  onNext,
}: LightboxProps) {
  const { data: href } = useMediaSource(roomId, eventId);

  useEffect(() => {
    if (!open) return undefined;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "ArrowLeft" && onPrev) onPrev();
      if (event.key === "ArrowRight" && onNext) onNext();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onPrev, onNext]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-w-[95vw] items-center justify-center border-none bg-transparent p-0 shadow-none sm:max-w-[95vw]">
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        {href &&
          (kind === "image" ? (
            <img
              src={href}
              alt={alt}
              className="max-h-[90vh] max-w-full rounded-md object-contain"
            />
          ) : (
            // User-sent video has no caption track to attach — <track> below satisfies the a11y rule.
            <video
              src={href}
              controls
              autoPlay
              className="max-h-[90vh] max-w-full rounded-md object-contain"
            >
              <track kind="captions" />
            </video>
          ))}
        {(onPrev || onNext) && (
          <div className="absolute inset-x-0 bottom-4 flex justify-center gap-2">
            {onPrev && (
              <button
                type="button"
                aria-label="Previous"
                onClick={onPrev}
                className="flex size-11 items-center justify-center rounded-full bg-black/60 text-white"
              >
                ‹
              </button>
            )}
            {onNext && (
              <button
                type="button"
                aria-label="Next"
                onClick={onNext}
                className="flex size-11 items-center justify-center rounded-full bg-black/60 text-white"
              >
                ›
              </button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
