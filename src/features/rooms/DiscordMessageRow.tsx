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

/** Flat, left-aligned, avatar-per-sender-block layout (Charm 2.0 Spec 27).
 * Own and others' messages look the same — no left/right split, no bubble
 * background. Avatar + name/time header shown once per same-sender run
 * (including the current user's own messages — unlike bubble mode, which
 * never shows the current user's avatar at all). Follow-up rows in the same
 * run drop the header and reveal a small timestamp on hover, left-padded to
 * align under the first message's body. */
export function DiscordMessageRow({
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
  const showHeader = !sameSenderAsPrev;
  const showMeta = !sameSenderAsNext;

  return (
    <div
      id={`message-${message.event_id}`}
      className={cn("group flex max-w-160 gap-2", sameSenderAsPrev ? "mt-0.5" : "mt-3")}
      onTouchStart={() => getActionsHandle(rowKey)?.startLongPress()}
      onTouchEnd={() => getActionsHandle(rowKey)?.cancelLongPress()}
      onTouchCancel={() => getActionsHandle(rowKey)?.cancelLongPress()}
      onTouchMove={() => getActionsHandle(rowKey)?.cancelLongPress()}
    >
      {showHeader ? (
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
        <div className="relative w-6 shrink-0">
          <span className="absolute left-0 top-0.5 hidden w-6 text-center font-mono text-[10px] text-muted-foreground group-hover:block">
            {formatTime(message.timestamp_ms).replace(/\s?[AP]M$/i, "")}
          </span>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {showHeader && (
          <span className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-secondary-foreground">
              {message.sender_display_name ?? message.sender}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {formatTime(message.timestamp_ms)}
              {message.edited && " (edited)"}
              {isPending && " · sending…"}
              {isError && " · failed to send"}
            </span>
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
          {message.redacted ? (
            <div className="text-[15px] italic text-muted-foreground">Message deleted</div>
          ) : message.media ? (
            <MediaMessage
              content={message.media}
              roomId={roomId}
              eventId={message.event_id}
              body={message.body}
            />
          ) : message.formatted_body ? (
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- onClick only delegates to real <a> elements inside the sanitized HTML, which are natively keyboard-operable; the div itself isn't interactive
            <div
              className={cn(
                "text-[15px] text-foreground [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-2 [&_code]:rounded [&_code]:bg-black/10 [&_code]:px-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5",
                isError && "rounded-md border border-destructive px-1",
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
                "text-[15px] text-foreground",
                isError && "rounded-md border border-destructive px-1",
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
        {showMeta && !showHeader && (isPending || isError) && (
          <span className="font-mono text-[11px] text-muted-foreground">
            {isPending && "sending…"}
            {isError && "failed to send"}
          </span>
        )}
        {readers.length > 0 && (
          <AvatarGroup className="mt-0.5">
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
