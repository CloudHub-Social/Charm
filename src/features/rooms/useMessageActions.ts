import {
  discardFailedMessage,
  pinEvent,
  redactEvent,
  resendMessage,
  toggleReaction,
  unpinEvent,
  type RoomMessageSummary,
} from "@/lib/matrix";
import type { ReplyRef } from "@/lib/matrix";

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
   * Pins `eventId` in the room's `m.room.pinned_events` (Spec day-2/04).
   * `RoomDetails.pinned_event_ids` (and thus the pinned-messages panel/badge
   * that read it via `useRoomDetails`) updates itself off the
   * `room_details:update` push the resulting state event triggers — no
   * local optimistic update or query invalidation needed here.
   */
  async function handlePin(eventId: string) {
    if (!roomId) return;
    try {
      await pinEvent(roomId, eventId);
    } catch (err) {
      console.error(err);
    }
  }

  /** Unpins `eventId`. See {@link handlePin}. */
  async function handleUnpin(eventId: string) {
    if (!roomId) return;
    try {
      await unpinEvent(roomId, eventId);
    } catch (err) {
      console.error(err);
    }
  }

  return {
    handleToggleReaction,
    handleDelete,
    handleReply,
    handleEdit,
    handleResend,
    handleDiscard,
    handlePin,
    handleUnpin,
  };
}
