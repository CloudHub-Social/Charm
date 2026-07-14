import { cn } from "@/lib/utils";
import { LinkPreviewForMessage } from "./linkPreview/LinkPreviewForMessage";
import { MediaMessage } from "./media/MediaMessage";
import { nickColor } from "./roomDisplay";
import { MessageActions } from "./MessageActions";
import { ReactionBar } from "./ReactionBar";
import { RichMessageContent, UndecryptedMessage } from "./RichMessageContent";
import { formatTime, type MessageRowLayoutProps } from "./messageRowShared";

/** Single-line-per-message, `[HH:MM] <sender> body` layout (Charm 2.0 Spec
 * 27) — closest to a terminal chat client. Deliberately ignores
 * `sameSenderAsPrev`/`sameSenderAsNext`: real IRC clients repeat the nick on
 * every line rather than collapsing same-sender runs, so this component
 * simply doesn't consume that grouping (still computed by `ChatShell` for
 * the other two modes). No avatars, no bubble, no left/right split — own
 * messages are distinguished only by nick color, same as any other sender,
 * matching real IRC where you don't get special treatment. */
export function IrcMessageRow({
  message,
  roomId,
  currentUserId,
  own,
  canRedact,
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
  const nick = message.sender_display_name ?? message.sender;

  return (
    <div
      id={`message-${message.event_id}`}
      className={cn(
        "group flex items-baseline gap-1 py-0.5",
        isNew && "animate-in fade-in slide-in-from-bottom-2 duration-300 ease-out",
      )}
      onTouchStart={() => getActionsHandle(rowKey)?.startLongPress()}
      onTouchEnd={() => getActionsHandle(rowKey)?.cancelLongPress()}
      onTouchCancel={() => getActionsHandle(rowKey)?.cancelLongPress()}
      onTouchMove={() => getActionsHandle(rowKey)?.cancelLongPress()}
    >
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
        {formatTime(message.timestamp_ms)}
      </span>
      <span
        className="max-w-40 shrink truncate font-mono text-[13px] font-semibold"
        style={{ color: nickColor(message.sender) }}
        title={nick}
      >
        &lt;{nick}&gt;
      </span>
      <div className="min-w-0 flex-1 break-words text-[13px] text-foreground">
        {message.redacted ? (
          <span className="italic text-muted-foreground">* message deleted</span>
        ) : (
          <>
            {message.in_reply_to && (
              <span className="mr-1 text-muted-foreground">
                (re:{" "}
                <button
                  type="button"
                  className="underline"
                  onClick={() => onJumpToMessage(message.in_reply_to!.event_id)}
                >
                  {message.in_reply_to.sender_display_name ?? message.in_reply_to.sender}
                </button>
                )
              </span>
            )}
            {message.media ? (
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
                  "inline text-[13px]",
                  isError && "rounded border border-destructive px-1",
                )}
              />
            )}
            {!message.media &&
              !isUndecrypted && (
                // Explicit block wrapper: unlike Bubble/Discord's rows, IRC's
                // parent content div has no `flex-col` of its own (it's a
                // single inline run of `[HH:MM] <nick> body`), so nothing else
                // guarantees the preview card lands on its own line below the
                // message text rather than immediately after it.
                <div className="mt-0.5">
                  <LinkPreviewForMessage
                    body={message.body}
                    formattedBody={message.formatted_body}
                    roomId={roomId}
                    eventTsMs={message.timestamp_ms}
                  />
                </div>
              )}
            {isPending && <span className="ml-1 text-muted-foreground">(sending…)</span>}
            {isError && <span className="ml-1 text-destructive">(failed to send)</span>}
            {message.edited && <span className="ml-1 text-muted-foreground">(edited)</span>}
          </>
        )}
      </div>
      {!message.redacted && (
        <>
          <ReactionBar
            reactions={message.reactions}
            onToggle={onReact}
            disabled={disableRelationActions || isUndecrypted}
          />
          <MessageActions
            ref={(el) => registerActionsRef(rowKey, el)}
            isOwn={own}
            canRedact={canRedact}
            disableRelationActions={disableRelationActions}
            isUndecrypted={isUndecrypted}
            className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100"
            onReply={onReply}
            onReact={onReact}
            onEdit={onEdit}
            onDelete={onDelete}
            onCopy={onCopy}
          />
        </>
      )}
    </div>
  );
}
