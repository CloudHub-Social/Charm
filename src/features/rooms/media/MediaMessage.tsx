import { useState } from "react";
import { Play } from "lucide-react";
import type { MediaContent } from "@/lib/matrix";
import { AudioPlayer } from "./AudioPlayer";
import { FileChip } from "./FileChip";
import { Lightbox } from "./Lightbox";
import { useMediaSource } from "./useMediaSource";

interface MediaMessageProps {
  content: MediaContent;
  roomId: string;
  eventId: string;
  /** Text-preview fallback (`RoomMessageSummary.body`) — used for alt text. */
  body: string;
}

/** Renders the correct media viewer for a message's `media` field; text messages (where `media` is `null`) never reach this component. */
export function MediaMessage({ content, roomId, eventId, body }: MediaMessageProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);

  if (content.type === "Image") {
    return (
      <ImageThumbnail
        alt={body}
        roomId={roomId}
        eventId={eventId}
        width={content.width}
        height={content.height}
        lightboxOpen={lightboxOpen}
        setLightboxOpen={setLightboxOpen}
      />
    );
  }

  if (content.type === "Video") {
    return (
      <VideoThumbnail
        alt={body}
        roomId={roomId}
        eventId={eventId}
        width={content.width}
        height={content.height}
        lightboxOpen={lightboxOpen}
        setLightboxOpen={setLightboxOpen}
      />
    );
  }

  if (content.type === "Audio") {
    return <AudioPlayer roomId={roomId} eventId={eventId} />;
  }

  return (
    <FileChip
      filename={content.filename}
      mime={content.mime}
      size={content.size}
      roomId={roomId}
      eventId={eventId}
    />
  );
}

// Matches the previous fixed `h-40 w-70` placeholder box (280x160) so rooms
// with only unknown-dimension media see no layout change from before.
const FALLBACK_ASPECT_RATIO = "280 / 160";

/**
 * CSS `aspect-ratio` for a media thumbnail's placeholder box, reserved before
 * the image/video finishes loading so its arrival doesn't reflow the
 * timeline (Spec 26 Phase 1, Charm 1.0 issue #445). Falls back to a fixed
 * ratio when the event didn't carry known dimensions.
 */
function aspectRatioStyle(width: number | null, height: number | null) {
  return { aspectRatio: width && height ? `${width} / ${height}` : FALLBACK_ASPECT_RATIO };
}

function ImageThumbnail({
  alt,
  roomId,
  eventId,
  width,
  height,
  lightboxOpen,
  setLightboxOpen,
}: {
  alt: string;
  roomId: string;
  eventId: string;
  width: number | null;
  height: number | null;
  lightboxOpen: boolean;
  setLightboxOpen: (open: boolean) => void;
}) {
  const { data: thumbSrc } = useMediaSource(roomId, eventId, { thumbnail: true });

  return (
    <>
      <button
        type="button"
        aria-label={`Open image ${alt}`}
        onClick={() => setLightboxOpen(true)}
        className="block h-auto w-70 max-h-70 overflow-hidden rounded-md border border-border"
        style={aspectRatioStyle(width, height)}
      >
        {thumbSrc ? (
          <img src={thumbSrc} alt={alt} className="size-full object-cover" />
        ) : (
          <div className="size-full animate-pulse bg-secondary" />
        )}
      </button>
      <Lightbox
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        roomId={roomId}
        eventId={eventId}
        kind="image"
        alt={alt}
      />
    </>
  );
}

function VideoThumbnail({
  alt,
  roomId,
  eventId,
  width,
  height,
  lightboxOpen,
  setLightboxOpen,
}: {
  alt: string;
  roomId: string;
  eventId: string;
  width: number | null;
  height: number | null;
  lightboxOpen: boolean;
  setLightboxOpen: (open: boolean) => void;
}) {
  const { data: thumbSrc } = useMediaSource(roomId, eventId, { thumbnail: true });

  return (
    <>
      <button
        type="button"
        aria-label={`Play video ${alt}`}
        onClick={() => setLightboxOpen(true)}
        className="relative block h-auto w-70 max-h-70 overflow-hidden rounded-md border border-border"
        style={aspectRatioStyle(width, height)}
      >
        {thumbSrc ? (
          <img src={thumbSrc} alt={alt} className="size-full object-cover" />
        ) : (
          <div className="size-full animate-pulse bg-secondary" />
        )}
        <span className="absolute inset-0 flex items-center justify-center bg-black/20">
          <Play size={36} className="fill-white text-white" />
        </span>
      </button>
      <Lightbox
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        roomId={roomId}
        eventId={eventId}
        kind="video"
        alt={alt}
      />
    </>
  );
}
