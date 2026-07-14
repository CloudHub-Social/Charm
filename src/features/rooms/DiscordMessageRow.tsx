import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { LinkPreviewForMessage } from "./linkPreview/LinkPreviewForMessage";
import { MediaMessage } from "./media/MediaMessage";
import { avatarColor, initials, resolveAvatar } from "./roomDisplay";
import { MessageActions } from "./MessageActions";
import { ReactionBar } from "./ReactionBar";
import { ReplyPreview } from "./ReplyPreview";
import { RichMessageContent, UndecryptedMessage } from "./RichMessageContent";
import { MAX_RECEIPT_AVATARS, formatTime, type MessageRowLayoutProps } from "./messageRowShared";

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
  currentUserId,
  own,
  sameSenderAsPrev,
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
  onJumpToMessage,
  onUserPillClick,
  onRoomPillClick,
  isPending,
  isError,
  disableRelationActions,
  isUndecrypted,
  rowKey,
}: MessageRowLayoutProps) {
  const showHeader = !sameSenderAsPrev;

  return (
    <div
      id={`message-${message.event_id}`}
      className={cn(
        "group flex max-w-160 gap-2",
        sameSenderAsPrev ? "mt-0.5" : "mt-3",
        isNew && "animate-in fade-in slide-in-from-bottom-2 duration-300 ease-out",
      )}
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
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate text-sm font-semibold text-secondary-foreground">
              {message.sender_display_name ?? message.sender}
            </span>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
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
            onClick={() => onJumpToMessage(message.in_reply_to!.event_id)}
          />
        )}
        <div className="flex min-w-0 items-center gap-1">
          {message.redacted ? (
            <div className="text-[15px] italic text-muted-foreground">Message deleted</div>
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
                "text-[15px] text-foreground",
                isError && "rounded-md border border-destructive px-1",
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
              className="opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100"
              onReply={onReply}
              onReact={onReact}
              onEdit={onEdit}
              onDelete={onDelete}
              onCopy={onCopy}
            />
          )}
        </div>
        {!message.redacted && !message.media && !isUndecrypted && (
          <LinkPreviewForMessage
            body={message.body}
            formattedBody={message.formatted_body}
            roomId={roomId}
          />
        )}
        {!message.redacted && (
          <ReactionBar
            reactions={message.reactions}
            onToggle={onReact}
            disabled={disableRelationActions || isUndecrypted}
          />
        )}
        {!showHeader && (message.edited || isPending || isError) && (
          <span className="font-mono text-[11px] text-muted-foreground">
            {message.edited && "(edited)"}
            {isPending && (message.edited ? " · sending…" : "sending…")}
            {isError && (message.edited ? " · failed to send" : "failed to send")}
          </span>
        )}
        {readers.length > 0 && (
          <TooltipProvider>
            {/* Deliberately not the shared Avatar/AvatarGroup components:
                those only offer sm/default/lg (24/32/40px), all too large
                for a read-receipt chip — the design calls for a much
                smaller 14px chip. */}
            <div className="mt-0.5 flex items-center gap-[3px]">
              {readers.slice(0, MAX_RECEIPT_AVATARS).map((userId) => {
                const readerName = senderNameByUserId.get(userId) ?? userId;
                return (
                  <Tooltip key={userId}>
                    <TooltipTrigger asChild>
                      {/* tabIndex={0}: keyboard/screen-reader users can tab
                          to a chip and get the same "Read by {name}" info a
                          mouse hover gives — not just decorative. */}
                      {/* oxlint-disable jsx-a11y/no-noninteractive-tabindex */}
                      <span
                        tabIndex={0}
                        style={{ background: avatarColor(userId) }}
                        className="flex size-3.5 shrink-0 items-center justify-center rounded-full text-[7px] font-bold text-white ring-1 ring-background"
                      >
                        {initials(userId, senderNameByUserId.get(userId) ?? null)}
                      </span>
                      {/* oxlint-enable jsx-a11y/no-noninteractive-tabindex */}
                    </TooltipTrigger>
                    <TooltipContent>Read by {readerName}</TooltipContent>
                  </Tooltip>
                );
              })}
              {readers.length > MAX_RECEIPT_AVATARS && (
                <span className="flex size-3.5 shrink-0 items-center justify-center rounded-full bg-muted text-[7px] font-bold text-muted-foreground ring-1 ring-background">
                  +{readers.length - MAX_RECEIPT_AVATARS}
                </span>
              )}
            </div>
          </TooltipProvider>
        )}
      </div>
    </div>
  );
}
