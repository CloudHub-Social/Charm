import { useState } from "react";
import { Play } from "lucide-react";
import type { MessageContent } from "@/lib/matrix";
import { AudioPlayer } from "./AudioPlayer";
import { FileChip } from "./FileChip";
import { Lightbox } from "./Lightbox";
import { useMediaSource } from "./useMediaSource";

interface MediaMessageProps {
  content: MessageContent;
}

/** Renders the correct media viewer for a non-text `MessageContent` variant; text messages don't reach this component. */
export function MediaMessage({ content }: MediaMessageProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);

  if (content.type === "Text") return null;

  if (content.type === "Image") {
    return (
      <ImageThumbnail
        content={content}
        lightboxOpen={lightboxOpen}
        setLightboxOpen={setLightboxOpen}
      />
    );
  }

  if (content.type === "Video") {
    return (
      <VideoThumbnail
        content={content}
        lightboxOpen={lightboxOpen}
        setLightboxOpen={setLightboxOpen}
      />
    );
  }

  if (content.type === "Audio") {
    return <AudioPlayer source={content.source} />;
  }

  return (
    <FileChip
      filename={content.body}
      mime={content.mime}
      size={content.size}
      source={content.source}
    />
  );
}

function ImageThumbnail({
  content,
  lightboxOpen,
  setLightboxOpen,
}: {
  content: Extract<MessageContent, { type: "Image" }>;
  lightboxOpen: boolean;
  setLightboxOpen: (open: boolean) => void;
}) {
  const thumbnailHandle = content.thumbnail ?? content.source;
  const { data: thumbSrc } = useMediaSource(thumbnailHandle, { thumbnail: true });

  return (
    <>
      <button
        type="button"
        aria-label={`Open image ${content.body}`}
        onClick={() => setLightboxOpen(true)}
        className="block max-w-70 overflow-hidden rounded-md border border-border"
      >
        {thumbSrc ? (
          <img src={thumbSrc} alt={content.body} className="max-h-70 w-full object-cover" />
        ) : (
          <div className="h-40 w-70 animate-pulse bg-secondary" />
        )}
      </button>
      <Lightbox
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        source={content.source}
        kind="image"
        alt={content.body}
      />
    </>
  );
}

function VideoThumbnail({
  content,
  lightboxOpen,
  setLightboxOpen,
}: {
  content: Extract<MessageContent, { type: "Video" }>;
  lightboxOpen: boolean;
  setLightboxOpen: (open: boolean) => void;
}) {
  const thumbnailHandle = content.thumbnail;
  const { data: thumbSrc } = useMediaSource(thumbnailHandle, { thumbnail: true });

  return (
    <>
      <button
        type="button"
        aria-label={`Play video ${content.body}`}
        onClick={() => setLightboxOpen(true)}
        className="relative block max-w-70 overflow-hidden rounded-md border border-border"
      >
        {thumbSrc ? (
          <img src={thumbSrc} alt={content.body} className="max-h-70 w-full object-cover" />
        ) : (
          <div className="h-40 w-70 animate-pulse bg-secondary" />
        )}
        <span className="absolute inset-0 flex items-center justify-center bg-black/20">
          <Play size={36} className="fill-white text-white" />
        </span>
      </button>
      <Lightbox
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        source={content.source}
        kind="video"
        alt={content.body}
      />
    </>
  );
}
