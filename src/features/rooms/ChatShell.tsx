import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import { Paperclip, Send } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import {
  canRedact,
  editMessage,
  getTimelinePage,
  onSendQueueUpdate,
  onTimelineUpdate,
  redactEvent,
  sendMessage,
  sendReply,
  toggleReaction,
  type RoomMessageSummary,
  type RoomSummary,
} from "@/lib/matrix";
import { avatarColor, displayName, initials } from "./roomDisplay";
import { MessageActions } from "./MessageActions";
import { ReactionBar } from "./ReactionBar";
import { ReplyPreview } from "./ReplyPreview";
import { activeReplyTargetAtomFamily, editingEventIdAtomFamily } from "./messageActionAtoms";

interface ChatShellProps {
  room: RoomSummary | null;
  currentUserId: string;
}

function formatTime(timestampMs: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    new Date(timestampMs),
  );
}

/** Stable identity for a timeline item across the local-echo -> ack lifecycle. */
function itemKey(message: RoomMessageSummary): string {
  return message.transaction_id ?? message.event_id;
}

/**
 * Per-message affordance state: whether the current user sent it, and
 * whether they're allowed to redact it (own messages always; others gated
 * by the room's redact power level via `can_redact`). Fetched lazily per
 * sender the first time that sender appears in `senders`, since power
 * levels don't change often and this avoids an IPC round-trip per message.
 * Resolution happens in an effect (not during render) so it can safely call
 * `setState` without triggering React's render-loop guard.
 */
function useCanRedactMap(roomId: string, currentUserId: string, senders: readonly string[]) {
  const [canRedactBySender, setCanRedactBySender] = useState<Record<string, boolean>>({});
  // Stable across renders that don't actually change the sender set, so the
  // effect below only re-runs when a genuinely new sender shows up.
  const uniqueSenderKey = [...new Set(senders)].toSorted().join(",");

  useEffect(() => {
    const unresolved = uniqueSenderKey === "" ? [] : uniqueSenderKey.split(",");

    for (const sender of unresolved) {
      if (sender === currentUserId) {
        setCanRedactBySender((prev) => (prev[sender] ? prev : { ...prev, [sender]: true }));
        continue;
      }
      setCanRedactBySender((prev) => {
        if (sender in prev) return prev;
        canRedact(roomId, sender)
          .then((allowed) => setCanRedactBySender((current) => ({ ...current, [sender]: allowed })))
          .catch(console.error);
        return prev;
      });
    }
  }, [roomId, currentUserId, uniqueSenderKey]);

  return canRedactBySender;
}

export function ChatShell({ room, currentUserId }: ChatShellProps) {
  const [messages, setMessages] = useState<RoomMessageSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const roomId = room?.room_id ?? "";
  const [replyTarget, setReplyTarget] = useAtom(activeReplyTargetAtomFamily(roomId));
  const [editingEventId, setEditingEventId] = useAtom(editingEventIdAtomFamily(roomId));
  const senders = messages.map((m) => m.sender);
  const canRedactBySender = useCanRedactMap(roomId, currentUserId, senders);

  useEffect(() => {
    if (!room) {
      setMessages([]);
      return;
    }
    setLoading(true);
    getTimelinePage(room.room_id)
      .then((page) => setMessages(page.messages.toReversed()))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [room]);

  useEffect(() => {
    if (!room) return undefined;
    const unlisten = onTimelineUpdate((update) => {
      if (update.room_id !== room.room_id) return;
      setMessages((prev) => {
        // Reconcile by id: an incoming summary replaces any existing item
        // with the same event_id or transaction_id (e.g. a local echo being
        // superseded by the real event once the send is acked), otherwise
        // it's appended.
        const incomingKeys = new Set(
          update.messages.flatMap((m) => [
            m.event_id,
            ...(m.transaction_id ? [m.transaction_id] : []),
          ]),
        );
        const kept = prev.filter(
          (m) => !incomingKeys.has(itemKey(m)) && !incomingKeys.has(m.event_id),
        );
        return [...kept, ...update.messages];
      });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [room]);

  useEffect(() => {
    if (!room) return undefined;
    const unlisten = onSendQueueUpdate((update) => {
      if (update.room_id !== room.room_id) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.transaction_id === update.transaction_id ? { ...m, send_state: update.send_state } : m,
        ),
      );
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [room]);

  if (!room) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Select a room to start chatting
      </div>
    );
  }

  const body = draft.trim();
  const editingMessage = messages.find((m) => m.event_id === editingEventId) ?? null;

  async function handleSend() {
    if (!body || !room) return;
    const targetRoom = room;
    setDraft("");

    if (editingEventId) {
      const eventId = editingEventId;
      setEditingEventId(null);
      try {
        await editMessage(targetRoom.room_id, eventId, body);
      } catch (err) {
        console.error(err);
      }
      return;
    }

    const replyingTo = replyTarget;
    setReplyTarget(null);

    const transactionId = `local-${Date.now()}`;
    const optimistic: RoomMessageSummary = {
      event_id: transactionId,
      sender: currentUserId,
      body,
      formatted_body: null,
      timestamp_ms: Date.now(),
      edited: false,
      redacted: false,
      reactions: [],
      in_reply_to: replyingTo,
      transaction_id: transactionId,
      send_state: { state: "pending" },
    };
    setMessages((prev) => [...prev, optimistic]);
    try {
      if (replyingTo) {
        await sendReply(targetRoom.room_id, replyingTo.event_id, body);
      } else {
        await sendMessage(targetRoom.room_id, body);
      }
    } catch (err) {
      console.error(err);
      setMessages((prev) =>
        prev.map((m) =>
          m.transaction_id === transactionId
            ? { ...m, send_state: { state: "error", message: String(err) } }
            : m,
        ),
      );
    }
  }

  async function handleToggleReaction(targetEventId: string, key: string) {
    if (!room) return;
    try {
      await toggleReaction(room.room_id, targetEventId, key);
    } catch (err) {
      console.error(err);
    }
  }

  async function handleDelete(eventId: string) {
    if (!room) return;
    try {
      await redactEvent(room.room_id, eventId);
    } catch (err) {
      console.error(err);
    }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="border-b border-border p-4 text-[15px] font-bold text-foreground">
        {displayName(room.room_id, room.name)}
      </div>

      <div className="flex flex-1 flex-col gap-1 overflow-y-auto p-4">
        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!loading && messages.length === 0 && (
          <p className="text-sm text-muted-foreground">No messages yet</p>
        )}
        {messages.map((message, i) => {
          const own = message.sender === currentUserId;
          const prev = messages[i - 1];
          const next = messages[i + 1];
          const sameSenderAsPrev = prev?.sender === message.sender;
          const sameSenderAsNext = next?.sender === message.sender;
          const showAvatar = !own && !sameSenderAsPrev;
          const showMeta = !sameSenderAsNext;
          const allowedToRedact = canRedactBySender[message.sender] ?? false;
          const isPending = message.send_state.state === "pending";
          const isError = message.send_state.state === "error";

          return (
            <div
              key={itemKey(message)}
              id={`message-${message.event_id}`}
              className={cn(
                "group flex max-w-120 gap-2",
                sameSenderAsPrev ? "mt-0.5" : "mt-3",
                own && "ml-auto flex-row-reverse",
              )}
            >
              {!own &&
                (showAvatar ? (
                  <Avatar size="sm">
                    <AvatarFallback
                      style={{ background: avatarColor(message.sender) }}
                      className="font-bold text-white"
                    >
                      {initials(message.sender, null)}
                    </AvatarFallback>
                  </Avatar>
                ) : (
                  <div className="w-6 shrink-0" />
                ))}
              <div className={cn("flex min-w-0 flex-col gap-0.5", own && "items-end")}>
                {showAvatar && (
                  <span className="text-sm font-semibold text-secondary-foreground">
                    {message.sender}
                  </span>
                )}
                {message.in_reply_to && (
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
                  <div
                    className={cn(
                      "w-fit rounded-md px-3 py-2 text-[15px]",
                      message.redacted
                        ? "italic text-muted-foreground bg-secondary/50"
                        : own
                          ? "bg-primary text-primary-foreground"
                          : "bg-secondary text-foreground",
                      isError && "border border-destructive",
                    )}
                  >
                    {message.redacted ? "Message deleted" : message.body}
                  </div>
                  {!message.redacted && (
                    <MessageActions
                      isOwn={own}
                      canRedact={allowedToRedact}
                      className="opacity-0 transition-opacity group-hover:opacity-100"
                      onReply={() =>
                        setReplyTarget({
                          event_id: message.event_id,
                          sender: message.sender,
                          preview: message.body,
                        })
                      }
                      onReact={(emoji) => handleToggleReaction(message.event_id, emoji)}
                      onEdit={() => {
                        setEditingEventId(message.event_id);
                        setDraft(message.body);
                      }}
                      onDelete={() => handleDelete(message.event_id)}
                      onCopy={() => navigator.clipboard?.writeText(message.body)}
                    />
                  )}
                </div>
                {!message.redacted && (
                  <ReactionBar
                    reactions={message.reactions}
                    onToggle={(key) => handleToggleReaction(message.event_id, key)}
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
              </div>
            </div>
          );
        })}
      </div>

      {replyTarget && !editingEventId && (
        <div className="px-3 pb-1">
          <ReplyPreview
            reply={replyTarget}
            variant="composer"
            onCancel={() => setReplyTarget(null)}
          />
        </div>
      )}
      {editingMessage && (
        <div className="px-3 pb-1">
          <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-secondary px-3 py-2 text-sm">
            <span className="text-xs font-semibold text-secondary-foreground">Editing message</span>
            <button
              type="button"
              aria-label="Cancel edit"
              onClick={() => {
                setEditingEventId(null);
                setDraft("");
              }}
              className="text-xs text-muted-foreground hover:underline"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="p-3">
        <div className="flex items-end gap-2 rounded-lg border border-border bg-card p-2">
          <button
            aria-label="Attach"
            disabled
            className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground disabled:cursor-not-allowed"
          >
            <Paperclip size={18} />
          </button>
          <textarea
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={`Message ${displayName(room.room_id, room.name)}`}
            className="max-h-30 min-h-6 flex-1 resize-none bg-transparent px-1 py-2 text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          <button
            aria-label="Send"
            disabled={!body}
            onClick={handleSend}
            className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground disabled:cursor-not-allowed disabled:bg-accent disabled:text-muted-foreground"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
