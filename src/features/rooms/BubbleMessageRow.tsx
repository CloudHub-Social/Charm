import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { LinkPreviewForMessage } from "./linkPreview/LinkPreviewForMessage";
import { MediaMessage } from "./media/MediaMessage";
import { avatarColor, initials, resolveAvatar } from "./roomDisplay";
import { MessageActions } from "./MessageActions";
import { ReactionBar } from "./ReactionBar";
import { ReplyPreview } from "./ReplyPreview";
import { RichMessageContent, UndecryptedMessage } from "./RichMessageContent";
import { SeenByChips } from "./SeenByChips";
import { formatTime, type MessageRowLayoutProps } from "./messageRowShared";

/** Default layout (Charm 2.0 Spec 27): rounded, colored bubble, right-aligned
 * for the current user, avatar shown only on the first message of a
 * same-sender run. Moved verbatim out of the old monolithic `MessageRow` —
 * this is the shipped behavior every existing user already has. */
export function BubbleMessageRow({
  message,
  roomId,
  currentUserId,
  own,
  sameSenderAsPrev,
  sameSenderAsNext,
  canRedact,
  readers,
  senderNameByUserId,
  isNew,
  getActionsHandle,
  registerActionsRef,
  onReply,
  onReact,
  onEdit,
  onDelete,
  onCopy,
  onCopyLink,
  onResend,
  onDiscard,
  onJumpToMessage,
  onUserPillClick,
  onRoomPillClick,
  isPending,
  isError,
  disableRelationActions,
  isUndecrypted,
  rowKey,
}: MessageRowLayoutProps) {
  const showAvatar = !own && !sameSenderAsPrev;
  const showMeta = !sameSenderAsNext;

  return (
    <div
      id={`message-${message.event_id}`}
      className={cn(
        "group flex max-w-120 gap-2",
        sameSenderAsPrev ? "mt-0.5" : "mt-3",
        own && "ml-auto flex-row-reverse",
        isNew && "animate-in fade-in slide-in-from-bottom-2 duration-300 ease-out",
      )}
      onTouchStart={() => getActionsHandle(rowKey)?.startLongPress()}
      onTouchEnd={() => getActionsHandle(rowKey)?.cancelLongPress()}
      onTouchCancel={() => getActionsHandle(rowKey)?.cancelLongPress()}
      onTouchMove={() => getActionsHandle(rowKey)?.cancelLongPress()}
    >
      {!own &&
        (showAvatar ? (
          <Avatar size="sm">
            <AvatarImage
              src={resolveAvatar(message.sender_avatar_path, message.sender_avatar_url)}
              alt=""
            />
            <AvatarFallback
              style={{ background: avatarColor(message.sender) }}
              className="font-bold text-white"
            >
              {initials(message.sender, message.sender_display_name)}
            </AvatarFallback>
          </Avatar>
        ) : (
          <div className="w-6 shrink-0" />
        ))}
      <div className={cn("flex min-w-0 flex-col gap-0.5", own && "items-end")}>
        {showAvatar && (
          <span className="text-sm font-semibold text-secondary-foreground">
            {message.sender_display_name ?? message.sender}
          </span>
        )}
        {message.in_reply_to && !message.redacted && (
          <ReplyPreview
            reply={message.in_reply_to}
            onClick={() => onJumpToMessage(message.in_reply_to!.event_id)}
          />
        )}
        <div className="flex items-center gap-1">
          {!own && <div className="w-11 shrink-0" />}
          {message.redacted ? (
            <div className="w-fit rounded-md bg-secondary/50 px-3 py-[var(--message-row-padding-y)] text-[15px] italic text-muted-foreground">
              Message deleted
            </div>
          ) : message.media ? (
            <MediaMessage
              content={message.media}
              roomId={roomId}
              eventId={message.event_id}
              body={message.body}
            />
          ) : isUndecrypted ? (
            <UndecryptedMessage />
          ) : (
            <RichMessageContent
              body={message.body}
              formattedBody={message.formatted_body}
              currentUserId={currentUserId ?? ""}
              onUserPillClick={onUserPillClick}
              onRoomPillClick={onRoomPillClick}
              className={cn(
                "w-fit max-w-full rounded-md px-3 py-[var(--message-row-padding-y)] text-[15px]",
                own ? "bg-primary-solid text-primary-foreground" : "bg-secondary text-foreground",
                isError && "border border-destructive",
              )}
            />
          )}
          {!message.redacted && (
            <MessageActions
              ref={(el) => registerActionsRef(rowKey, el)}
              isOwn={own}
              canRedact={canRedact}
              disableRelationActions={disableRelationActions}
              isUndecrypted={isUndecrypted}
              isError={isError}
              className="opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100"
              onReply={onReply}
              onReact={onReact}
              onEdit={onEdit}
              onDelete={onDelete}
              onCopy={onCopy}
              onCopyLink={onCopyLink}
              onResend={onResend}
              onDiscard={onDiscard}
            />
          )}
        </div>
        {!message.redacted && !message.media && !isUndecrypted && (
          <LinkPreviewForMessage
            body={message.body}
            formattedBody={message.formatted_body}
            roomId={roomId}
            eventTsMs={message.timestamp_ms}
            edited={message.edited}
          />
        )}
        {!message.redacted && (
          <ReactionBar
            reactions={message.reactions}
            onToggle={onReact}
            disabled={disableRelationActions || isUndecrypted}
          />
        )}
        {showMeta && (
          <span className="font-mono text-[11px] text-muted-foreground">
            {formatTime(message.timestamp_ms)}
            {message.edited && " (edited)"}
            {isPending && " · sending…"}
            {isError && " · failed to send"}
          </span>
        )}
        {/* Deliberately not the shared Avatar/AvatarGroup components: those
            only offer sm/default/lg (24/32/40px), all too large for a
            read-receipt chip — the design calls for a much smaller 14px
            chip, matching the row's own meta text below the bubble rather
            than another avatar-sized element. Aligned with `own` (not
            unconditionally right-aligned) so the chips sit under the same
            edge as the timestamp above them instead of floating to the
            opposite side on another sender's left-aligned message. */}
        <SeenByChips
          readers={readers}
          senderNameByUserId={senderNameByUserId}
          className={cn("mt-0.5", own ? "justify-end" : "justify-start")}
        />
      </div>
    </div>
  );
}
