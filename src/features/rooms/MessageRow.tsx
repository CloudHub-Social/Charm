import { useAtomValue } from "jotai";
import { messageLayoutAtom } from "@/features/appearance/atoms";
import type { RoomMessageSummary } from "@/lib/matrix";
import { BubbleMessageRow } from "./BubbleMessageRow";
import { DiscordMessageRow } from "./DiscordMessageRow";
import { IrcMessageRow } from "./IrcMessageRow";
import { messageRowKey, type MessageRowLayoutProps } from "./messageRowShared";
import type { MessageActionsHandle } from "./MessageActions";

export { messageRowKey } from "./messageRowShared";

interface MessageRowProps {
  message: RoomMessageSummary;
  roomId: string;
  currentUserId?: string;
  /** Whether `message.sender === currentUserId`. */
  own: boolean;
  sameSenderAsPrev: boolean;
  sameSenderAsNext: boolean;
  /** Already resolved: own messages are always redactable regardless of this. */
  canRedact: boolean;
  /** User ids with a read receipt on this message. */
  readers: string[];
  /** Best-effort user id -> display name lookup for the "Read by {name}" tooltip; falls back to the user id when absent. */
  senderNameByUserId: Map<string, string>;
  /** Whether this message just arrived (not part of the initial/paginated load) — plays a slide-up+fade entrance. */
  isNew: boolean;
  /** Looks up this row's mounted `MessageActions` handle, for forwarding a long-press. */
  getActionsHandle: (key: string) => MessageActionsHandle | undefined;
  /** Registers/unregisters this row's `MessageActions` handle as it mounts/unmounts. */
  registerActionsRef: (key: string, handle: MessageActionsHandle | null) => void;
  onReply: () => void;
  onReact: (key: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  onCopy: () => void;
  /** See `MessageRowLayoutProps.onJumpToMessage`. */
  onJumpToMessage: (eventId: string) => void;
  onUserPillClick?: (userId: string, label: string) => void;
  onRoomPillClick?: (roomIdentifier: string) => void;
}

/**
 * Thin dispatcher (Charm 2.0 Spec 27): owns the data plumbing shared by
 * every layout mode (send-state derivation, undecrypted/redaction flags,
 * row identity), then picks a presentational component based on the
 * `messageLayout` appearance setting — read directly via the Jotai atom
 * rather than prop-drilled through `ChatShell`, since it's local
 * presentation state, same as the `messageLayout` field it mirrors.
 *
 * `BubbleMessageRow` is the original (and default) implementation, moved
 * verbatim; `DiscordMessageRow`/`IrcMessageRow` are new. Grouping
 * (`sameSenderAsPrev`/`sameSenderAsNext`) stays computed once in
 * `ChatShell` and is handed to all three — layout-agnostic, just consumed
 * differently (or, for IRC, not consumed at all).
 */
export function MessageRow(props: MessageRowProps) {
  const messageLayout = useAtomValue(messageLayoutAtom);
  const { message } = props;

  const isPending = message.send_state.state === "pending";
  const isError = message.send_state.state === "error";
  // `send_state` flips to "sent" as soon as the homeserver acks the event,
  // but `event_id` only becomes the real Matrix event id once a later
  // `timeline:update` replaces the echo — until then it's still the
  // send-queue transaction id (or, on a failed send, stays that way
  // permanently). Real Matrix event ids always start with "$", so this is a
  // reliable way to tell the two apart without depending on send_state timing.
  const hasRealEventId = message.event_id.startsWith("$");
  const disableRelationActions = isPending || !hasRealEventId;
  // `is_undecrypted` is the authoritative signal, set server-side only for a
  // `MsgLikeKind::UnableToDecrypt` timeline item — never derive this from
  // `body` text (a real decrypted message can legitimately contain the
  // placeholder string). If the room key arrives later,
  // `Timeline::retry_decryption` re-emits the item with real content and
  // `is_undecrypted` flips back to `false`.
  const isUndecrypted = message.is_undecrypted;
  const rowKey = messageRowKey(message);

  const layoutProps: MessageRowLayoutProps = {
    ...props,
    isPending,
    isError,
    disableRelationActions,
    isUndecrypted,
    rowKey,
  };

  switch (messageLayout) {
    case "discord":
      return <DiscordMessageRow {...layoutProps} />;
    case "irc":
      return <IrcMessageRow {...layoutProps} />;
    case "bubble":
    default:
      return <BubbleMessageRow {...layoutProps} />;
  }
}
