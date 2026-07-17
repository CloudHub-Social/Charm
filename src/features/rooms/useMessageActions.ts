import {
  discardFailedMessage,
  redactEvent,
  resendMessage,
  toggleReaction,
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

  return {
    handleToggleReaction,
    handleDelete,
    handleReply,
    handleEdit,
    handleResend,
    handleDiscard,
  };
}
