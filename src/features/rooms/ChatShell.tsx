import { useEffect, useMemo, useRef, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useAtom } from "jotai";
import { Paperclip, Send, X } from "lucide-react";
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import {
  canRedact,
  editMessage,
  getTimelinePage,
  markRoomRead,
  onTimelineUpdate,
  onTypingUpdate,
  onUploadProgress,
  redactEvent,
  sendAttachment,
  sendMessage,
  sendReply,
  sendTyping,
  toggleReaction,
  type RoomMessageSummary,
  type RoomSummary,
} from "@/lib/matrix";
import { MediaMessage } from "./media/MediaMessage";
import { avatarColor, displayName, initials } from "./roomDisplay";
import { MessageActions, type MessageActionsHandle } from "./MessageActions";
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

interface PendingUpload {
  txnId: string;
  filename: string;
  sent: number;
  total: number;
  failed: boolean;
}

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
  // Tracks the room a `canRedact` call was actually issued for, so its
  // resolution can be checked against whatever room is current by the time
  // it lands — without this, a slow response for a room the user has since
  // navigated away from can overwrite a *different*, already-current room's
  // permission result for the same sender (redact power levels are
  // per-room, so a shared sender across two rooms would otherwise get one
  // room's answer applied to the other).
  const requestedRoomIdRef = useRef(roomId);
  requestedRoomIdRef.current = roomId;
  // Tracks "room_id\0sender" keys already requested (or answered), as a
  // plain ref rather than reading `canRedactBySender` from inside the
  // `setState` updater below — StrictMode double-invokes updater functions
  // to surface exactly this kind of side effect, and `canRedact(...)` being
  // called from inside one meant the `if (sender in prev)` guard couldn't
  // actually prevent the resulting duplicate IPC call.
  const requestedRef = useRef<Set<string>>(new Set());

  // Redact power levels are per-room, but this cache is keyed only by
  // sender — so switching to a different room must clear it, or a sender
  // who appeared in the previous room keeps that room's cached permission
  // instead of being re-queried for the new one.
  useEffect(() => {
    setCanRedactBySender({});
    requestedRef.current = new Set();
  }, [roomId]);

  useEffect(() => {
    const unresolved = uniqueSenderKey === "" ? [] : uniqueSenderKey.split(",");
    const requestedForRoomId = roomId;

    for (const sender of unresolved) {
      if (sender === currentUserId) {
        setCanRedactBySender((prev) => (prev[sender] ? prev : { ...prev, [sender]: true }));
        continue;
      }
      const requestKey = `${roomId}\0${sender}`;
      if (requestedRef.current.has(requestKey)) continue;
      requestedRef.current.add(requestKey);
      canRedact(roomId, sender)
        .then((allowed) => {
          if (requestedRoomIdRef.current !== requestedForRoomId) return;
          setCanRedactBySender((current) => ({ ...current, [sender]: allowed }));
        })
        .catch(console.error);
    }
  }, [roomId, currentUserId, uniqueSenderKey]);

  return canRedactBySender;
}

export function ChatShell({ room, currentUserId }: ChatShellProps) {
  const [messages, setMessages] = useState<RoomMessageSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [typingUserIds, setTypingUserIds] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastMarkedReadRoomId = useRef<string | null>(null);
  const lastMarkedReadEventId = useRef<string | null>(null);
  const lastTypingSentAt = useRef(0);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
  // On touch, `MessageActions`' own trigger buttons are hover-only and thus
  // invisible/undiscoverable — a long-press on the bubble itself is what
  // users actually try. Forwarding the row's touch events to each
  // `MessageActions` instance via this ref map lets a long-press anywhere
  // on the row open that message's action menu.
  const actionsRefs = useRef<Map<string, MessageActionsHandle>>(new Map());
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
    // Keyed on the room id, not the `room` object itself: `RoomsScreen` hands
    // this a fresh `room` reference on every `room_list:update`, and
    // `Timeline::paginate_backwards`'s pagination is now stateful per-room
    // (Spec 14), so re-running this on every such refresh would silently
    // walk further back into history each time instead of just loading the
    // room once.
    const timelineRoomId = room?.room_id;
    if (!timelineRoomId) {
      setMessages([]);
      return;
    }
    setLoading(true);
    // `page.messages` now comes from `matrix-sdk-ui`'s `Timeline` (Spec 14),
    // which holds items in their natural oldest-to-newest order — unlike the
    // old `room.messages()` backward-pagination page, which was newest-first
    // and needed reversing.
    getTimelinePage(timelineRoomId)
      .then((page) => setMessages(page.messages))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [room?.room_id]);

  useEffect(() => {
    if (!room) return undefined;
    const unlisten = onTimelineUpdate((update) => {
      if (update.room_id !== room.room_id) return;
      // `update.messages` is a full re-snapshot of the room's live Timeline
      // (Spec 14) — every call to `timeline:update` carries the complete
      // current item list, not a delta to merge onto existing state. Merging
      // (as the pre-Spec-14 per-batch model required) would keep stale
      // items a newer snapshot no longer has — e.g. a local echo keyed by
      // transaction id lingering alongside the remote event that replaced
      // it, since the remote item's `transaction_id` is `None` and so
      // wouldn't match it for removal. Replacing outright is both correct
      // and simpler.
      setMessages(update.messages);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(console.error);
    };
  }, [room]);

  // No `send_queue:update` listener here: the live `Timeline` (Spec 14)
  // surfaces the same pending -> sent -> error transitions as `send_state` on
  // the `RoomMessageSummary`s pushed via `timeline:update` above, so a
  // separate room-wide send-queue event would just be redundant for the
  // message list.

  useEffect(() => {
    const unlisten = onUploadProgress((progress) => {
      setUploads((prev) => {
        const existing = prev.find((u) => u.txnId === progress.txn_id);
        if (!existing) return prev;
        const done = progress.sent >= progress.total && progress.total > 0;
        if (done) {
          return prev.filter((u) => u.txnId !== progress.txn_id);
        }
        return prev.map((u) =>
          u.txnId === progress.txn_id ? { ...u, sent: progress.sent, total: progress.total } : u,
        );
      });
    });
    return () => {
      unlisten.then((fn) => fn()).catch(console.error);
    };
  }, []);

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
      unlisten.then((fn) => fn()).catch(console.error);
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

    // No client-side optimistic echo any more (Spec 14): the room's live
    // `Timeline` creates the local echo itself the moment the send is queued
    // (with `send_state: "pending"`) and pushes it via `timeline:update`,
    // keyed on the SDK's own send-queue transaction id — the same id the
    // eventual synced event's `transaction_id` carries — so the echo is
    // replaced in place by the Timeline itself rather than reconciled here.
    // This call's return value (also that same transaction id) isn't needed
    // for rendering any more, only for triggering the send.
    try {
      if (replyingTo) {
        await sendReply(targetRoom.room_id, replyingTo.event_id, body);
      } else {
        await sendMessage(targetRoom.room_id, body);
      }
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

  async function handleAttachFile(filePath: string) {
    if (!room) return;
    const filename = filePath.split(/[/\\]/).pop() ?? filePath;
    const txnId = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setUploads((prev) => [...prev, { txnId, filename, sent: 0, total: 0, failed: false }]);
    try {
      await sendAttachment(room.room_id, filePath, txnId);
      setUploads((prev) => prev.filter((u) => u.txnId !== txnId));
    } catch (err) {
      console.error(err);
      setUploads((prev) => prev.map((u) => (u.txnId === txnId ? { ...u, failed: true } : u)));
    }
  }

  async function handleAttachClick() {
    const selected = await openFileDialog({ multiple: false });
    if (typeof selected === "string") {
      await handleAttachFile(selected);
    }
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    // Tauri's webview exposes dropped files' real filesystem paths via
    // `webkitGetAsEntry`-less File objects that still carry a `path` on
    // desktop; browsers' plain `File` has no path, so this only actually
    // triggers a send inside the Tauri webview, same as production runs in.
    const files = Array.from(event.dataTransfer.files) as (File & { path?: string })[];
    const file = files[0];
    if (file?.path) {
      handleAttachFile(file.path);
    }
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files) as (File & { path?: string })[];
    const file = files.find((f) => f.type.startsWith("image/"));
    if (file?.path) {
      event.preventDefault();
      handleAttachFile(file.path);
    }
  }

  return (
    <div
      className="flex min-w-0 flex-1 flex-col"
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
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
          // `send_state` flips to "sent" as soon as the homeserver acks the
          // event, but `event_id` only becomes the real Matrix event id once
          // a later `timeline:update` replaces the echo — until then it's
          // still the send-queue transaction id (or, on a failed send,
          // stays that way permanently). Real Matrix event ids always start
          // with "$", so this is a reliable way to tell the two apart
          // without depending on send_state timing.
          const hasRealEventId = message.event_id.startsWith("$");
          const disableRelationActions = isPending || !hasRealEventId;
          const readers = receiptsByEvent.get(message.event_id) ?? [];

          const rowKey = itemKey(message);

          return (
            <div
              key={rowKey}
              id={`message-${message.event_id}`}
              className={cn(
                "group flex max-w-120 gap-2",
                sameSenderAsPrev ? "mt-0.5" : "mt-3",
                own && "ml-auto flex-row-reverse",
              )}
              onTouchStart={() => actionsRefs.current.get(rowKey)?.startLongPress()}
              onTouchEnd={() => actionsRefs.current.get(rowKey)?.cancelLongPress()}
              onTouchCancel={() => actionsRefs.current.get(rowKey)?.cancelLongPress()}
              onTouchMove={() => actionsRefs.current.get(rowKey)?.cancelLongPress()}
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
                  {message.redacted ? (
                    <div className="w-fit rounded-md bg-secondary/50 px-3 py-2 text-[15px] italic text-muted-foreground">
                      Message deleted
                    </div>
                  ) : message.media ? (
                    <MediaMessage
                      content={message.media}
                      roomId={room.room_id}
                      eventId={message.event_id}
                      body={message.body}
                    />
                  ) : (
                    <div
                      className={cn(
                        "w-fit rounded-md px-3 py-2 text-[15px]",
                        own ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground",
                        isError && "border border-destructive",
                      )}
                    >
                      {message.body}
                    </div>
                  )}
                  {!message.redacted && (
                    <MessageActions
                      ref={(el) => {
                        if (el) actionsRefs.current.set(rowKey, el);
                        else actionsRefs.current.delete(rowKey);
                      }}
                      isOwn={own}
                      canRedact={allowedToRedact}
                      disableRelationActions={disableRelationActions}
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
        })}
        {/* Block-level sibling of the flex message rows above (not a flex
            item within one) so it always keeps its own non-zero box and the
            `threshold: 1` IntersectionObserver can reliably fire. */}
        <div ref={bottomSentinelRef} className="h-px w-full shrink-0" />
      </div>

      {typingText && (
        <output className="block px-4 pb-1 text-sm text-muted-foreground">{typingText}</output>
      )}

      {uploads.length > 0 && (
        <div className="flex flex-col gap-1 px-4 pb-2">
          {uploads.map((upload) => (
            <div
              key={upload.txnId}
              className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-[13px]"
            >
              <span className="truncate text-foreground">{upload.filename}</span>
              {upload.failed ? (
                <>
                  <span className="text-destructive-foreground">Upload failed</span>
                  <button
                    type="button"
                    aria-label={`Dismiss failed upload ${upload.filename}`}
                    onClick={() =>
                      setUploads((prev) => prev.filter((u) => u.txnId !== upload.txnId))
                    }
                    className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent"
                  >
                    <X size={14} />
                  </button>
                </>
              ) : (
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full bg-primary transition-[width]"
                    style={{
                      width:
                        upload.total > 0
                          ? `${Math.min(100, (upload.sent / upload.total) * 100)}%`
                          : "10%",
                    }}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
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
            onClick={handleAttachClick}
            className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent disabled:cursor-not-allowed"
          >
            <Paperclip size={18} />
          </button>
          <textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            onChange={(e) => {
              setDraft(e.currentTarget.value);
              handleTypingInput(room.room_id);
            }}
            onPaste={handlePaste}
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
