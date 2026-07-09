import { useEffect, useRef, useState } from "react";
import { editMessage, runCommand, sendMessage, sendReply } from "@/lib/matrix";
import type { ReplyRef, RoomSummary } from "@/lib/matrix";
import type { ParsedSlashCommand } from "./slashCommands";

interface ComposerContent {
  body: string;
  formattedBody: string | null;
  mentions: string[] | null;
}

interface UseMessageSendOptions {
  room: RoomSummary | null;
  editingEventId: string | null;
  replyTarget: ReplyRef | null;
  setEditingEventId: (eventId: string | null) => void;
  setReplyTarget: (reply: ReplyRef | null) => void;
  stopTyping: () => void;
}

export function useMessageSend({
  room,
  editingEventId,
  replyTarget,
  setEditingEventId,
  setReplyTarget,
  stopTyping,
}: UseMessageSendOptions) {
  const [commandFeedback, setCommandFeedback] = useState<string | null>(null);
  const roomId = room?.room_id ?? "";
  // Tracks the *currently viewed* room id across renders — used by
  // `handleSlashCommand`'s async continuation below to check whether the
  // user switched rooms mid-command, so a stale room's feedback isn't
  // misattributed to whatever room is showing now.
  const currentRoomIdRef = useRef(roomId);
  currentRoomIdRef.current = roomId;

  // Room-scoped, not persistent: a bad-args/permission-denied banner from
  // room A shouldn't still be showing once the user has switched to room B.
  useEffect(() => {
    setCommandFeedback(null);
  }, [roomId]);

  async function handleComposerSubmit(content: ComposerContent) {
    if (!room) return;
    const targetRoom = room;

    if (editingEventId) {
      const eventId = editingEventId;
      setEditingEventId(null);
      stopTyping();
      try {
        await editMessage(targetRoom.room_id, eventId, content.body);
      } catch (err) {
        console.error(err);
      }
      return;
    }

    const replyingTo = replyTarget;
    setReplyTarget(null);
    stopTyping();

    // No client-side optimistic echo any more (Spec 14): the room's live
    // `Timeline` creates the local echo itself the moment the send is queued
    // (with `send_state: "pending"`) and pushes it via `timeline:update`,
    // keyed on the SDK's own send-queue transaction id — the same id the
    // eventual synced event's `transaction_id` carries — so the echo is
    // replaced in place by the Timeline itself rather than reconciled here.
    // This call's return value (also that same transaction id) isn't needed
    // for rendering any more, only for triggering the send.
    try {
      if (replyingTo) {
        // Replies don't yet carry formatting/mentions — `send_reply` wasn't
        // extended in this pass (only `send_message` was, per spec scope); a
        // formatted reply falls back to its plain body.
        await sendReply(targetRoom.room_id, replyingTo.event_id, content.body);
      } else {
        await sendMessage(
          targetRoom.room_id,
          content.body,
          content.formattedBody,
          content.mentions,
        );
      }
    } catch (err) {
      console.error(err);
    }
  }

  async function handleSlashCommand(parsed: ParsedSlashCommand) {
    if (!room) return;
    const targetRoomId = room.room_id;
    stopTyping();
    try {
      const result = await runCommand(targetRoomId, parsed.command, parsed.args);
      // The user may have switched rooms while this command was in flight —
      // don't show room A's feedback under room B, and don't leave a stale
      // failure banner up once a later command (in the still-active room)
      // succeeds.
      if (currentRoomIdRef.current !== targetRoomId) return;
      setCommandFeedback(result.status === "success" ? null : result.message);
    } catch (err) {
      console.error(err);
    }
  }

  return { commandFeedback, setCommandFeedback, handleComposerSubmit, handleSlashCommand };
}
