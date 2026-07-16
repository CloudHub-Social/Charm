import type { RoomMessageSummary } from "@/lib/matrix";
import type { MessageActionsHandle } from "./MessageActions";

/** Caps the read-receipt avatar stack under a message; the rest collapse into a "+N". */
export const MAX_RECEIPT_AVATARS = 3;

/**
 * Schemes a rendered `formatted_body` link is allowed to actually open —
 * matches the sanitizer's own URI allowlist (`composerSanitize.ts`) minus
 * `mxc:`, which isn't meaningful for `<a href>` (only `<img src>`), and
 * matches the `opener:allow-default-urls` Tauri capability this app grants,
 * so a link outside this set would be rejected at that layer too even if
 * this check were somehow bypassed.
 */
export function formatTime(timestampMs: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    new Date(timestampMs),
  );
}

/** Stable identity for a timeline item across the local-echo -> ack lifecycle. */
export function messageRowKey(message: RoomMessageSummary): string {
  return message.transaction_id ?? message.event_id;
}

/** Props common to all three layout components (`BubbleMessageRow`,
 * `DiscordMessageRow`, `IrcMessageRow`) — the data plumbing `MessageRow`
 * derives once and hands down unchanged regardless of which mode is active. */
export interface MessageRowLayoutProps {
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
  onCopyLink: () => void;
  /** Scrolls the timeline to a given loaded message by event id — used by the
   * reply-preview "jump to the replied-to message" click. Routed through the
   * Virtuoso instance (not a plain `document.getElementById(...)`
   * `scrollIntoView`) because a loaded-but-currently-offscreen message under
   * a virtualizer has no mounted DOM node to find; a no-op if the target
   * isn't in the currently-loaded `messages` (e.g. further back than
   * backward pagination has loaded). */
  onJumpToMessage: (eventId: string) => void;
  onUserPillClick?: (userId: string, label: string) => void;
  onRoomPillClick?: (roomIdentifier: string) => void;
  isPending: boolean;
  isError: boolean;
  disableRelationActions: boolean;
  isUndecrypted: boolean;
  rowKey: string;
}
