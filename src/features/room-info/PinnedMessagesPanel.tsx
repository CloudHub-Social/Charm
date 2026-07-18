import { Pin, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { onTimelineUpdate, unpinEvent, type RoomMessageSummary } from "@/lib/matrix";
import { logAndIgnore } from "@/lib/logAndIgnore";
import { useRoomDetails } from "./useRoomDetails";
import { pinnedMessagesQueryKey, usePinnedMessages } from "./usePinnedMessages";
import type { PinnedMessageSummary } from "@bindings/PinnedMessageSummary";

/** Cheap "did this pinned message actually change" fingerprint, covering
 * the fields the panel renders — comparable across `PinnedMessageSummary`
 * (this panel's own query data) and `RoomMessageSummary` (a `timeline:update`
 * payload), since the two DTOs name the same content differently
 * (`preview`/`is_redacted` vs `body`/`redacted`). */
function pinnedSummarySignature(message: PinnedMessageSummary): string {
  return `${message.preview}|${message.is_redacted}`;
}
function timelineMessageSignature(message: RoomMessageSummary): string {
  return `${message.body}|${message.redacted}`;
}

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

  // Review fix: `spawn_timeline_listener` re-emits the *full* loaded-window
  // snapshot on every `timeline:update`, not just the changed messages — so
  // checking "is a pinned event anywhere in this update" was true on nearly
  // every unrelated update in an active room (any pinned message still in
  // the loaded window), triggering a refetch each time. This ref tracks the
  // last-known body/edited/redacted fingerprint per pinned event id (seeded
  // from `usePinnedMessages`' own query data below) so the listener can
  // tell an actual change from the routine full-snapshot resend.
  const knownSignaturesRef = useRef(new Map<string, string>());
  useEffect(() => {
    if (!pinnedMessages) return;
    for (const message of pinnedMessages) {
      knownSignaturesRef.current.set(message.event_id, pinnedSummarySignature(message));
    }
  }, [pinnedMessages]);

  // Review fix: `usePinnedMessages` only refetches when the *pinned id
  // list itself* changes (its query key includes `pinnedEventIds`) — an
  // edit or redaction to a message that stays pinned doesn't change that
  // list at all, so the panel would otherwise keep showing the stale
  // pre-edit/pre-redaction preview until something unrelated happened to
  // invalidate the query. Same pattern `SavedMessagesPanel` already uses
  // for the identical staleness problem on its own bookmark previews.
  //
  // Still doesn't catch an edit to a pinned event that's currently *outside*
  // the loaded timeline window — that event never appears in `update.messages`
  // at all, loaded-window-scoped like the rest of this update payload. A
  // manual reopen of the panel (which refetches via a fresh `pinnedEventIds`
  // query key change, or simply revisiting the room) still picks it up.
  useEffect(() => {
    // Review fix: `onTimelineUpdate`'s cleanup (the `unlisten` call below)
    // is unavoidably asynchronous — it wraps Tauri's own `listen()`, which
    // only ever resolves an `UnlistenFn`, never returns one synchronously —
    // so when `pinnedEventIds` changes, a new effect can register its own
    // listener before the previous one has actually been torn down. In
    // that window, an incoming `timeline:update` would run *both*
    // callbacks: the old one still closes over the previous
    // `pinnedEventIds`, so its `pinnedMessagesQueryKey(...)` targets a
    // now-stale query key — invalidating a cache entry nothing renders
    // from anymore instead of (or in addition to) the current one. This
    // `cancelled` flag makes the old callback a no-op the instant its own
    // effect is torn down, synchronously, independent of how long the
    // actual `unlisten()` call takes to resolve.
    let cancelled = false;
    const unlistenPromise = onTimelineUpdate((update) => {
      if (cancelled) return;
      if (update.room_id !== roomId) return;
      const touchesAPinnedMessage = update.messages.some((message) => {
        if (!pinnedEventIds.includes(message.event_id)) return false;
        const known = knownSignaturesRef.current.get(message.event_id);
        return known !== undefined && known !== timelineMessageSignature(message);
      });
      if (touchesAPinnedMessage) {
        void queryClient.invalidateQueries({
          queryKey: pinnedMessagesQueryKey(roomId, pinnedEventIds),
        });
      }
    });
    return () => {
      cancelled = true;
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
                  normal Pin/Unpin entry point) only renders for a message
                  that's actually mounted in the currently-loaded timeline
                  window — a message pinned long ago and now outside that
                  window has no reachable Unpin affordance anywhere else in
                  the app (jumping to it is also a no-op there; see
                  `onJumpToMessage`'s own doc comment). This button is the
                  one place *any* pinned row — not just a redacted one — can
                  still be unpinned from, so it's shown whenever the user has
                  permission at all, regardless of `is_redacted`. */}
              {canUnpin && (
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
