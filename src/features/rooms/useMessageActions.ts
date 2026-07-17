import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addBookmark,
  discardFailedMessage,
  listBookmarks,
  redactEvent,
  removeBookmark,
  resendMessage,
  toggleReaction,
  type BookmarkEntry,
  type RoomMessageSummary,
} from "@/lib/matrix";
import type { ReplyRef } from "@/lib/matrix";
import { useFlag } from "@/featureFlags";
import { isWebBuild } from "@/lib/platform";

// Shared with `SavedMessagesPanel` — same query, same key, so a change from
// either surface (a row-menu bookmark here, a removal there) is reflected
// in both instead of each holding its own out-of-sync snapshot. Review fix:
// this hook previously kept its own `useState<Set<string>>` seeded once
// from `listBookmarks()`, so removing a bookmark from `SavedMessagesPanel`
// never reached an already-mounted `ChatShell`'s independent state — the
// message menu kept showing "Remove bookmark" until the room changed. Both
// now read the same react-query cache entry.
const BOOKMARKS_QUERY_KEY = ["bookmarks"] as const;

interface UseMessageActionsOptions {
  roomId: string | null;
  setReplyTarget: (reply: ReplyRef | null) => void;
  setEditingEventId: (eventId: string | null) => void;
}

export function useMessageActions({
  roomId,
  setReplyTarget,
  setEditingEventId,
}: UseMessageActionsOptions) {
  const bookmarksEnabled = useFlag("bookmarks");
  const queryClient = useQueryClient();

  // Bookmarks are backed by a local per-account file the Tauri process
  // owns (see `SettingsScreen`'s `webUnsupported` note) — the web
  // companion build has no `invokeWeb` case for `list_bookmarks`, so
  // calling it there throws `UnsupportedCommand` into the console even
  // though the flag defaults off. Guard on `isWebBuild()` directly rather
  // than relying solely on the flag default, since a local override could
  // otherwise flip `bookmarksEnabled` on for a web build too.
  // Also gated on `roomId`: no active room means nothing in this hook's own
  // surface (the message action menu) can be bookmarked yet, so there's no
  // need for *this* hook instance to fetch — `SavedMessagesPanel`'s own
  // `useQuery` on the same key still populates the shared cache regardless.
  const fetchEnabled = bookmarksEnabled && !isWebBuild() && roomId !== null;
  const { data: bookmarks } = useQuery({
    queryKey: BOOKMARKS_QUERY_KEY,
    queryFn: listBookmarks,
    enabled: fetchEnabled,
  });

  // Which of *this room's* messages are currently bookmarked — a `Set` of
  // event ids scoped to `roomId`, not the full cross-room bookmarks list
  // (that's `SavedMessagesPanel`'s concern), so `MessageActions`' per-row
  // `isBookmarked` lookup stays a plain `Set.has`. Derived from the same
  // shared query `SavedMessagesPanel` reads, so a change from either
  // surface is reflected in both.
  const bookmarkedEventIds = useMemo(() => {
    if (!roomId || !fetchEnabled || !bookmarks) return new Set<string>();
    return new Set(bookmarks.filter((b) => b.room_id === roomId).map((b) => b.event_id));
  }, [bookmarks, roomId, fetchEnabled]);

  async function handleToggleReaction(targetEventId: string, key: string) {
    if (!roomId) return;
    try {
      await toggleReaction(roomId, targetEventId, key);
    } catch (err) {
      console.error(err);
    }
  }

  async function handleDelete(eventId: string, reason?: string | null): Promise<boolean> {
    if (!roomId) return false;
    try {
      await redactEvent(roomId, eventId, reason ?? undefined);
      return true;
    } catch (err) {
      console.error(err);
      return false;
    }
  }

  function handleReply(message: RoomMessageSummary) {
    setReplyTarget({
      event_id: message.event_id,
      sender: message.sender,
      sender_display_name: message.sender_display_name,
      preview: message.body,
    });
  }

  function handleEdit(eventId: string) {
    setReplyTarget(null);
    setEditingEventId(eventId);
  }

  /**
   * Retries a failed send in place via the send queue's own retry, keyed by
   * the failed local echo's transaction id (not its event id — a failed
   * send never gets a real one). Errors are swallowed the same way the
   * other handlers here do: the message just stays shown as failed and the
   * user can try again.
   */
  async function handleResend(transactionId: string) {
    if (!roomId) return;
    try {
      await resendMessage(roomId, transactionId);
    } catch (err) {
      console.error(err);
    }
  }

  /** Discards a failed send's local echo. See {@link handleResend}. */
  async function handleDiscard(transactionId: string) {
    if (!roomId) return;
    try {
      await discardFailedMessage(roomId, transactionId);
    } catch (err) {
      console.error(err);
    }
  }

  /**
   * Bookmarks a message (Spec 12) — purely local, no Matrix event sent.
   * Optimistically pushes a placeholder entry into the shared `["bookmarks"]`
   * query cache (rather than a hook-local `Set`, per the review fix above)
   * so both this room's action menu *and* an already-mounted
   * `SavedMessagesPanel` see the change immediately; `add_bookmark`'s
   * response isn't needed for that placeholder since presence in the list
   * (not its exact sender/preview/timestamp) is all `bookmarkedEventIds`
   * checks, and a follow-up invalidate reconciles the full resolved entry.
   */
  async function handleBookmark(eventId: string) {
    if (!roomId) return;
    const optimisticEntry: BookmarkEntry = {
      room_id: roomId,
      event_id: eventId,
      saved_at_ms: Date.now(),
      sender: "",
      sender_display_name: null,
      body_preview: "",
      timestamp_ms: Date.now(),
    };
    queryClient.setQueryData<BookmarkEntry[]>(BOOKMARKS_QUERY_KEY, (prev) => [
      ...(prev ?? []).filter((b) => b.event_id !== eventId),
      optimisticEntry,
    ]);
    try {
      await addBookmark(roomId, eventId);
      await queryClient.invalidateQueries({ queryKey: BOOKMARKS_QUERY_KEY });
    } catch (err) {
      console.error(err);
      // Roll back the optimistic update on failure — otherwise the menu
      // would keep showing "Remove bookmark" for a save that never landed.
      queryClient.setQueryData<BookmarkEntry[]>(BOOKMARKS_QUERY_KEY, (prev) =>
        (prev ?? []).filter((b) => b.event_id !== eventId),
      );
    }
  }

  /** Removes a bookmark from the message action menu. See {@link handleBookmark}. */
  async function handleUnbookmark(eventId: string) {
    const previous = bookmarks;
    queryClient.setQueryData<BookmarkEntry[]>(BOOKMARKS_QUERY_KEY, (prev) =>
      (prev ?? []).filter((b) => b.event_id !== eventId),
    );
    try {
      await removeBookmark(eventId);
      await queryClient.invalidateQueries({ queryKey: BOOKMARKS_QUERY_KEY });
    } catch (err) {
      console.error(err);
      // Review fix: blindly re-adding the id on failure can be wrong if a
      // concurrent request (e.g. the same removal from `SavedMessagesPanel`
      // in another tab/window) already succeeded — invalidate the shared
      // bookmarks query instead, so both surfaces refetch and reconcile
      // against what's actually persisted, matching the pattern
      // `SavedMessagesPanel.handleRemove` already uses. (`previous` is used
      // only if that refetch itself fails, to avoid leaving the cache on
      // the too-eager optimistic removal above forever.)
      //
      // Review fix: `previous` can itself be `undefined` — the bookmarks
      // query is disabled (and its data undefined) whenever `roomId` is
      // null, which a room-leave racing this same in-flight unbookmark can
      // trigger. Restoring `undefined` here would blow away whatever's
      // actually in the cache (e.g. from a concurrent successful refetch)
      // rather than leaving it alone, so only restore when there's an
      // actual snapshot to restore.
      queryClient.invalidateQueries({ queryKey: BOOKMARKS_QUERY_KEY }).catch(() => {
        if (previous !== undefined) {
          queryClient.setQueryData<BookmarkEntry[]>(BOOKMARKS_QUERY_KEY, previous);
        }
      });
    }
  }

  return {
    handleToggleReaction,
    handleDelete,
    handleReply,
    handleEdit,
    handleResend,
    handleDiscard,
    handleBookmark,
    handleUnbookmark,
    bookmarkedEventIds,
  };
}
