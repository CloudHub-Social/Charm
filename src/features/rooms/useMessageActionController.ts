import { useEffect, useRef, useState } from "react";
import { useFlag } from "@/featureFlags";
import { eventPermalink, userIdServerName } from "@/lib/matrixPermalink";
import { isWebBuild } from "@/lib/platform";
import { logAndIgnore } from "@/lib/logAndIgnore";
import type { ReplyRef, RoomMessageSummary } from "@/lib/matrix";
import type { MessageActionsHandle } from "./MessageActions";
import { useMessageActions } from "./useMessageActions";

type MessageActionDialogKind = "delete" | "report" | "source" | "history" | "forward";

export interface MessageActionDialogTarget {
  kind: MessageActionDialogKind;
  roomId: string;
  eventId: string;
}

interface UseMessageActionControllerOptions {
  roomId: string | null;
  currentUserId: string;
  setReplyTarget: (reply: ReplyRef | null) => void;
  setEditingEventId: (eventId: string | null) => void;
  mutationsDisabled?: boolean;
}

export function useMessageActionController({
  roomId,
  currentUserId,
  setReplyTarget,
  setEditingEventId,
  mutationsDisabled = false,
}: UseMessageActionControllerOptions) {
  const messageActionParityEnabled = useFlag("message_action_parity");
  const composerParityEnabled = useFlag("composer_parity");
  const [dialogTarget, setDialogTarget] = useState<MessageActionDialogTarget | null>(null);
  const actionsRegistryRef = useRef<{
    roomId: string | null;
    handles: Map<string, MessageActionsHandle>;
  }>({ roomId, handles: new Map() });
  if (actionsRegistryRef.current.roomId !== roomId) {
    actionsRegistryRef.current = { roomId, handles: new Map() };
  }
  const permalinkViaServer = userIdServerName(currentUserId);
  const actions = useMessageActions({ roomId, setReplyTarget, setEditingEventId });

  // A target carries the room it was opened in. Deriving the visible target
  // against the active room prevents even a single stale render from combining
  // an old event id with a newly selected room. The effect then discards the
  // hidden target so returning to the old room cannot reopen it.
  const visibleDialogTarget = dialogTarget?.roomId === roomId ? dialogTarget : null;
  useEffect(() => {
    setDialogTarget(null);
  }, [roomId, mutationsDisabled]);

  function openDialog(kind: MessageActionDialogKind, eventId: string) {
    if (!roomId || (mutationsDisabled && (kind === "delete" || kind === "report"))) return;
    setDialogTarget({ kind, roomId, eventId });
  }

  function closeDialog() {
    setDialogTarget(null);
  }

  async function confirmDialog(
    target: MessageActionDialogTarget,
    reason: string | null,
  ): Promise<boolean> {
    if (mutationsDisabled || target.roomId !== roomId) return false;
    if (target.kind === "delete") return actions.handleDelete(target.eventId, reason);
    if (target.kind === "report") return actions.handleReport(target.eventId, reason);
    return false;
  }

  function getActionsHandle(key: string) {
    return actionsRegistryRef.current.handles.get(key);
  }

  function registerActionsRef(key: string, handle: MessageActionsHandle | null) {
    if (handle) actionsRegistryRef.current.handles.set(key, handle);
    else actionsRegistryRef.current.handles.delete(key);
  }

  /** The loaded timeline is chronological. Never edit a local echo or a placeholder. */
  function editLastMessage(messages: readonly RoomMessageSummary[]): boolean {
    if (!composerParityEnabled || mutationsDisabled || !roomId) return false;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (
        message.sender !== currentUserId ||
        !message.event_id.startsWith("$") ||
        message.send_state.state !== "sent" ||
        message.redacted ||
        message.is_undecrypted ||
        message.media !== null
      ) {
        continue;
      }
      actions.handleEdit(message.event_id);
      return true;
    }
    return false;
  }

  function rowActions(message: RoomMessageSummary) {
    return {
      onReply: () => actions.handleReply(message),
      onReact: (emoji: string) => {
        if (!mutationsDisabled) actions.handleToggleReaction(message.event_id, emoji);
      },
      onEdit: () => actions.handleEdit(message.event_id),
      onDelete: () => {
        if (mutationsDisabled) return;
        if (messageActionParityEnabled) openDialog("delete", message.event_id);
        else void actions.handleDelete(message.event_id);
      },
      onCopy: () => navigator.clipboard?.writeText(message.body),
      onResend: () => {
        if (!mutationsDisabled && message.transaction_id) {
          void actions.handleResend(message.transaction_id);
        }
      },
      onDiscard: () => {
        if (message.transaction_id) void actions.handleDiscard(message.transaction_id);
      },
      onCopyLink: () => {
        if (!navigator.clipboard?.writeText || !permalinkViaServer || !roomId) return;
        navigator.clipboard
          .writeText(eventPermalink(roomId, message.event_id, permalinkViaServer))
          .catch(logAndIgnore);
      },
      onPin: () => {
        if (!mutationsDisabled) void actions.handlePin(message.event_id);
      },
      onUnpin: () => {
        if (!mutationsDisabled) void actions.handleUnpin(message.event_id);
      },
      onForward: messageActionParityEnabled
        ? () => openDialog("forward", message.event_id)
        : undefined,
      onViewSource: messageActionParityEnabled
        ? () => openDialog("source", message.event_id)
        : undefined,
      onReport: messageActionParityEnabled
        ? () => openDialog("report", message.event_id)
        : undefined,
      onViewEditHistory: messageActionParityEnabled
        ? () => openDialog("history", message.event_id)
        : undefined,
      // Bookmarks are local per-account state and unsupported by the web
      // transport. Omitting the handlers hides the menu entries entirely.
      onBookmark: isWebBuild() ? undefined : () => actions.handleBookmark(message.event_id),
      onUnbookmark: isWebBuild() ? undefined : () => actions.handleUnbookmark(message.event_id),
      isBookmarked: actions.bookmarkedEventIds.has(message.event_id),
    };
  }

  return {
    visibleDialogTarget,
    closeDialog,
    confirmDialog,
    getActionsHandle,
    registerActionsRef,
    editLastMessage,
    rowActions,
  };
}

export type MessageActionController = ReturnType<typeof useMessageActionController>;
