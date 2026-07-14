import { useQuery } from "@tanstack/react-query";
import {
  ROOM_DETAILS_STALE_TIME_MS,
  roomDetailsQueryKey,
} from "@/features/room-info/useRoomDetails";
import { useFlag } from "@/featureFlags";
import { getRoomDetails } from "@/lib/matrix";
import { firstUrlInText } from "./extractUrl";
import { LinkPreviewCard } from "./LinkPreviewCard";

interface LinkPreviewForMessageProps {
  body: string;
  formattedBody?: string | null;
  roomId: string;
  eventTsMs?: number | null;
  edited?: boolean;
  /** Applied to a wrapping `<div>` around the card, but only when a card is
   * actually rendered — a caller that needs layout spacing before the
   * preview (e.g. IRC's single-line rows, which have no `flex-col` gap of
   * their own to rely on) can't apply that spacing externally without also
   * adding it for every message that has no preview to show at all. */
  wrapperClassName?: string;
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
 *
 * Historical accuracy vs. edits: `eventTsMs` is the *original* event's
 * timestamp — an edit replaces the rendered `body`/`formatted_body` but
 * `RoomMessageSummary` doesn't expose a separate replacement-event
 * timestamp. Forwarding the original `ts` for an edited message's preview
 * would ask the homeserver for the page's state near the *original* send
 * time, which can be stale or simply wrong for a URL the edit just
 * introduced or changed. So `ts` is omitted (falls back to "current") for
 * `edited` messages instead of using a timestamp known to be wrong.
 */
export function LinkPreviewForMessage({
  body,
  formattedBody,
  roomId,
  eventTsMs,
  edited,
  wrapperClassName,
}: LinkPreviewForMessageProps) {
  const linkPreviewsEnabled = useFlag("link_previews");
  const url = linkPreviewsEnabled ? firstUrlInText(body, formattedBody) : null;

  const { data: roomDetails } = useQuery({
    queryKey: roomDetailsQueryKey(roomId),
    queryFn: () => getRoomDetails(roomId),
    enabled: Boolean(url),
    staleTime: ROOM_DETAILS_STALE_TIME_MS,
  });
  const isEncrypted = roomDetails?.is_encrypted ?? true;

  if (!url || isEncrypted) return null;
  const card = <LinkPreviewCard roomId={roomId} url={url} eventTsMs={edited ? null : eventTsMs} />;
  return wrapperClassName ? <div className={wrapperClassName}>{card}</div> : card;
}
