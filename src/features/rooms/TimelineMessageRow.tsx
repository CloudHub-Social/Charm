import type { RoomMessageSummary } from "@/lib/matrix";
import { useDisplayFormats } from "@/features/appearance/useDisplayFormats";
import {
  isDateDividerBetween,
  isDateDividerBoundary,
  formatDateDividerLabel,
} from "./timelineDividers";
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
  highlightedEventId?: string | null;
  controller: MessageActionController;
  mutationsDisabled?: boolean;
  onJumpToMessage: (eventId: string) => void;
  onSenderClick?: (userId: string, label: string) => void;
  onUserPillClick: (userId: string, label: string) => void;
  onRoomPillClick?: (roomIdentifier: string) => void;
  previousTimelineTimestampMs?: number | null;
  hasNoticesBefore?: boolean;
  hasNoticesBeforeNext?: boolean;
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
  highlightedEventId = null,
  controller,
  mutationsDisabled = false,
  onJumpToMessage,
  onSenderClick,
  onUserPillClick,
  onRoomPillClick,
  previousTimelineTimestampMs,
  hasNoticesBefore = false,
  hasNoticesBeforeNext = false,
}: TimelineMessageRowProps) {
  const own = message.sender === currentUserId;
  const { dateFormat } = useDisplayFormats();
  const prev = messages[index - 1];
  const next = messages[index + 1];
  const isGroupBreakAt = (candidateIndex: number) =>
    isDateDividerBoundary(messages, candidateIndex) || candidateIndex === unreadStartIndex;
  const showDateDivider =
    previousTimelineTimestampMs === undefined
      ? isDateDividerBoundary(messages, index)
      : isDateDividerBetween(previousTimelineTimestampMs, message.timestamp_ms);

  return (
    // Flex containment keeps layout-row top margins inside Virtuoso's measured
    // item box, preserving bottom detection and prepend anchoring.
    <div
      className={
        highlightedEventId === message.event_id
          ? "flex flex-col rounded-md bg-primary/10 pb-1 ring-2 ring-primary/60 transition-colors"
          : "flex flex-col pb-1"
      }
      data-message-event-id={message.event_id}
      data-jump-highlighted={highlightedEventId === message.event_id || undefined}
    >
      {showDateDivider && (
        <div className="my-2 flex items-center gap-3 text-xs font-semibold text-muted-foreground">
          {formatDateDividerLabel(message.timestamp_ms, undefined, undefined, dateFormat)}
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
        sameSenderAsPrev={
          prev?.sender === message.sender && !hasNoticesBefore && !isGroupBreakAt(index)
        }
        sameSenderAsNext={
          next?.sender === message.sender && !hasNoticesBeforeNext && !isGroupBreakAt(index + 1)
        }
        canRedact={own || canRedact}
        canPin={canPin}
        isPinned={isPinned}
        readers={readers}
        senderNameByUserId={senderNameByUserId}
        // Own local echoes change identity once acknowledged; excluding them
        // prevents the acknowledgement from replaying the entrance animation.
        isNew={!own && newMessageKeys.has(messageRowKey(message))}
        mutationsDisabled={mutationsDisabled}
        getActionsHandle={controller.getActionsHandle}
        registerActionsRef={controller.registerActionsRef}
        {...controller.rowActions(message)}
        onJumpToMessage={onJumpToMessage}
        onSenderClick={onSenderClick}
        onUserPillClick={onUserPillClick}
        onRoomPillClick={onRoomPillClick}
      />
    </div>
  );
}
