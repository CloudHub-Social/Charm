import { useEffect, useMemo, useRef, useState } from "react";
import { useAtom } from "jotai";
import { Paperclip, Send } from "lucide-react";
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import {
  canRedact,
  editMessage,
  getTimelinePage,
  markRoomRead,
  onSendQueueUpdate,
  onTimelineUpdate,
  onTypingUpdate,
  redactEvent,
  sendMessage,
  sendReply,
  sendTyping,
  toggleReaction,
  type RoomMessageSummary,
  type RoomSummary,
} from "@/lib/matrix";
import { avatarColor, displayName, initials } from "./roomDisplay";
import { MessageActions } from "./MessageActions";
import { ReactionBar } from "./ReactionBar";
import { ReplyPreview } from "./ReplyPreview";
import { activeReplyTargetAtomFamily, editingEventIdAtomFamily } from "./messageActionAtoms";
import { useReadReceipts } from "./useReadReceipts";

interface ChatShellProps {
  room: RoomSummary | null;
  currentUserId: string;
}

/** Caps the read-receipt avatar stack under a message; the rest collapse into a "+N". */
const MAX_RECEIPT_AVATARS = 3;

/** How often `sendTyping(true)` is re-sent while the user keeps typing, in ms. */
const TYPING_REFRESH_MS = 4000;

function formatTime(timestampMs: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    new Date(timestampMs),
  );
}

function typingLabel(userIds: string[]): string {
  if (userIds.length === 0) return "";
  if (userIds.length === 1) return `${userIds[0]} is typing…`;
  if (userIds.length === 2) return `${userIds[0]} and ${userIds[1]} are typing…`;
  const [first, second, ...rest] = userIds;
  return `${first}, ${second}, and ${rest.length} other${rest.length === 1 ? "" : "s"} are typing…`;
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

  // Redact power levels are per-room, but this cache is keyed only by
  // sender — so switching to a different room must clear it, or a sender
  // who appeared in the previous room keeps that room's cached permission
  // instead of being re-queried for the new one.
  useEffect(() => {
    setCanRedactBySender({});
  }, [roomId]);

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
  const [typingUserIds, setTypingUserIds] = useState<string[]>([]);
  const lastMarkedReadRoomId = useRef<string | null>(null);
  const lastMarkedReadEventId = useRef<string | null>(null);
  const lastTypingSentAt = useRef(0);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
  const roomId = room?.room_id ?? "";
  const [replyTarget, setReplyTarget] = useAtom(activeReplyTargetAtomFamily(roomId));
  const [editingEventId, setEditingEventId] = useAtom(editingEventIdAtomFamily(roomId));
  const senders = messages.map((m) => m.sender);
  const canRedactBySender = useCanRedactMap(roomId, currentUserId, senders);

  const { receiptsByEvent } = useReadReceipts(room?.room_id ?? null, currentUserId);
  // Header presence dot is gated on DM detection, which doesn't exist yet —
  // no-ops here for the same reason RoomListItem's presence dot no-ops.

  // `editingEventId` is a per-room atom, so it's already `null` in a freshly
  // switched-to room — but `draft` isn't room-scoped, so without this a
  // half-typed edit in room A would carry over as an ordinary draft in room
  // B, and pressing Send there would post that edit text as a new message.
  useEffect(() => {
    setDraft("");
  }, [roomId]);

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

  useEffect(() => {
    // Clear on every room change, not just to `null` — otherwise switching
    // directly from room A (mid "X is typing…") to room B keeps A's typing
    // row rendered under B until B happens to get its own typing update.
    setTypingUserIds([]);
    const typingRoomId = room?.room_id;
    if (!typingRoomId) return undefined;
    // Keyed to the room id, not the `room` object — a `room_list:update`
    // refresh gives the active room a fresh object with the same id, which
    // would otherwise re-subscribe (and briefly double-listen, since the old
    // listener's teardown is async) on every refresh instead of only on an
    // actual room change.
    const unlisten = onTypingUpdate((update) => {
      if (update.room_id !== typingRoomId) return;
      setTypingUserIds(update.user_ids.filter((id) => id !== currentUserId));
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [room?.room_id, currentUserId]);

  const latestEventId = messages.length > 0 ? messages[messages.length - 1].event_id : null;

  // Mark the room read as soon as it becomes active — deduped on room id
  // (not event id) so this still fires the first time even before any
  // messages have loaded. Reset the dedup key when navigating away so
  // returning to the same room later (e.g. with newly-arrived unread
  // messages) fires mark-read again instead of silently no-oping.
  useEffect(() => {
    if (!room) {
      lastMarkedReadRoomId.current = null;
      return;
    }
    if (lastMarkedReadRoomId.current === room.room_id) return;
    lastMarkedReadRoomId.current = room.room_id;
    markRoomRead(room.room_id).catch(console.error);
  }, [room]);

  useEffect(() => {
    if (!room || !latestEventId) return undefined;
    const sentinel = bottomSentinelRef.current;
    if (!sentinel) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        const isVisible = entries.some((entry) => entry.isIntersecting);
        if (!isVisible) return;
        if (lastMarkedReadEventId.current === latestEventId) return;
        lastMarkedReadEventId.current = latestEventId;
        markRoomRead(room.room_id).catch(console.error);
      },
      { threshold: 1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [room, latestEventId]);

  // Keyed to the room id, not the `room` object — RoomsScreen rebuilds
  // `activeRoom` from every `room_list:update`, so a plain `[room]` dep would
  // treat "same room, refreshed object" as a room change and send a spurious
  // `sendTyping(false)` while the user is still actively typing there.
  useEffect(() => {
    const typingRoomId = room?.room_id;
    // A room switch (or unmount) resets the throttle too — otherwise typing
    // in room A within the last 4s can suppress the first `sendTyping(true)`
    // in room B, since the throttle was keyed globally rather than per room.
    lastTypingSentAt.current = 0;
    return () => {
      if (typingRoomId) sendTyping(typingRoomId, false).catch(console.error);
    };
  }, [room?.room_id]);

  function handleTypingInput(typingRoomId: string) {
    const now = Date.now();
    if (now - lastTypingSentAt.current < TYPING_REFRESH_MS) return;
    lastTypingSentAt.current = now;
    sendTyping(typingRoomId, true).catch(console.error);
  }

  const typingText = useMemo(() => typingLabel(typingUserIds), [typingUserIds]);

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
    sendTyping(targetRoom.room_id, false).catch(console.error);

    // The optimistic echo must be keyed on the *SDK's* send-queue transaction
    // id, not a client-generated placeholder — that's the same id the synced
    // event's `transaction_id` (from `unsigned.transaction_id`) and
    // `send_queue:update` events carry, and reconciliation only works if all
    // three agree. So this awaits the send call (which itself only waits for
    // the event to be queued, not for a homeserver round trip) before
    // rendering anything, rather than rendering an echo immediately under a
    // key nothing else will ever match.
    try {
      const transactionId = replyingTo
        ? await sendReply(targetRoom.room_id, replyingTo.event_id, body)
        : await sendMessage(targetRoom.room_id, body);

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
    } catch (err) {
      console.error(err);
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
          // Own messages are always redactable — don't wait on the async
          // `canRedactBySender` resolution (which only matters for other
          // senders' power levels) or Delete flashes hidden-then-shown.
          const allowedToRedact = own || (canRedactBySender[message.sender] ?? false);
          const isPending = message.send_state.state === "pending";
          const isError = message.send_state.state === "error";
          const readers = receiptsByEvent.get(message.event_id) ?? [];

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
                      disableRelationActions={isPending}
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
                        setReplyTarget(null);
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
                    disabled={isPending}
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
        })}
        {/* Block-level sibling of the flex message rows above (not a flex
            item within one) so it always keeps its own non-zero box and the
            `threshold: 1` IntersectionObserver can reliably fire. */}
        <div ref={bottomSentinelRef} className="h-px w-full shrink-0" />
      </div>

      {typingText && (
        <output className="block px-4 pb-1 text-sm text-muted-foreground">{typingText}</output>
      )}

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
            onChange={(e) => {
              setDraft(e.currentTarget.value);
              handleTypingInput(room.room_id);
            }}
            onBlur={() => sendTyping(room.room_id, false).catch(console.error)}
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
