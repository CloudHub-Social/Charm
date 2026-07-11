import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { MediaMessage } from "./media/MediaMessage";
import { avatarColor, initials, resolveAvatar } from "./roomDisplay";
import { MessageActions } from "./MessageActions";
import { ReactionBar } from "./ReactionBar";
import { ReplyPreview } from "./ReplyPreview";
import { sanitizeMatrixHtml } from "./composerSanitize";
import {
  MAX_RECEIPT_AVATARS,
  formatTime,
  handleMessageLinkClick,
  type MessageRowLayoutProps,
} from "./messageRowShared";

/** Default layout (Charm 2.0 Spec 27): rounded, colored bubble, right-aligned
 * for the current user, avatar shown only on the first message of a
 * same-sender run. Moved verbatim out of the old monolithic `MessageRow` —
 * this is the shipped behavior every existing user already has. */
export function BubbleMessageRow({
  message,
  roomId,
  own,
  sameSenderAsPrev,
  sameSenderAsNext,
  canRedact,
  readers,
  getActionsHandle,
  registerActionsRef,
  onReply,
  onReact,
  onEdit,
  onDelete,
  onCopy,
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
            onClick={() => {
              document
                .getElementById(`message-${message.in_reply_to?.event_id}`)
                ?.scrollIntoView({ behavior: "smooth", block: "center" });
            }}
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
          ) : message.formatted_body ? (
            // Re-sanitized here rather than trusted from the sender —
            // `formatted_body` crosses IPC as untrusted content from
            // whoever sent the event (any client, not just this
            // one), so the Matrix-allowlist sanitizer runs on both
            // the send path (`serializeComposerContent`) and this
            // render path independently.
            //
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- onClick only delegates to real <a> elements inside the sanitized HTML, which are natively keyboard-operable; the div itself isn't interactive
            <div
              className={cn(
                "w-fit rounded-md px-3 py-[var(--message-row-padding-y)] text-[15px] [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-2 [&_code]:rounded [&_code]:bg-black/10 [&_code]:px-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5",
                own ? "bg-primary-solid text-primary-foreground" : "bg-secondary text-foreground",
                isError && "border border-destructive",
              )}
              // eslint-disable-next-line react/no-danger -- sanitized above via sanitizeMatrixHtml
              dangerouslySetInnerHTML={{
                __html: sanitizeMatrixHtml(message.formatted_body),
              }}
              onClick={handleMessageLinkClick}
            />
          ) : (
            <div
              className={cn(
                "w-fit rounded-md px-3 py-[var(--message-row-padding-y)] text-[15px]",
                own ? "bg-primary-solid text-primary-foreground" : "bg-secondary text-foreground",
                isError && "border border-destructive",
              )}
            >
              {message.body}
            </div>
          )}
          {!message.redacted && (
            <MessageActions
              ref={(el) => registerActionsRef(rowKey, el)}
              isOwn={own}
              canRedact={canRedact}
              disableRelationActions={disableRelationActions}
              isUndecrypted={isUndecrypted}
              className="opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100"
              onReply={onReply}
              onReact={onReact}
              onEdit={onEdit}
              onDelete={onDelete}
              onCopy={onCopy}
            />
          )}
        </div>
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
        {readers.length > 0 && (
          <AvatarGroup className="mt-0.5 justify-end">
            {readers.slice(0, MAX_RECEIPT_AVATARS).map((userId) => (
              <Avatar key={userId} size="sm">
                <AvatarFallback
                  style={{ background: avatarColor(userId) }}
                  className="font-bold text-white"
                >
                  {initials(userId, null)}
                </AvatarFallback>
              </Avatar>
            ))}
            {readers.length > MAX_RECEIPT_AVATARS && (
              <AvatarGroupCount>+{readers.length - MAX_RECEIPT_AVATARS}</AvatarGroupCount>
            )}
          </AvatarGroup>
        )}
      </div>
    </div>
  );
}
