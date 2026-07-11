import { cn } from "@/lib/utils";
import { MediaMessage } from "./media/MediaMessage";
import { nickColor } from "./roomDisplay";
import { MessageActions } from "./MessageActions";
import { ReactionBar } from "./ReactionBar";
import { sanitizeMatrixHtml } from "./composerSanitize";
import { formatTime, handleMessageLinkClick, type MessageRowLayoutProps } from "./messageRowShared";

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
  own,
  canRedact,
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
  const nick = message.sender_display_name ?? message.sender;

  return (
    <div
      id={`message-${message.event_id}`}
      className="group flex items-baseline gap-1 py-0.5"
      onTouchStart={() => getActionsHandle(rowKey)?.startLongPress()}
      onTouchEnd={() => getActionsHandle(rowKey)?.cancelLongPress()}
      onTouchCancel={() => getActionsHandle(rowKey)?.cancelLongPress()}
      onTouchMove={() => getActionsHandle(rowKey)?.cancelLongPress()}
    >
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
        {formatTime(message.timestamp_ms)}
      </span>
      <span
        className="shrink-0 font-mono text-[13px] font-semibold"
        style={{ color: nickColor(message.sender) }}
      >
        &lt;{nick}&gt;
      </span>
      <span className="min-w-0 flex-1 break-words text-[13px] text-foreground">
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
                  onClick={() => {
                    document
                      .getElementById(`message-${message.in_reply_to?.event_id}`)
                      ?.scrollIntoView({ behavior: "smooth", block: "center" });
                  }}
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
            ) : message.formatted_body ? (
              // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- onClick only delegates to real <a> elements inside the sanitized HTML, which are natively keyboard-operable; the span itself isn't interactive
              <span
                className={cn(
                  "[&_a]:underline [&_code]:rounded [&_code]:bg-black/10 [&_code]:px-1",
                  isError && "rounded border border-destructive px-1",
                )}
                // eslint-disable-next-line react/no-danger -- sanitized above via sanitizeMatrixHtml
                dangerouslySetInnerHTML={{
                  __html: sanitizeMatrixHtml(message.formatted_body),
                }}
                onClick={handleMessageLinkClick}
              />
            ) : (
              <span className={cn(isError && "rounded border border-destructive px-1")}>
                {message.body}
              </span>
            )}
          </>
        )}
        {isPending && <span className="ml-1 text-muted-foreground">(sending…)</span>}
        {isError && <span className="ml-1 text-destructive">(failed to send)</span>}
        {message.edited && <span className="ml-1 text-muted-foreground">(edited)</span>}
      </span>
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
