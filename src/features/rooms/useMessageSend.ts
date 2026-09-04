import { useEffect, useRef, useState, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  editMessage,
  runCommand,
  sendMessage,
  sendReply,
  unbanMember,
  setDisplayName,
  ignoreUser,
  unignoreUser,
  joinRoom,
} from "@/lib/matrix";
import type { ReplyRef, RoomSummary } from "@/lib/matrix";
import { isMessageSendingCommand, type ParsedSlashCommand } from "./slashCommands";
import { useFlag } from "@/featureFlags";

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
  mutationsBlockedRef?: RefObject<boolean>;
}

export function useMessageSend({
  room,
  editingEventId,
  replyTarget,
  setEditingEventId,
  setReplyTarget,
  stopTyping,
  mutationsBlockedRef,
}: UseMessageSendOptions) {
  const queryClient = useQueryClient();
  const [commandFeedback, setCommandFeedback] = useState<string | null>(null);
  const composerParityEnabled = useFlag("composer_parity");
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

  // Returns whether the underlying queue call actually succeeded — `ChatShell`
  // uses this to decide whether to scroll to present after a send/reply: if
  // the queueing call itself rejects (network/validation error) before any
  // local echo is created, there's no new message to scroll to, and
  // unconditionally scrolling would yank a user who was reading history to
  // the bottom for nothing.
  async function handleComposerSubmit(content: ComposerContent): Promise<boolean> {
    if (!room) return false;
    const targetRoom = room;

    if (editingEventId) {
      const eventId = editingEventId;
      setEditingEventId(null);
      stopTyping();
      try {
        await editMessage(
          targetRoom.room_id,
          eventId,
          content.body,
          content.formattedBody,
          content.mentions,
        );
      } catch (err) {
        console.error(err);
      }
      return false;
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
        await sendReply(
          targetRoom.room_id,
          replyingTo.event_id,
          content.body,
          content.formattedBody,
          content.mentions,
        );
      } else {
        await sendMessage(
          targetRoom.room_id,
          content.body,
          content.formattedBody,
          content.mentions,
        );
      }
      // The user may have switched rooms while this send was in flight —
      // same reasoning as `handleSlashCommand`'s own guard below. Without
      // this, `ChatShell`'s caller would scroll and mark-at-bottom/read
      // whatever room is *now* showing (a fresh `virtuosoRef`, since
      // Virtuoso remounts per room) for a message that landed in a
      // different, no-longer-active room.
      return currentRoomIdRef.current === targetRoom.room_id;
    } catch (err) {
      console.error(err);
      return false;
    }
  }

  // Returns whether the command succeeded — `ChatShell` uses this (together
  // with `parsed.command` itself) to decide whether a message actually got
  // appended and the view should scroll to it, since most slash commands
  // (`/topic`, `/invite`, `/kick`, `/ban`, ...) never send a
  // `RoomMessageSummary` even on success, and a failed `/me` doesn't either.
  async function handleSlashCommand(parsed: ParsedSlashCommand): Promise<boolean> {
    if (!room || mutationsBlockedRef?.current) return false;
    const targetRoomId = room.room_id;
    stopTyping();
    try {
      if (mutationsBlockedRef?.current) return false;
      if ("action" in parsed) {
        if (!composerParityEnabled) return false;
        const { command, args } = parsed;
        if (
          !args.length ||
          ((command === "ignore" || command === "unignore" || command === "join") &&
            args.length !== 1)
        ) {
          setCommandFeedback(
            command === "nick"
              ? "Usage: /nick <display name>"
              : command === "join"
                ? "Usage: /join <room id or alias>"
                : `Usage: /${command} <user id>${command === "unban" ? " [reason]" : ""}`,
          );
          return false;
        }
        try {
          switch (command) {
            case "join":
              await joinRoom(args[0]);
              break;
            case "unban":
              await unbanMember(
                targetRoomId,
                args[0],
                args.length > 1 ? args.slice(1).join(" ") : undefined,
              );
              break;
            case "nick":
              await setDisplayName(args.join(" "));
              break;
            case "ignore":
              await ignoreUser(args[0]);
              void queryClient.invalidateQueries({ queryKey: ["settings", "ignored-users"] });
              break;
            case "unignore":
              await unignoreUser(args[0]);
              void queryClient.invalidateQueries({ queryKey: ["settings", "ignored-users"] });
              break;
          }
          if (currentRoomIdRef.current === targetRoomId) setCommandFeedback(null);
        } catch {
          if (currentRoomIdRef.current === targetRoomId)
            setCommandFeedback(
              `Could not complete /${command}. Check the arguments and your permissions, then try again.`,
            );
          return false;
        }
        return currentRoomIdRef.current === targetRoomId;
      }
      if ("text" in parsed) {
        if (!composerParityEnabled) return false;
        if (parsed.command === "plain" && !parsed.text.trim()) {
          setCommandFeedback("Usage: /plain <message>");
          return false;
        }
        const suffix = parsed.command === "shrug" ? "¯\\_(ツ)_/¯" : "(╯°□°）╯︵ ┻━┻";
        const body =
          parsed.command === "plain"
            ? parsed.text
            : `${parsed.text}${parsed.text ? " " : ""}${suffix}`;
        // Like normal submission, consume the reply context at dispatch, not
        // after the await where a newly selected reply could be cleared.
        setReplyTarget(null);
        await sendMessage(targetRoomId, body, null, null);
        if (currentRoomIdRef.current !== targetRoomId) return false;
        setCommandFeedback(null);
        return true;
      }
      if (parsed.command === "notice" && !composerParityEnabled) return false;
      if (isMessageSendingCommand(parsed)) setReplyTarget(null);
      const result = await runCommand(targetRoomId, parsed.command, parsed.args);
      // The user may have switched rooms while this command was in flight —
      // don't show room A's feedback under room B, and don't leave a stale
      // failure banner up once a later command (in the still-active room)
      // succeeds.
      if (currentRoomIdRef.current !== targetRoomId) return false;
      setCommandFeedback(result.status === "success" ? null : result.message);
      return result.status === "success";
    } catch (err) {
      console.error(err);
      return false;
    }
  }

  return { commandFeedback, setCommandFeedback, handleComposerSubmit, handleSlashCommand };
}
