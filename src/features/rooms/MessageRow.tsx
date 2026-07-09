import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import type { RoomMessageSummary } from "@/lib/matrix";
import { MediaMessage } from "./media/MediaMessage";
import { avatarColor, initials, resolveAvatar } from "./roomDisplay";
import { MessageActions, type MessageActionsHandle } from "./MessageActions";
import { ReactionBar } from "./ReactionBar";
import { ReplyPreview } from "./ReplyPreview";
import { sanitizeMatrixHtml } from "./composerSanitize";

/** Caps the read-receipt avatar stack under a message; the rest collapse into a "+N". */
const MAX_RECEIPT_AVATARS = 3;

/**
 * Schemes a rendered `formatted_body` link is allowed to actually open —
 * matches the sanitizer's own URI allowlist (`composerSanitize.ts`) minus
 * `mxc:`, which isn't meaningful for `<a href>` (only `<img src>`), and
 * matches the `opener:allow-default-urls` Tauri capability this app grants,
 * so a link outside this set would be rejected at that layer too even if
 * this check were somehow bypassed.
 */
const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

/**
 * Intercepts clicks on links inside a rendered `formatted_body` message
 * bubble. Without this, a plain `<a href>` click navigates the app's *entire*
 * webview to that URL — no address bar, no way back, and (this being a
 * single-page desktop app) no way to distinguish "phishing page styled like
 * a login screen" from the real thing. Any message from any room member can
 * contain one, so this can't be treated as a rare/internal link. Opens
 * through the OS's default browser instead (real browser chrome, and out of
 * this app's own IPC-privileged webview entirely) and only for schemes on
 * `ALLOWED_LINK_PROTOCOLS` — a relative/fragment href (both valid per the
 * sanitizer's allowlist) is simply left alone rather than resolved and opened.
 */
function handleMessageLinkClick(event: React.MouseEvent<HTMLElement>) {
  // `event.target` is normally an Element for a real click, but isn't
  // guaranteed to be one (e.g. a synthetic/dispatched event) — this is a
  // type assertion away from a runtime throw on `.closest`.
  if (!(event.target instanceof HTMLElement)) return;
  const anchor = event.target.closest("a");
  if (!anchor) return;

  const href = anchor.getAttribute("href");
  if (!href) return;

  let parsed: URL;
  try {
    // No base argument: a relative or fragment href (both valid per the
    // sanitizer's allowlist) throws here instead of being silently resolved
    // into an absolute `http(s)` URL against the app's own origin and
    // handed to `openUrl` — that would both contradict "left alone" above
    // and make no sense to open in an external browser. Only a href that's
    // already absolute reaches the scheme check below.
    parsed = new URL(href);
  } catch {
    return;
  }
  if (!ALLOWED_LINK_PROTOCOLS.has(parsed.protocol)) return;

  event.preventDefault();
  void openUrl(parsed.href);
}

function formatTime(timestampMs: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    new Date(timestampMs),
  );
}

/** Stable identity for a timeline item across the local-echo -> ack lifecycle. */
export function messageRowKey(message: RoomMessageSummary): string {
  return message.transaction_id ?? message.event_id;
}

interface MessageRowProps {
  message: RoomMessageSummary;
  roomId: string;
  /** Whether `message.sender === currentUserId`. */
  own: boolean;
  sameSenderAsPrev: boolean;
  sameSenderAsNext: boolean;
  /** Already resolved: own messages are always redactable regardless of this. */
  canRedact: boolean;
  /** User ids with a read receipt on this message. */
  readers: string[];
  /** Looks up this row's mounted `MessageActions` handle, for forwarding a long-press. */
  getActionsHandle: (key: string) => MessageActionsHandle | undefined;
  /** Registers/unregisters this row's `MessageActions` handle as it mounts/unmounts. */
  registerActionsRef: (key: string, handle: MessageActionsHandle | null) => void;
  onReply: () => void;
  onReact: (key: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  onCopy: () => void;
}

/** Renders a single message row: avatar, reply quote, bubble, actions, reactions, and metadata. */
export function MessageRow({
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
}: MessageRowProps) {
  const showAvatar = !own && !sameSenderAsPrev;
  const showMeta = !sameSenderAsNext;
  const isPending = message.send_state.state === "pending";
  const isError = message.send_state.state === "error";
  // `send_state` flips to "sent" as soon as the homeserver acks the event,
  // but `event_id` only becomes the real Matrix event id once a later
  // `timeline:update` replaces the echo — until then it's still the
  // send-queue transaction id (or, on a failed send, stays that way
  // permanently). Real Matrix event ids always start with "$", so this is a
  // reliable way to tell the two apart without depending on send_state timing.
  const hasRealEventId = message.event_id.startsWith("$");
  const disableRelationActions = isPending || !hasRealEventId;
  const rowKey = messageRowKey(message);

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
              className="opacity-0 transition-opacity group-hover:opacity-100"
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
            disabled={disableRelationActions}
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
