import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, BookmarkX } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { logAndIgnore } from "@/lib/logAndIgnore";
import {
  listBookmarks,
  listRooms,
  onTimelineUpdate,
  removeBookmark,
  type BookmarkEntry,
} from "@/lib/matrix";
import { SettingsCard, SettingTile } from "./components/SettingsCard";

const BOOKMARKS_QUERY_KEY = ["bookmarks"] as const;
const ROOMS_QUERY_KEY = ["bookmarks-rooms"] as const;

function useBookmarks() {
  return useQuery({
    queryKey: BOOKMARKS_QUERY_KEY,
    queryFn: listBookmarks,
  });
}

/** Best-effort room-name lookup for context ("which room") — bookmarks only
 * store `room_id`, so this resolves display names from the live room list.
 * A room the user has since left simply falls back to the bare id below. */
function useRoomNames() {
  return useQuery({
    queryKey: ROOMS_QUERY_KEY,
    queryFn: listRooms,
  });
}

function formatMessageDate(timestampMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestampMs));
}

interface SavedMessagesPanelProps {
  /** Jumps to a bookmarked message: selects its room and scrolls to it (Spec
   * 12's "jump to message" — same mechanism a reply-preview click uses,
   * loading the timeline around the event first if it isn't already loaded).
   * Wired by `RoomsScreen`, the component that owns room selection. */
  onJumpToMessage: (roomId: string, eventId: string) => void;
}

/**
 * Global "Saved messages" view (Spec 12): every bookmark across every room,
 * newest-saved first, with room context and a jump-to-message action. Reached
 * from Settings — bookmarks are personal/private, not a per-room concept, so
 * a per-room-list dropdown wouldn't fit; Settings is the app's existing
 * global (not room-scoped) navigation surface.
 */
export function SavedMessagesPanel({ onJumpToMessage }: SavedMessagesPanelProps) {
  const { data: bookmarks } = useBookmarks();
  const { data: rooms } = useRoomNames();
  const queryClient = useQueryClient();

  // Review fix: a bookmarked message's `body_preview` is resolved live from
  // an open room's timeline (see the Rust side's `list_bookmarks`), but
  // nothing previously refetched this query when that timeline changed —
  // an edit or redaction landing while this panel was already open and had
  // already resolved a preview would keep showing the stale pre-edit body
  // until something unrelated (e.g. a bookmark add/remove) happened to
  // trigger a refetch.
  //
  // `timeline:update` payloads are always a full snapshot of the room's
  // currently-loaded window, not a delta — so a bookmarked event's id shows
  // up in `update.messages` on nearly every update to that room (new
  // messages, reactions, etc.), not just an edit/redaction to that specific
  // event. Only invalidate when the tracked event's own content actually
  // changed since we last saw it: compare `body`+`redacted` against a
  // per-event signature cache rather than invalidating on mere presence.
  const bookmarksRef = useRef(bookmarks);
  bookmarksRef.current = bookmarks;
  const knownSignaturesRef = useRef(new Map<string, string>());
  useEffect(() => {
    const unlistenPromise = onTimelineUpdate((update) => {
      const current = bookmarksRef.current;
      if (!current) return;
      const knownSignatures = knownSignaturesRef.current;
      let changed = false;
      for (const message of update.messages) {
        const isBookmarked = current.some(
          (bookmark) =>
            bookmark.room_id === update.room_id && bookmark.event_id === message.event_id,
        );
        if (!isBookmarked) continue;
        const key = `${update.room_id}:${message.event_id}`;
        const signature = `${message.body}|${message.redacted}`;
        if (knownSignatures.get(key) !== signature) {
          knownSignatures.set(key, signature);
          changed = true;
        }
      }
      if (changed) {
        void queryClient.invalidateQueries({ queryKey: BOOKMARKS_QUERY_KEY });
      }
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(logAndIgnore);
    };
  }, [queryClient]);

  async function handleRemove(eventId: string) {
    // Optimistic removal, same pattern `useMessageActions.handleUnbookmark`
    // uses for the in-room action menu — this list is the other place a
    // bookmark can be removed from (per the spec's "Removing a bookmark"
    // section).
    const previous = bookmarks;
    queryClient.setQueryData<BookmarkEntry[]>(BOOKMARKS_QUERY_KEY, (prev) =>
      (prev ?? []).filter((b) => b.event_id !== eventId),
    );
    try {
      await removeBookmark(eventId);
      // Keep the shared bookmarks query in sync with other surfaces (e.g. a
      // mounted `ChatShell`'s message action menu via `useMessageActions`)
      // that read from the same query key, matching `useMessageActions`'s
      // own handleBookmark/handleUnbookmark pattern.
      await queryClient.invalidateQueries({ queryKey: BOOKMARKS_QUERY_KEY });
    } catch (err) {
      logAndIgnore(err);
      // Review fix: if the recovery refetch below *also* fails (not just
      // `removeBookmark` itself), the optimistic removal above was left in
      // place forever with nothing to reconcile it. `invalidateQueries`
      // resolves once its triggered refetch has *settled* — successfully or
      // not — it does not reject just because the underlying queryFn
      // failed, so a `.catch()`/try-await around it (what an earlier
      // version of this fix, and `useMessageActions.handleUnbookmark`,
      // both did) never actually runs on a genuine recovery-refetch
      // failure. The query's own resulting status is the only reliable
      // signal. Only then does the pre-optimistic snapshot get restored,
      // and only if it's actually defined (the shared query can have no
      // data yet for reasons unrelated to this removal).
      await queryClient.invalidateQueries({ queryKey: BOOKMARKS_QUERY_KEY });
      if (
        queryClient.getQueryState(BOOKMARKS_QUERY_KEY)?.status === "error" &&
        previous !== undefined
      ) {
        queryClient.setQueryData<BookmarkEntry[]>(BOOKMARKS_QUERY_KEY, previous);
      }
    }
  }

  const roomNameById = new Map((rooms ?? []).map((room) => [room.room_id, room.name]));

  return (
    <div className="max-w-lg space-y-6">
      <h1 className="text-lg font-bold text-foreground">Saved messages</h1>
      {bookmarks !== undefined && bookmarks.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Bookmark a message from its action menu to save it here.
        </p>
      )}
      {bookmarks !== undefined && bookmarks.length > 0 && (
        <SettingsCard>
          {bookmarks.map((bookmark) => (
            <SettingTile key={bookmark.event_id}>
              <div className="flex items-start justify-between gap-4">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => onJumpToMessage(bookmark.room_id, bookmark.event_id)}
                >
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="truncate font-medium text-foreground">
                      {roomNameById.get(bookmark.room_id) ?? bookmark.room_id}
                    </span>
                    <span>&middot;</span>
                    <span>{bookmark.sender_display_name ?? bookmark.sender}</span>
                    <span>&middot;</span>
                    {/* Review fix: show when the message was actually sent
                    (`timestamp_ms`), not when it was bookmarked
                    (`saved_at_ms`, which only drives this list's own sort
                    order) — a bookmark saved today for an old message
                    should show the old date, not today's. */}
                    <span>{formatMessageDate(bookmark.timestamp_ms)}</span>
                  </div>
                  <p className="mt-1 truncate text-sm text-foreground">{bookmark.body_preview}</p>
                </button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove bookmark"
                  onClick={() => handleRemove(bookmark.event_id).catch(logAndIgnore)}
                >
                  <BookmarkX />
                </Button>
              </div>
            </SettingTile>
          ))}
        </SettingsCard>
      )}
      {bookmarks === undefined && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Bookmark className="size-4" />
          Loading saved messages…
        </div>
      )}
    </div>
  );
}
