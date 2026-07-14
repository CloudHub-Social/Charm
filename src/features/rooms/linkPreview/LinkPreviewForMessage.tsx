import { useFlag } from "@/featureFlags";
import { firstUrlInText } from "./extractUrl";
import { LinkPreviewCard } from "./LinkPreviewCard";

interface LinkPreviewForMessageProps {
  body: string;
  roomId: string;
}

/**
 * Spec 29: detects the first URL in a message's plain-text body and renders
 * an unfurled preview card for it, gated behind the `link_previews` feature
 * flag. Renders nothing (and, critically, never mounts {@link LinkPreviewCard}
 * — so no preview fetch is ever triggered) when the flag is off or the body
 * has no URL. Message layouts (`BubbleMessageRow`/`DiscordMessageRow`/
 * `IrcMessageRow`) all render this the same way, right after the message
 * body, only for non-redacted, non-media, decrypted messages.
 */
export function LinkPreviewForMessage({ body, roomId }: LinkPreviewForMessageProps) {
  const linkPreviewsEnabled = useFlag("link_previews");
  const url = linkPreviewsEnabled ? firstUrlInText(body) : null;
  if (!url) return null;
  return <LinkPreviewCard roomId={roomId} url={url} />;
}
