import { useEffect, useState } from "react";
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

  useEffect(() => {
    if (!roomId) {
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
  }, [roomId]);

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
      setBookmarkedEventIds((prev) => new Set(prev).add(eventId));
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
