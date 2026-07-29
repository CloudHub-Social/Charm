import type { RoomMessageSummary } from "@/lib/matrix";
import { isDateDividerBoundary, formatDateDividerLabel } from "./timelineDividers";
import { MessageRow, messageRowKey } from "./MessageRow";
import type { MessageActionController } from "./useMessageActionController";

interface TimelineMessageRowProps {
  index: number;
  messages: RoomMessageSummary[];
  message: RoomMessageSummary;
  roomId: string;
  currentUserId: string;
  unreadStartIndex: number;
  canRedact: boolean;
  canPin: boolean;
  isPinned: boolean;
  readers: string[];
  senderNameByUserId: Map<string, string>;
  newMessageKeys: Set<string>;
  controller: MessageActionController;
  onJumpToMessage: (eventId: string) => void;
  onUserPillClick: (userId: string, label: string) => void;
  onRoomPillClick?: (roomIdentifier: string) => void;
}

export function TimelineMessageRow({
  index,
  messages,
  message,
  roomId,
  currentUserId,
  unreadStartIndex,
  canRedact,
  canPin,
  isPinned,
  readers,
  senderNameByUserId,
  newMessageKeys,
  controller,
  onJumpToMessage,
  onUserPillClick,
  onRoomPillClick,
}: TimelineMessageRowProps) {
  const own = message.sender === currentUserId;
  const prev = messages[index - 1];
  const next = messages[index + 1];
  const isGroupBreakAt = (candidateIndex: number) =>
    isDateDividerBoundary(messages, candidateIndex) || candidateIndex === unreadStartIndex;

  return (
    // Flex containment keeps layout-row top margins inside Virtuoso's measured
    // item box, preserving bottom detection and prepend anchoring.
    <div className="flex flex-col pb-1">
      {isDateDividerBoundary(messages, index) && (
        <div className="my-2 flex items-center gap-3 text-xs font-semibold text-muted-foreground">
          {formatDateDividerLabel(message.timestamp_ms)}
        </div>
      )}
      {index === unreadStartIndex && (
        <div className="my-2 flex items-center gap-2">
          <div className="h-px flex-1 bg-destructive-solid" />
          <span className="text-[11px] font-semibold text-destructive-solid">New messages</span>
          <div className="h-px flex-1 bg-destructive-solid" />
        </div>
      )}
      <MessageRow
        message={message}
        roomId={roomId}
        currentUserId={currentUserId}
        own={own}
        sameSenderAsPrev={prev?.sender === message.sender && !isGroupBreakAt(index)}
        sameSenderAsNext={next?.sender === message.sender && !isGroupBreakAt(index + 1)}
        canRedact={own || canRedact}
        canPin={canPin}
        isPinned={isPinned}
        readers={readers}
        senderNameByUserId={senderNameByUserId}
        // Own local echoes change identity once acknowledged; excluding them
        // prevents the acknowledgement from replaying the entrance animation.
        isNew={!own && newMessageKeys.has(messageRowKey(message))}
        getActionsHandle={controller.getActionsHandle}
        registerActionsRef={controller.registerActionsRef}
        {...controller.rowActions(message)}
        onJumpToMessage={onJumpToMessage}
        onUserPillClick={onUserPillClick}
        onRoomPillClick={onRoomPillClick}
      />
    </div>
  );
}
