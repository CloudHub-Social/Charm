import { Pin, X } from "lucide-react";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { onTimelineUpdate, unpinEvent } from "@/lib/matrix";
import { logAndIgnore } from "@/lib/logAndIgnore";
import { useRoomDetails } from "./useRoomDetails";
import { pinnedMessagesQueryKey, usePinnedMessages } from "./usePinnedMessages";

interface PinnedMessagesPanelProps {
  roomId: string;
  onClose: () => void;
  /** Reuses `ChatShell`'s `handleJumpToMessage` — the same loaded-messages
   * scroll-to mechanism the reply-preview "jump to source" click and
   * search-result click already use. A no-op if the target message isn't
   * (or is no longer) in the currently-loaded timeline window, same as
   * those two call sites. */
  onJumpToMessage: (eventId: string) => void;
}

// A stable fallback (not a fresh `[]` literal inline) so `pinnedEventIds`
// keeps the same reference across renders while `details` hasn't loaded
// yet — the `useEffect` below depends on `pinnedEventIds`, and a new array
// identity every render would tear down and re-subscribe its listener on
// every single render instead of only when the pinned list actually changes.
const EMPTY_PINNED_EVENT_IDS: readonly string[] = [];

function formatTimestamp(timestampMs: number): string {
  return new Date(timestampMs).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The room-state (`m.room.pinned_events`) pinned-messages list — a
 * right-panel slot alongside `MembersDrawer`, per Spec day-2/04. Lists
 * pinned events in the order the state event's `pinned` array carries them
 * (oldest-pinned-first), each with a jump-to-message action. Not to be
 * confused with the separate, per-user bookmark concept (day-2 Spec 12) —
 * this is the shared, room-visible-to-everyone list.
 */
export function PinnedMessagesPanel({
  roomId,
  onClose,
  onJumpToMessage,
}: PinnedMessagesPanelProps) {
  const { data: details } = useRoomDetails(roomId);
  const pinnedEventIds = details?.pinned_event_ids ?? EMPTY_PINNED_EVENT_IDS;
  const { data: pinnedMessages, isLoading, isError } = usePinnedMessages(roomId, pinnedEventIds);
  const canUnpin = details?.can.set_pinned_events ?? false;
  const queryClient = useQueryClient();

  // Review fix: `usePinnedMessages` only refetches when the *pinned id
  // list itself* changes (its query key includes `pinnedEventIds`) — an
  // edit or redaction to a message that stays pinned doesn't change that
  // list at all, so the panel would otherwise keep showing the stale
  // pre-edit/pre-redaction preview until something unrelated happened to
  // invalidate the query. Same pattern `SavedMessagesPanel` already uses
  // for the identical staleness problem on its own bookmark previews.
  useEffect(() => {
    const unlistenPromise = onTimelineUpdate((update) => {
      if (update.room_id !== roomId) return;
      const touchesAPinnedMessage = update.messages.some((message) =>
        pinnedEventIds.includes(message.event_id),
      );
      if (touchesAPinnedMessage) {
        void queryClient.invalidateQueries({
          queryKey: pinnedMessagesQueryKey(roomId, pinnedEventIds),
        });
      }
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(logAndIgnore);
    };
  }, [roomId, pinnedEventIds, queryClient]);

  function handleUnpin(eventId: string) {
    unpinEvent(roomId, eventId).catch(logAndIgnore);
  }

  return (
    <div className="flex w-full shrink-0 flex-col border-l border-border bg-card md:w-80">
      <div className="flex items-center justify-between border-b border-border p-4">
        <h2 className="text-[15px] font-bold text-foreground">Pinned messages</h2>
        <button
          type="button"
          aria-label="Close pinned messages"
          onClick={onClose}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      {isLoading && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}

      {isError && <p className="p-4 text-sm text-destructive">Couldn't load pinned messages.</p>}

      {pinnedMessages && pinnedMessages.length === 0 && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
          <Pin className="size-6" />
          <p>No pinned messages yet.</p>
        </div>
      )}

      {pinnedMessages && pinnedMessages.length > 0 && (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {pinnedMessages.map((message) => (
            <li
              key={message.event_id}
              className="flex items-stretch border-b border-border last:border-b-0"
            >
              <button
                type="button"
                onClick={() => onJumpToMessage(message.event_id)}
                className="flex min-w-0 flex-1 flex-col items-start gap-0.5 p-3 text-left hover:bg-accent"
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold text-foreground">
                    {message.sender_display_name ?? message.sender}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatTimestamp(message.timestamp_ms)}
                  </span>
                </span>
                <span className="line-clamp-2 text-sm text-muted-foreground">
                  {message.is_redacted
                    ? "This message was deleted."
                    : message.is_undecrypted
                      ? "Unable to decrypt message"
                      : message.preview}
                </span>
              </button>
              {/* Review fix: every timeline row's own `MessageActions` (the
                  normal Pin/Unpin entry point) is wrapped in `!message.redacted`,
                  so a pinned message that's later deleted has no reachable
                  Unpin affordance anywhere else in the app — leaving anyone
                  with permission unable to ever remove that stale pin. This
                  button is the one place a redacted pinned row can still be
                  unpinned from. */}
              {message.is_redacted && canUnpin && (
                <button
                  type="button"
                  aria-label="Unpin message"
                  onClick={() => handleUnpin(message.event_id)}
                  className="flex shrink-0 items-center px-3 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                >
                  <Pin className="size-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
