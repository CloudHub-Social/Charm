import { useEffect, useMemo, useRef, useState } from "react";
import { Paperclip, Send } from "lucide-react";
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import {
  getTimelinePage,
  markRoomRead,
  onTimelineUpdate,
  onTypingUpdate,
  sendMessage,
  sendTyping,
  type RoomMessageSummary,
  type RoomSummary,
} from "@/lib/matrix";
import { avatarColor, displayName, initials } from "./roomDisplay";
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

export function ChatShell({ room, currentUserId }: ChatShellProps) {
  const [messages, setMessages] = useState<RoomMessageSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [typingUserIds, setTypingUserIds] = useState<string[]>([]);
  const lastMarkedReadEventId = useRef<string | null>(null);
  const lastTypingSentAt = useRef(0);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);

  const { receiptsByEvent } = useReadReceipts(room?.room_id ?? null, currentUserId);
  // Header presence dot is gated on DM detection, which doesn't exist yet —
  // no-ops here for the same reason RoomListItem's presence dot no-ops.

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
        // Real events superseding our optimistic echoes (same sender + body).
        const withoutMatchedOptimistic = prev.filter((m) => {
          if (!m.event_id.startsWith("local-")) return true;
          return !update.messages.some((um) => um.sender === m.sender && um.body === m.body);
        });
        const existingIds = new Set(withoutMatchedOptimistic.map((m) => m.event_id));
        const newOnes = update.messages.filter((m) => !existingIds.has(m.event_id));
        return [...withoutMatchedOptimistic, ...newOnes];
      });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [room]);

  useEffect(() => {
    if (!room) {
      setTypingUserIds([]);
      return undefined;
    }
    const unlisten = onTypingUpdate((update) => {
      if (update.room_id !== room.room_id) return;
      setTypingUserIds(update.user_ids.filter((id) => id !== currentUserId));
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [room, currentUserId]);

  // Mark the room read as soon as it becomes active, and again whenever the
  // last rendered message scrolls into view — debounced to the newest
  // event id so we never fire a receipt per scroll tick (see Spec 05's
  // warning about receipt spam).
  useEffect(() => {
    if (!room) return;
    if (lastMarkedReadEventId.current === room.room_id) return;
    lastMarkedReadEventId.current = room.room_id;
    markRoomRead(room.room_id).catch(console.error);
  }, [room]);

  const latestEventId = messages.length > 0 ? messages[messages.length - 1].event_id : null;

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

  useEffect(() => {
    return () => {
      if (room) sendTyping(room.room_id, false).catch(console.error);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room]);

  function handleTypingInput(roomId: string) {
    const now = Date.now();
    if (now - lastTypingSentAt.current < TYPING_REFRESH_MS) return;
    lastTypingSentAt.current = now;
    sendTyping(roomId, true).catch(console.error);
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

  async function handleSend() {
    if (!body || !room) return;
    setDraft("");
    // Optimistic local echo — no live timeline:update push exists yet, so we
    // append here rather than waiting on a refetch that could race the send.
    const optimistic: RoomMessageSummary = {
      event_id: `local-${Date.now()}`,
      sender: currentUserId,
      body,
      timestamp_ms: Date.now(),
    };
    setMessages((prev) => [...prev, optimistic]);
    sendTyping(room.room_id, false).catch(console.error);
    try {
      await sendMessage(room.room_id, body);
    } catch (err) {
      console.error(err);
      setMessages((prev) => prev.filter((m) => m.event_id !== optimistic.event_id));
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
          const readers = receiptsByEvent.get(message.event_id) ?? [];
          const isLast = i === messages.length - 1;

          return (
            <div
              key={message.event_id}
              className={cn(
                "flex max-w-120 gap-2",
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
              <div className={cn("flex flex-col gap-0.5", own && "items-end")}>
                {showAvatar && (
                  <span className="text-sm font-semibold text-secondary-foreground">
                    {message.sender}
                  </span>
                )}
                <div
                  className={cn(
                    "w-fit rounded-md px-3 py-2 text-[15px]",
                    own ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground",
                  )}
                >
                  {message.body}
                </div>
                {showMeta && (
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {formatTime(message.timestamp_ms)}
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
              {isLast && <div ref={bottomSentinelRef} className="h-px w-full" />}
            </div>
          );
        })}
      </div>

      {typingText && (
        <output className="block px-4 pb-1 text-sm text-muted-foreground">{typingText}</output>
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
