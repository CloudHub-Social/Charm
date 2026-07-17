import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  addBookmark,
  discardFailedMessage,
  listBookmarks,
  redactEvent,
  removeBookmark,
  resendMessage,
  toggleReaction,
  type RoomMessageSummary,
} from "@/lib/matrix";
import type { ReplyRef } from "@/lib/matrix";
import { logAndIgnore } from "@/lib/logAndIgnore";
import { useFlag } from "@/featureFlags";
import { isWebBuild } from "@/lib/platform";

// Shared with `SavedMessagesPanel`, which is the source of truth for the
// cross-room bookmarks list — keep this key in sync with that file's
// `BOOKMARKS_QUERY_KEY` so an invalidation here also refetches that view.
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
  // Which of *this room's* messages are currently bookmarked (Spec 12) — a
  // `Set` of event ids scoped to `roomId`, not the full cross-room bookmarks
  // list (that's `SavedMessagesPanel`'s concern), so `MessageActions`'
  // per-row `isBookmarked` lookup stays a plain `Set.has`. Refetched
  // whenever the active room changes; updated optimistically on
  // bookmark/unbookmark so the action menu reflects the change immediately
  // rather than waiting on a round trip.
  const [bookmarkedEventIds, setBookmarkedEventIds] = useState<Set<string>>(new Set());
  const bookmarksEnabled = useFlag("bookmarks");
  const queryClient = useQueryClient();

  useEffect(() => {
    // Bookmarks are backed by a local per-account file the Tauri process
    // owns (see `SettingsScreen`'s `webUnsupported` note) — the web
    // companion build has no `invokeWeb` case for `list_bookmarks`, so
    // calling it there throws `UnsupportedCommand` into the console even
    // though the flag defaults off. Guard on `isWebBuild()` directly rather
    // than relying solely on the flag default, since a local override could
    // otherwise flip `bookmarksEnabled` on for a web build too.
    if (!roomId || !bookmarksEnabled || isWebBuild()) {
      setBookmarkedEventIds(new Set());
      return undefined;
    }
    let cancelled = false;
    listBookmarks()
      .then((bookmarks) => {
        if (cancelled) return;
        setBookmarkedEventIds(
          new Set(bookmarks.filter((b) => b.room_id === roomId).map((b) => b.event_id)),
        );
      })
      .catch(logAndIgnore);
    return () => {
      cancelled = true;
    };
  }, [roomId, bookmarksEnabled]);

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

  /** Bookmarks a message (Spec 12) — purely local, no Matrix event sent. */
  async function handleBookmark(eventId: string) {
    if (!roomId) return;
    setBookmarkedEventIds((prev) => new Set(prev).add(eventId));
    try {
      await addBookmark(roomId, eventId);
    } catch (err) {
      console.error(err);
      // Roll back the optimistic update on failure — otherwise the menu
      // would keep showing "Remove bookmark" for a save that never landed.
      setBookmarkedEventIds((prev) => {
        const next = new Set(prev);
        next.delete(eventId);
        return next;
      });
    }
  }

  /** Removes a bookmark from the message action menu. See {@link handleBookmark}. */
  async function handleUnbookmark(eventId: string) {
    setBookmarkedEventIds((prev) => {
      const next = new Set(prev);
      next.delete(eventId);
      return next;
    });
    try {
      await removeBookmark(eventId);
    } catch (err) {
      console.error(err);
      // Review fix: blindly re-adding the id on failure can be wrong if a
      // concurrent request (e.g. the same removal from `SavedMessagesPanel`
      // in another tab/window) already succeeded — this optimistic local
      // state would then disagree with the source of truth. Invalidate the
      // shared bookmarks query instead, so both surfaces refetch and
      // reconcile against what's actually persisted, matching the pattern
      // `SavedMessagesPanel.handleRemove` already uses.
      queryClient.invalidateQueries({ queryKey: BOOKMARKS_QUERY_KEY }).catch(logAndIgnore);
      listBookmarks()
        .then((bookmarks) => {
          setBookmarkedEventIds(
            new Set(bookmarks.filter((b) => b.room_id === roomId).map((b) => b.event_id)),
          );
        })
        .catch(logAndIgnore);
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
