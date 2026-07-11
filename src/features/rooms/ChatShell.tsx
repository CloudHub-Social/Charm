import { useEffect, useRef, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Info, Paperclip, Send, Settings, X } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { PresenceDot } from "@/features/presence/PresenceDot";
import { usePresence } from "@/features/presence/usePresence";
import { cn } from "@/lib/utils";
import { isWebBuild } from "@/lib/platform";
import { canRedact, type RoomSummary } from "@/lib/matrix";
import { avatarColor, displayName, initials, resolveAvatar } from "./roomDisplay";
import { Composer, type ComposerHandle, type ComposerMode } from "./Composer";
import { type MessageActionsHandle } from "./MessageActions";
import { MessageRow, messageRowKey } from "./MessageRow";
import { ReplyPreview } from "./ReplyPreview";
import { UploadTray } from "./UploadTray";
import {
  activeReplyTargetAtomFamily,
  editingEventIdAtomFamily,
  noRoomActiveReplyTargetAtom,
  noRoomEditingEventIdAtom,
} from "./messageActionAtoms";
import { escapeHtmlText, sanitizeMatrixHtml } from "./composerSanitize";
import {
  membersDrawerOpenAtomFamily,
  noRoomMembersDrawerOpenAtom,
  roomSettingsAtom,
} from "@/features/room-info/roomInfoAtoms";
import { useReadReceipts } from "./useReadReceipts";
import { followingLabel, useRoomParticipants } from "./useRoomParticipants";
import { logAndIgnore } from "@/lib/logAndIgnore";
import { attachmentUploadPayload, useAttachmentUploads } from "./useAttachmentUploads";
import { useChatTimeline } from "./useChatTimeline";
import { useChatTyping } from "./useChatTyping";
import { useMessageActions } from "./useMessageActions";
import { useMessageSend } from "./useMessageSend";

interface ChatShellProps {
  room: RoomSummary | null;
  currentUserId: string;
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
        .catch(logAndIgnore);
    }
  }, [roomId, currentUserId, uniqueSenderKey]);

  return canRedactBySender;
}

export function ChatShell({ room, currentUserId }: ChatShellProps) {
  const composerRef = useRef<ComposerHandle>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  // Drives the Send button's `disabled` state — there's no attachment
  // concept in the composer today (files upload and send independently via
  // `useAttachmentUploads`), so trimmed text emptiness is the only signal.
  const [isComposerEmpty, setIsComposerEmpty] = useState(true);
  const [followingExpanded, setFollowingExpanded] = useState(false);
  // On touch, `MessageActions`' own trigger buttons are hover-only and thus
  // invisible/undiscoverable — a long-press on the bubble itself is what
  // users actually try. Forwarding the row's touch events to each
  // `MessageActions` instance via this ref map lets a long-press anywhere
  // on the row open that message's action menu.
  const actionsRefs = useRef<Map<string, MessageActionsHandle>>(new Map());
  const roomId = room?.room_id ?? "";
  const activeRoomId = room?.room_id ?? null;
  const [replyTarget, setReplyTarget] = useAtom(
    room ? activeReplyTargetAtomFamily(roomId) : noRoomActiveReplyTargetAtom,
  );
  const [editingEventId, setEditingEventId] = useAtom(
    room ? editingEventIdAtomFamily(roomId) : noRoomEditingEventIdAtom,
  );
  const [membersDrawerOpen, setMembersDrawerOpen] = useAtom(
    room ? membersDrawerOpenAtomFamily(roomId) : noRoomMembersDrawerOpenAtom,
  );
  const roomSettingsTarget = useAtomValue(roomSettingsAtom);
  const setRoomSettingsTarget = useSetAtom(roomSettingsAtom);
  // Room settings is a full modal covering the chat — messages arriving (or
  // already at the bottom) behind it shouldn't be silently marked read, same
  // reasoning as `RoomsScreen`'s focus-suppression check for this atom.
  const roomSettingsOpen = roomSettingsTarget !== null;
  const { messages, loading, loadingMore, bottomSentinelRef, topSentinelRef, containerRef } =
    useChatTimeline(room, roomSettingsOpen);
  const senders = messages.map((m) => m.sender);
  const canRedactBySender = useCanRedactMap(roomId, currentUserId, senders);
  const { receiptsByEvent } = useReadReceipts(room?.room_id ?? null, currentUserId);
  const headerPresence = usePresence(room?.is_direct ? (room.dm_peer_user_id ?? null) : null);
  const { typingText, handleTypingInput, stopTyping } = useChatTyping(activeRoomId, currentUserId);
  const participants = useRoomParticipants(activeRoomId);
  useEffect(() => {
    setFollowingExpanded(false);
  }, [activeRoomId]);
  const { uploads, handleAttachFile, dismissUpload } = useAttachmentUploads(activeRoomId);
  const { commandFeedback, setCommandFeedback, handleComposerSubmit, handleSlashCommand } =
    useMessageSend({
      room,
      editingEventId,
      replyTarget,
      setEditingEventId,
      setReplyTarget,
      stopTyping,
    });
  const { handleToggleReaction, handleDelete, handleReply, handleEdit } = useMessageActions({
    roomId: activeRoomId,
    setReplyTarget,
    setEditingEventId,
  });

  // No `send_queue:update` listener here: the live `Timeline` (Spec 14)
  // surfaces the same pending -> sent -> error transitions as `send_state` on
  // the `RoomMessageSummary`s pushed via `timeline:update` above, so a
  // separate room-wide send-queue event would just be redundant for the
  // message list.

  if (!room) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Select a room to start chatting
      </div>
    );
  }

  const editingMessage = messages.find((m) => m.event_id === editingEventId) ?? null;
  const composerMode: ComposerMode = editingEventId ? "edit" : replyTarget ? "reply" : "send";

  async function handleAttachClick() {
    if (isWebBuild()) {
      attachmentInputRef.current?.click();
      return;
    }
    const selected = await openFileDialog({ multiple: false });
    if (typeof selected === "string") {
      await handleAttachFile(selected);
    }
  }

  function handleAttachmentInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) {
      handleAttachFile(file);
    }
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files) as (File & { path?: string })[];
    const file = files[0];
    const upload = file ? attachmentUploadPayload(file) : null;
    if (upload) {
      handleAttachFile(upload);
    }
  }

  function handlePaste(event: React.ClipboardEvent<HTMLDivElement>) {
    const files = Array.from(event.clipboardData.files) as (File & { path?: string })[];
    const file = files.find((f) => f.type.startsWith("image/"));
    const upload = file ? attachmentUploadPayload(file) : null;
    if (upload) {
      event.preventDefault();
      handleAttachFile(upload);
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
            <AvatarImage src={resolveAvatar(room.avatar_path, room.avatar_url)} alt="" />
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

      <div ref={containerRef} className="flex flex-1 flex-col gap-1 overflow-y-auto p-4">
        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!loading && messages.length === 0 && (
          <p className="text-sm text-muted-foreground">No messages yet</p>
        )}
        {/* Block-level sibling of the flex message rows below (not a flex
            item within one), same reasoning as the bottom sentinel — scrolling
            this near the top of the viewport loads one more page of older
            history (Spec 26 Phase 1). */}
        <div ref={topSentinelRef} className="h-px w-full shrink-0" />
        {loadingMore && (
          <p className="text-center text-xs text-muted-foreground">Loading older messages…</p>
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
              onReply={() => handleReply(message)}
              onReact={(emoji) => handleToggleReaction(message.event_id, emoji)}
              onEdit={() => handleEdit(message.event_id)}
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

      <UploadTray uploads={uploads} onDismiss={dismissUpload} />

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
        <input
          ref={attachmentInputRef}
          type="file"
          className="hidden"
          onChange={handleAttachmentInputChange}
        />
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
            onTypingInput={handleTypingInput}
            onBlur={stopTyping}
            onEmptyChange={setIsComposerEmpty}
          />
          {/* `bg-primary-solid` (not `bg-primary`): solid fill under
              near-white text/icon — see button.tsx's comment / tokens.css.
              Disabled while there's no text to send — this composer has no
              attachment concept (files upload/send independently), so
              trimmed text emptiness is the only signal. */}
          <button
            type="button"
            aria-label="Send"
            onClick={() => composerRef.current?.submit()}
            disabled={isComposerEmpty}
            className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary-solid text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
      {participants.length > 0 && (
        <button
          type="button"
          aria-expanded={followingExpanded}
          onClick={() => setFollowingExpanded((expanded) => !expanded)}
          className="w-full border-t border-border px-4 py-2 text-left text-xs text-muted-foreground hover:bg-accent/50"
        >
          {followingLabel(participants.map((p) => p.display_name ?? p.user_id))}
          {followingExpanded && (
            <div className="mt-1.5 flex flex-col gap-1">
              {participants.map((p) => (
                <span key={p.user_id} className="flex items-center gap-2 text-foreground">
                  <span
                    className="flex size-4 shrink-0 items-center justify-center rounded-full text-[7px] font-bold text-white"
                    style={{ background: avatarColor(p.user_id) }}
                  >
                    {initials(p.user_id, p.display_name)}
                  </span>
                  {p.display_name ?? p.user_id}
                </span>
              ))}
            </div>
          )}
        </button>
      )}
    </div>
  );
}
