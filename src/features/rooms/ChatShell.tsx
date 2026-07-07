import { useEffect, useMemo, useRef, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Info, Paperclip, Send, Settings, X } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { PresenceDot } from "@/features/presence/PresenceDot";
import { usePresence } from "@/features/presence/usePresence";
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
  runCommand,
  sendAttachment,
  sendMessage,
  sendReply,
  sendTyping,
  toggleReaction,
  type RoomMessageSummary,
  type RoomSummary,
} from "@/lib/matrix";
import { avatarColor, displayName, initials, resolveAvatar } from "./roomDisplay";
import { Composer, type ComposerHandle, type ComposerMode } from "./Composer";
import type { ParsedSlashCommand } from "./slashCommands";
import { type MessageActionsHandle } from "./MessageActions";
import { MessageRow, messageRowKey } from "./MessageRow";
import { ReplyPreview } from "./ReplyPreview";
import { UploadTray, type PendingUpload } from "./UploadTray";
import { activeReplyTargetAtomFamily, editingEventIdAtomFamily } from "./messageActionAtoms";
import { escapeHtmlText, sanitizeMatrixHtml } from "./composerSanitize";
import { membersDrawerOpenAtomFamily, roomSettingsAtom } from "@/features/room-info/roomInfoAtoms";
import { useReadReceipts } from "./useReadReceipts";

interface ChatShellProps {
  room: RoomSummary | null;
  currentUserId: string;
}

/** How often `sendTyping(true)` is re-sent while the user keeps typing, in ms. */
const TYPING_REFRESH_MS = 4000;

function typingLabel(userIds: string[]): string {
  if (userIds.length === 0) return "";
  if (userIds.length === 1) return `${userIds[0]} is typing…`;
  if (userIds.length === 2) return `${userIds[0]} and ${userIds[1]} are typing…`;
  const [first, second, ...rest] = userIds;
  return `${first}, ${second}, and ${rest.length} other${rest.length === 1 ? "" : "s"} are typing…`;
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
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [commandFeedback, setCommandFeedback] = useState<string | null>(null);
  const [typingUserIds, setTypingUserIds] = useState<string[]>([]);
  const composerRef = useRef<ComposerHandle>(null);
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
  // Tracks the *currently viewed* room id across renders — used by
  // `handleSlashCommand`'s async continuation below to check whether the
  // user switched rooms mid-command, so a stale room's feedback isn't
  // misattributed to whatever room is showing now.
  const currentRoomIdRef = useRef(roomId);
  currentRoomIdRef.current = roomId;
  const [replyTarget, setReplyTarget] = useAtom(activeReplyTargetAtomFamily(roomId));
  const [editingEventId, setEditingEventId] = useAtom(editingEventIdAtomFamily(roomId));
  const [membersDrawerOpen, setMembersDrawerOpen] = useAtom(membersDrawerOpenAtomFamily(roomId));
  const roomSettingsTarget = useAtomValue(roomSettingsAtom);
  const setRoomSettingsTarget = useSetAtom(roomSettingsAtom);
  // Room settings is a full modal covering the chat — messages arriving (or
  // already at the bottom) behind it shouldn't be silently marked read, same
  // reasoning as `RoomsScreen`'s focus-suppression check for this atom.
  const roomSettingsOpen = roomSettingsTarget !== null;
  const senders = messages.map((m) => m.sender);
  const canRedactBySender = useCanRedactMap(roomId, currentUserId, senders);

  // Room-scoped, not persistent: a bad-args/permission-denied banner from
  // room A shouldn't still be showing once the user has switched to room B.
  useEffect(() => {
    setCommandFeedback(null);
  }, [roomId]);

  const { receiptsByEvent } = useReadReceipts(room?.room_id ?? null, currentUserId);
  const headerPresence = usePresence(room?.is_direct ? (room.dm_peer_user_id ?? null) : null);

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
  // messages) fires mark-read again instead of silently no-oping. Skipped
  // (without consuming the dedup key) while room settings covers the chat —
  // re-running this effect once the modal closes, with `roomSettingsOpen` in
  // the deps, fires it then instead.
  useEffect(() => {
    if (!room) {
      lastMarkedReadRoomId.current = null;
      return;
    }
    if (roomSettingsOpen) return;
    if (lastMarkedReadRoomId.current === room.room_id) return;
    lastMarkedReadRoomId.current = room.room_id;
    markRoomRead(room.room_id).catch(console.error);
  }, [room, roomSettingsOpen]);

  useEffect(() => {
    if (!room || !latestEventId) return undefined;
    // Same reasoning as above: don't mark read while the modal covers the
    // chat. `roomSettingsOpen` in the deps re-creates the observer on close,
    // which fires its callback immediately with the sentinel's current
    // intersection state — no need to wait for it to re-intersect.
    if (roomSettingsOpen) return undefined;
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
  }, [room, latestEventId, roomSettingsOpen]);

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

  const editingMessage = messages.find((m) => m.event_id === editingEventId) ?? null;
  const composerMode: ComposerMode = editingEventId ? "edit" : replyTarget ? "reply" : "send";

  async function handleComposerSubmit(content: {
    body: string;
    formattedBody: string | null;
    mentions: string[] | null;
  }) {
    if (!room) return;
    const targetRoom = room;

    if (editingEventId) {
      const eventId = editingEventId;
      setEditingEventId(null);
      sendTyping(targetRoom.room_id, false).catch(console.error);
      try {
        await editMessage(targetRoom.room_id, eventId, content.body);
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
        // Replies don't yet carry formatting/mentions — `send_reply` wasn't
        // extended in this pass (only `send_message` was, per spec scope); a
        // formatted reply falls back to its plain body.
        await sendReply(targetRoom.room_id, replyingTo.event_id, content.body);
      } else {
        await sendMessage(
          targetRoom.room_id,
          content.body,
          content.formattedBody,
          content.mentions,
        );
      }
    } catch (err) {
      console.error(err);
    }
  }

  async function handleSlashCommand(parsed: ParsedSlashCommand) {
    if (!room) return;
    const targetRoomId = room.room_id;
    sendTyping(targetRoomId, false).catch(console.error);
    try {
      const result = await runCommand(targetRoomId, parsed.command, parsed.args);
      // The user may have switched rooms while this command was in flight —
      // don't show room A's feedback under room B, and don't leave a stale
      // failure banner up once a later command (in the still-active room)
      // succeeds.
      if (currentRoomIdRef.current !== targetRoomId) return;
      setCommandFeedback(result.status === "success" ? null : result.message);
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

  function handlePaste(event: React.ClipboardEvent<HTMLDivElement>) {
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
      <div className="flex items-center justify-between gap-2 border-b border-border p-4">
        <div className="flex items-center gap-2 text-[15px] font-bold text-foreground">
          <Avatar size="sm">
            <AvatarImage src={resolveAvatar(room.avatar_path)} alt="" />
            <AvatarFallback
              style={{ background: avatarColor(room.room_id) }}
              className="font-bold text-white"
            >
              {initials(room.room_id, room.name)}
            </AvatarFallback>
            {room.is_direct && <PresenceDot presence={headerPresence?.presence} />}
          </Avatar>
          <span>{displayName(room.room_id, room.name)}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={membersDrawerOpen ? "Hide members" : "Show members"}
            aria-pressed={membersDrawerOpen}
            onClick={() => setMembersDrawerOpen((open) => !open)}
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              membersDrawerOpen && "bg-accent text-accent-foreground",
            )}
          >
            <Info className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Room settings"
            onClick={() => setRoomSettingsTarget({ roomId: room.room_id, section: "general" })}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <Settings className="size-4" />
          </button>
        </div>
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
          // Own messages are always redactable — don't wait on the async
          // `canRedactBySender` resolution (which only matters for other
          // senders' power levels) or Delete flashes hidden-then-shown.
          const allowedToRedact = own || (canRedactBySender[message.sender] ?? false);
          const readers = receiptsByEvent.get(message.event_id) ?? [];

          return (
            <MessageRow
              key={messageRowKey(message)}
              message={message}
              roomId={room.room_id}
              own={own}
              sameSenderAsPrev={prev?.sender === message.sender}
              sameSenderAsNext={next?.sender === message.sender}
              canRedact={allowedToRedact}
              readers={readers}
              getActionsHandle={(key) => actionsRefs.current.get(key)}
              registerActionsRef={(key, el) => {
                if (el) actionsRefs.current.set(key, el);
                else actionsRefs.current.delete(key);
              }}
              onReply={() =>
                setReplyTarget({
                  event_id: message.event_id,
                  sender: message.sender,
                  sender_display_name: message.sender_display_name,
                  preview: message.body,
                })
              }
              onReact={(emoji) => handleToggleReaction(message.event_id, emoji)}
              onEdit={() => {
                setReplyTarget(null);
                setEditingEventId(message.event_id);
              }}
              onDelete={() => handleDelete(message.event_id)}
              onCopy={() => navigator.clipboard?.writeText(message.body)}
            />
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

      <UploadTray
        uploads={uploads}
        onDismiss={(txnId) => setUploads((prev) => prev.filter((u) => u.txnId !== txnId))}
      />

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
              onClick={() => setEditingEventId(null)}
              className="text-xs text-muted-foreground hover:underline"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {commandFeedback && (
        <div className="px-3 pb-1">
          <output className="flex items-center justify-between gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground">
            {commandFeedback}
            <button
              type="button"
              aria-label="Dismiss command feedback"
              onClick={() => setCommandFeedback(null)}
              className="shrink-0"
            >
              <X size={14} />
            </button>
          </output>
        </div>
      )}

      <div className="p-3">
        <div
          className="flex items-end gap-2 rounded-lg border border-border bg-card p-2"
          onPaste={handlePaste}
        >
          <button
            aria-label="Attach"
            onClick={handleAttachClick}
            className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent disabled:cursor-not-allowed"
          >
            <Paperclip size={18} />
          </button>
          <Composer
            key={`${room.room_id}-${editingEventId ?? "new"}`}
            ref={composerRef}
            roomId={room.room_id}
            mode={composerMode}
            initialHtml={
              editingMessage
                ? editingMessage.formatted_body
                  ? sanitizeMatrixHtml(editingMessage.formatted_body)
                  : escapeHtmlText(editingMessage.body)
                : undefined
            }
            placeholder={`Message ${displayName(room.room_id, room.name)}`}
            onSubmit={handleComposerSubmit}
            onSlashCommand={handleSlashCommand}
            onEscape={() => {
              if (editingEventId) setEditingEventId(null);
              else if (replyTarget) setReplyTarget(null);
            }}
            onTypingInput={() => handleTypingInput(room.room_id)}
            onBlur={() => sendTyping(room.room_id, false).catch(console.error)}
          />
          {/* `bg-primary-solid` (not `bg-primary`): solid fill under
              near-white text/icon — see button.tsx's comment / tokens.css. */}
          <button
            aria-label="Send"
            onClick={() => composerRef.current?.submit()}
            className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary-solid text-primary-foreground"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
