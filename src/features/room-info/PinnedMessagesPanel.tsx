import { Pin, X } from "lucide-react";
import { useRoomDetails } from "./useRoomDetails";
import { usePinnedMessages } from "./usePinnedMessages";

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
  const pinnedEventIds = details?.pinned_event_ids ?? [];
  const { data: pinnedMessages, isLoading, isError } = usePinnedMessages(roomId, pinnedEventIds);

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
            <li key={message.event_id} className="border-b border-border last:border-b-0">
              <button
                type="button"
                onClick={() => onJumpToMessage(message.event_id)}
                className="flex w-full flex-col items-start gap-0.5 p-3 text-left hover:bg-accent"
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
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
