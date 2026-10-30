import { MessageActions } from "./MessageActions";
import { messageActionSurfaceClassName } from "./messageActionSurface";
import type { MessageRowLayoutProps } from "./messageRowShared";

/** One permission and focus/ref contract for Bubble, Modern and IRC actions. */
export function MessageRowActions({
  message,
  currentUserId,
  own,
  rowKey,
  isUndecrypted,
  isError,
  disableRelationActions,
  onReact,
  canRedact,
  canPin,
  isPinned,
  registerActionsRef,
  onReply,
  onEdit,
  onDelete,
  onPin,
  onUnpin,
  onCopy,
  onCopyLink,
  onBookmark,
  onUnbookmark,
  isBookmarked,
  onResend,
  onDiscard,
  disableStableEventActions,
  mutationsDisabled = false,
  onForward,
  onViewSource,
  onReport,
  onViewEditHistory,
}: MessageRowLayoutProps) {
  return (
    <>
      {(!message.redacted || (!own && onReport)) && (
        <MessageActions
          ref={(el) => registerActionsRef(rowKey, el)}
          accountId={currentUserId ?? ""}
          isOwn={own}
          canEdit={
            own && !message.poll && message.text_editable === true && message.media === null
          }
          canReply={!message.poll}
          canRedact={canRedact}
          canPin={canPin}
          isPinned={isPinned}
          disableRelationActions={disableRelationActions}
          disableStableEventActions={disableStableEventActions}
          mutationsDisabled={mutationsDisabled}
          isUndecrypted={isUndecrypted}
          isError={isError}
          className={messageActionSurfaceClassName}
          onReply={onReply}
          onReact={onReact}
          onEdit={onEdit}
          onDelete={onDelete}
          onPin={onPin}
          onUnpin={onUnpin}
          onCopy={onCopy}
          onCopyLink={onCopyLink}
          onBookmark={onBookmark}
          onUnbookmark={onUnbookmark}
          isBookmarked={isBookmarked}
          onResend={onResend}
          onDiscard={onDiscard}
          onForward={message.poll ? undefined : onForward}
          onViewSource={onViewSource}
          onReport={onReport}
          isRedacted={message.redacted}
          isEdited={message.edited}
          onViewEditHistory={onViewEditHistory}
        />
      )}
    </>
  );
}
