import { useQuery } from "@tanstack/react-query";
import { roomDetailsQueryKey } from "@/features/room-info/useRoomDetails";
import { useFlag } from "@/featureFlags";
import { getRoomDetails } from "@/lib/matrix";
import { firstUrlInText } from "./extractUrl";
import { LinkPreviewCard } from "./LinkPreviewCard";

interface LinkPreviewForMessageProps {
  body: string;
  formattedBody?: string | null;
  roomId: string;
}

/**
 * Spec 29: detects the first URL in a message's body and renders an
 * unfurled preview card for it, gated behind the `link_previews` feature
 * flag. Renders nothing (and, critically, never mounts {@link LinkPreviewCard}
 * — so no preview fetch is ever triggered) when the flag is off, the body
 * has no URL, or the room is encrypted. Message layouts
 * (`BubbleMessageRow`/`DiscordMessageRow`/`IrcMessageRow`) all render this
 * the same way, right after the message body, only for non-redacted,
 * non-media, decrypted messages.
 *
 * Privacy (spoilers): `formattedBody` is preferred over the plain-text
 * `body` fallback for URL detection (see `firstUrlInText`'s doc comment) —
 * a URL sitting inside `<span data-mx-spoiler>` in the rendered HTML is
 * excluded from the search, so a link the sender deliberately hid behind a
 * spoiler reveal doesn't get auto-unfurled (and thus effectively revealed
 * via the preview's title/thumbnail) before the reader clicks to reveal it.
 *
 * Privacy (E2EE): a link preview is fetched by asking the *homeserver* to
 * scrape the URL server-side (see `get_url_preview`'s Rust doc comment) —
 * that's unchanged from Charm 1.0's behavior and not a new leak for
 * unencrypted rooms. But inside an encrypted room the message body (and
 * therefore any URL in it) is only ever visible to the client because it was
 * decrypted locally; auto-fetching a preview would hand that URL back to the
 * homeserver, which is a real new information leak beyond what E2EE
 * promises. So previews are suppressed entirely for encrypted rooms in this
 * PR — no opt-in surface exists yet to make that trade-off deliberately.
 * (A future "opt in per encrypted room" toggle is a reasonable follow-up,
 * not built here.) `RoomDetails.is_encrypted` is read from the shared
 * `room-details` query cache (the same one `useRoomDetails` keeps warm for
 * the active room); until it resolves — or if it's simply unknown — this
 * defaults to treating the room as encrypted, i.e. suppressing the preview,
 * rather than assuming it's safe.
 */
export function LinkPreviewForMessage({ body, formattedBody, roomId }: LinkPreviewForMessageProps) {
  const linkPreviewsEnabled = useFlag("link_previews");
  const url = linkPreviewsEnabled ? firstUrlInText(body, formattedBody) : null;

  const { data: roomDetails } = useQuery({
    queryKey: roomDetailsQueryKey(roomId),
    queryFn: () => getRoomDetails(roomId),
    enabled: Boolean(url),
    staleTime: 5 * 60 * 1000,
  });
  const isEncrypted = roomDetails?.is_encrypted ?? true;

  if (!url || isEncrypted) return null;
  return <LinkPreviewCard roomId={roomId} url={url} />;
}
