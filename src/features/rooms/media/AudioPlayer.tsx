import { useMediaSource } from "./useMediaSource";

interface AudioPlayerProps {
  source: string;
  className?: string;
}

/** Inline `<audio>` player for `m.audio` messages — received clips only, no recording UI (out of scope). */
export function AudioPlayer({ source, className }: AudioPlayerProps) {
  const { data: href } = useMediaSource(source);

  if (!href) {
    return <div className="h-10 w-64 animate-pulse rounded-md bg-secondary" />;
  }

  return (
    // Voice/audio messages have no caption track to attach — nothing to satisfy media-has-caption with.
    <audio controls src={href} className={className} style={{ maxWidth: 320 }}>
      <track kind="captions" />
    </audio>
  );
}
