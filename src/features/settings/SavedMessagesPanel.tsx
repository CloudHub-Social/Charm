import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, BookmarkX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { logAndIgnore } from "@/lib/logAndIgnore";
import { listBookmarks, listRooms, removeBookmark, type BookmarkEntry } from "@/lib/matrix";
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

function formatSavedAt(timestampMs: number): string {
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

  async function handleRemove(eventId: string) {
    // Optimistic removal, same pattern `useMessageActions.handleUnbookmark`
    // uses for the in-room action menu — this list is the other place a
    // bookmark can be removed from (per the spec's "Removing a bookmark"
    // section).
    queryClient.setQueryData<BookmarkEntry[]>(BOOKMARKS_QUERY_KEY, (prev) =>
      (prev ?? []).filter((b) => b.event_id !== eventId),
    );
    try {
      await removeBookmark(eventId);
    } catch (err) {
      logAndIgnore(err);
      await queryClient.invalidateQueries({ queryKey: BOOKMARKS_QUERY_KEY });
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
                    <span>{formatSavedAt(bookmark.saved_at_ms)}</span>
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
