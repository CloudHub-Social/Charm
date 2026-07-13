import { useEffect, useMemo, useRef, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { ChevronDown, Info, Paperclip, Send, Settings, X } from "lucide-react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
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
import {
  formatDateDividerLabel,
  isDateDividerBoundary,
  unreadDividerIndex,
} from "./timelineDividers";
import { useChatTyping } from "./useChatTyping";
import { useMessageActions } from "./useMessageActions";
import { useMessageSend } from "./useMessageSend";

interface ChatShellProps {
  room: RoomSummary | null;
  currentUserId: string;
}

/** Virtuoso `Header` component (Spec 26 Phase 2) — reads `loadingMore` off
 * Virtuoso's `context` prop rather than closing over component state, so it's
 * a stable reference across renders instead of being redefined on every one. */
function LoadingOlderHeader({ context }: { context?: { loadingMore: boolean } }) {
  if (!context?.loadingMore) return null;
  return <p className="pb-2 text-center text-xs text-muted-foreground">Loading older messages…</p>;
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
  const {
    messages,
    loading,
    loadingMore,
    hasMore,
    paginationError,
    firstItemIndex,
    loadMoreHistory,
    handleAtBottomStateChange,
  } = useChatTimeline(room, roomSettingsOpen);
  // Auto-paginates when the newest page comes back with zero *renderable*
  // messages but more history to page back through — some Matrix timeline
  // items (state events, polls, etc.) are filtered out of
  // `RoomMessageSummary` entirely, so a room whose latest page is all such
  // items would otherwise render "No messages yet" with Virtuoso never
  // mounted at all (gated on `messages.length > 0` below), meaning its
  // `startReached` sentinel never exists to trigger the load the normal way.
  // `!paginationError` stops this from retrying forever against a
  // persistent backend/network failure — a rejected `loadMoreHistory()`
  // otherwise leaves every other dependency here unchanged once `loadingMore`
  // flips back to `false`, which would immediately re-trigger it again.
  useEffect(() => {
    if (!loading && messages.length === 0 && hasMore && !loadingMore && !paginationError) {
      loadMoreHistory();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `loadMoreHistory` closes over refs, not state.
  }, [loading, messages.length, hasMore, loadingMore, paginationError]);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  // Mirrors Virtuoso's `atBottomStateChange` — drives the "jump to present"
  // pill's visibility (Spec 26 Phase 2). Starts `true` since a freshly
  // opened room always renders scrolled to bottom.
  const [atBottom, setAtBottom] = useState(true);
  // Mirrors `atBottom` for the "jump to present" pill's counting effect
  // below, which must read its *current* value only at the moment a real
  // `messages` update commits — not re-run its counting logic merely because
  // `atBottom` itself changed. See that effect's comment for the bug this
  // avoids: `newMessageKeys`'s `useMemo` returns the same memoized Set across
  // renders where `messages`/`loading`/`loadingMore`/`activeRoomId` didn't
  // change, so a plain `[newMessageKeys, atBottom]` dependency list would
  // recount that same stale Set every time the user's scroll position
  // changes, not just when new messages actually arrive.
  const atBottomRef = useRef(atBottom);
  atBottomRef.current = atBottom;
  // Count of not-yet-seen messages (excluding the current user's own —
  // sending a message is already an intentional "return to present" action,
  // so it shouldn't need its own pill) that arrived while scrolled away from
  // bottom. Reset to 0 once the user is back at bottom, whether by scrolling
  // there themselves or by clicking the pill.
  const [newMessageCount, setNewMessageCount] = useState(0);
  function handleVirtuosoAtBottomStateChange(bottom: boolean) {
    handleAtBottomStateChange(bottom);
    setAtBottom(bottom);
    if (bottom) setNewMessageCount(0);
  }
  function handleJumpToPresent() {
    // `"LAST"` (rather than the equivalent `messages.length - 1`): Virtuoso's
    // own sentinel for "the actual last data item," regardless of
    // `firstItemIndex` — reads slightly clearer than the plain arithmetic and
    // needs no `messages` dependency to stay correct. (`scrollToIndex`'s
    // numeric `index` is a plain 0-based position into `data`, clamped
    // against its length — *not* offset by `firstItemIndex`, unlike the
    // numbering `itemContent`/`computeItemKey` receive; see
    // `handleJumpToMessage`'s comment for the bug that distinction caused.)
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end" });
    // Same reconciliation path as Virtuoso's own `atBottomStateChange` (mark-
    // as-read, pill reset) rather than only updating local `atBottom` state
    // — a real Virtuoso may not synchronously report "at bottom" right after
    // an imperative `scrollToIndex`, so this click is treated as having
    // already arrived rather than waiting on that callback to catch up.
    handleVirtuosoAtBottomStateChange(true);
  }
  // Scrolls to a loaded message by event id — the reply-preview "jump to the
  // replied-to message" click used to be a plain
  // `document.getElementById(...).scrollIntoView(...)`, which only ever
  // worked because every message was permanently mounted in the old flat
  // `.map()`. Under Virtuoso, a loaded-but-currently-offscreen message has no
  // DOM node to find, so this instead looks up its position in `messages`
  // and scrolls the virtualizer there directly. A no-op if the target isn't
  // (or is no longer) in the currently-loaded array — e.g. it's further back
  // than backward pagination has reached, same as the old behavior silently
  // doing nothing for a message that was never in the DOM to begin with.
  //
  // `scrollToIndex`'s numeric `index` is a plain 0-based position into the
  // current `data` array — clamped against `data.length`, not offset by
  // `firstItemIndex` — despite `itemContent`/`computeItemKey` receiving that
  // `firstItemIndex`-shifted "absolute" numbering for their own (unrelated)
  // purpose. Passing `firstItemIndex + index` here (as an earlier version
  // did, matching the reasoning for `"LAST"` above) is a huge, always-out-
  // of-range number that Virtuoso's own clamping silently resolves to the
  // *last* item — every reply jump before this fix landed on the newest
  // message instead of the replied-to one.
  function handleJumpToMessage(eventId: string) {
    const index = messages.findIndex((m) => m.event_id === eventId);
    if (index < 0) return;
    virtuosoRef.current?.scrollToIndex({
      index,
      align: "center",
      behavior: "smooth",
    });
  }
  // Jump-to-present state (Spec 26 Phase 2) lives here in `ChatShell`, not in
  // `useChatTimeline` or on the (per-room-remounted) Virtuoso instance —
  // switching rooms while scrolled away and mid-pill in room A must not
  // leave A's stale `atBottom`/`newMessageCount` visible over room B's first
  // render, before B's own `atBottomStateChange` has fired. Reset
  // synchronously during render (React's documented "adjusting state when a
  // prop changes" pattern), not in a passive `useEffect`: an effect only
  // runs *after* paint, so room B's first frame would still show room A's
  // stale pill (and could even count an immediate room-B update as "arrived
  // while scrolled away") for one frame before the effect caught up.
  const previousActiveRoomIdForPillRef = useRef(activeRoomId);
  if (previousActiveRoomIdForPillRef.current !== activeRoomId) {
    previousActiveRoomIdForPillRef.current = activeRoomId;
    setAtBottom(true);
    setNewMessageCount(0);
  }
  // Tracks which message rows have already been rendered once, keyed by
  // `messageRowKey`, so only genuinely new arrivals get the slide-up+fade
  // entrance — not every row on initial load/pagination.
  //
  // Seeding waits for a *transition* into `loading === false` for the
  // active room, not just "loading currently reads false": `useChatTimeline`
  // initializes its own `loading` state to `false` and only flips it to
  // `true` inside an effect, which hasn't run yet on this component's very
  // first render — so `loading` misleadingly reads `false` on that render
  // too, alongside `messages` still being `[]`/stale. Seeding there would
  // treat the *next* render (the room's real initial page arriving) as
  // "seen for the first time", making every historical message look new
  // and animate in. `hasStartedLoadingRoomIdRef` records having actually
  // observed `loading === true` for this room first, so seeding only fires
  // once real loading has demonstrably started and then finished.
  //
  // Diffed and marked-seen inside a `useMemo` keyed on `messages` itself
  // (not a plain `useEffect` with no dependency array) so this only runs
  // once per actual `messages` update, not on every render — ChatShell
  // re-renders for plenty of reasons unrelated to the timeline (typing
  // indicator ticks, the following-bar fetch, etc.), and an effect with no
  // deps re-adding the same keys on one of those incidental re-renders would
  // flip a message's `isNew` back to `false` before the animation ever gets
  // committed to the DOM.
  const seenRowKeysRef = useRef<Set<string>>(new Set());
  const seededRoomIdRef = useRef<string | null>(null);
  const hasStartedLoadingRoomIdRef = useRef<string | null>(null);
  if (loading) hasStartedLoadingRoomIdRef.current = activeRoomId;
  // Closing a room (activeRoomId -> null) and later reopening the *same*
  // room id must go through the seed dance again from scratch: messages
  // that arrived while it was closed were never diffed against
  // `seenRowKeysRef`, so without this reset the stale refs from the prior
  // visit would either skip reseeding (letting old-but-unseen messages
  // animate) or diff against a now-irrelevant baseline.
  if (activeRoomId === null) {
    seededRoomIdRef.current = null;
    hasStartedLoadingRoomIdRef.current = null;
  }
  // Tracks `firstItemIndex` as of the last time this hook's effect fully
  // processed a `messages` update, so the memo below can tell precisely how
  // many *leading* entries in the current `messages` array are freshly-
  // prepended older history (from `useChatTimeline`'s own identity-based
  // prepend detection — see `applyMessages`), rather than a coarse
  // "was any pagination request in flight" flag. That coarser approach (an
  // earlier version of this file) blanket-suppressed the *entire* update
  // whenever `loadingMore` had been true, which also wrongly suppressed a
  // genuinely new live message appended to the tail if it happened to race
  // an in-flight `loadMoreHistory` request — it would never animate in or
  // count toward the jump-to-present pill. Since `firstItemIndex` only ever
  // decreases for a true prepend (a same-update tail-only live arrival
  // leaves it unchanged), comparing it here separates the two cases exactly.
  const previousFirstItemIndexRef = useRef(firstItemIndex);
  // The memo callback below is pure — no ref mutation inside it. `React.
  // StrictMode` (see `src/main.tsx`) double-invokes memo callbacks for the
  // same commit; mutating `seenRowKeysRef`/`previousFirstItemIndexRef`/
  // `seededRoomIdRef` *inside this memo* would make the second invocation
  // see state already consumed by the first, silently returning an empty
  // `fresh` set for a message that should have animated. (The plain
  // assignments above and in the paired `useEffect` below are fine under
  // double-invocation — they're unconditional/idempotent, not reads of this
  // memo's own prior output — it's specifically conditional mutation from
  // inside the memo body that's unsafe.) The consuming writes that depend on
  // this render's `fresh` diff (marking rows seen, advancing the tracked
  // `firstItemIndex`) happen in the `useEffect` below, which — sharing this
  // memo's exact dependency list — fires exactly once per committed
  // `messages`/`loading`/`loadingMore`/`activeRoomId`/`firstItemIndex`
  // change, not on every incidental re-render.
  const newMessageKeys = useMemo(() => {
    const readyToSeed = !loading && hasStartedLoadingRoomIdRef.current === activeRoomId;
    if (!readyToSeed) return new Set<string>();
    if (seededRoomIdRef.current !== activeRoomId) return new Set<string>();
    const prependedCount = Math.max(0, previousFirstItemIndexRef.current - firstItemIndex);
    const fresh = new Set<string>();
    messages.forEach((m, i) => {
      if (i < prependedCount) return;
      const key = messageRowKey(m);
      if (!seenRowKeysRef.current.has(key)) fresh.add(key);
    });
    return fresh;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, loading, loadingMore, activeRoomId, firstItemIndex]);
  useEffect(() => {
    const readyToSeed = !loading && hasStartedLoadingRoomIdRef.current === activeRoomId;
    if (!readyToSeed) return;
    if (seededRoomIdRef.current !== activeRoomId) {
      seededRoomIdRef.current = activeRoomId;
      seenRowKeysRef.current = new Set(messages.map(messageRowKey));
      previousFirstItemIndexRef.current = firstItemIndex;
      return;
    }
    // "Jump to present" pill (Spec 26 Phase 2): counts `newMessageKeys` (the
    // same genuinely-new-arrival diff the entrance animation uses, excluding
    // the current user's own messages — sending is already an intentional
    // "return to present" action) into `newMessageCount`, but *only inside
    // this effect* — which fires exactly once per real `messages` update —
    // reading `atBottomRef.current` at that exact moment, not as a
    // dependency. An earlier version depended on `[newMessageKeys, atBottom]`
    // directly: `newMessageKeys` is a `useMemo` that returns the *same*
    // memoized Set across renders where `messages`/`loading`/`loadingMore`/
    // `activeRoomId`/`firstItemIndex` didn't change, so merely scrolling away
    // from bottom (changing only `atBottom`) re-ran that effect against the
    // same stale Set and double-counted messages that had already arrived
    // while at bottom. Gating on the ref instead of a dependency means this
    // only ever evaluates once per actual data change, with whatever
    // `atBottom` was true at that moment. Reset to 0 happens in
    // `handleVirtuosoAtBottomStateChange`/`handleJumpToPresent`/the
    // room-change effect above, not here.
    if (!atBottomRef.current) {
      const ownRowKeys = new Set(
        messages.filter((m) => m.sender === currentUserId).map(messageRowKey),
      );
      const incoming = [...newMessageKeys].filter((key) => !ownRowKeys.has(key)).length;
      if (incoming > 0) setNewMessageCount((count) => count + incoming);
    }
    messages.forEach((m) => seenRowKeysRef.current.add(messageRowKey(m)));
    previousFirstItemIndexRef.current = firstItemIndex;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, loading, loadingMore, activeRoomId, firstItemIndex]);
  // The "New messages" divider's position is frozen at the *identity* of
  // the first unread message as of opening this room — not re-derived from
  // live `messages.length` on every render. `useChatTimeline` marks the
  // room read as soon as it becomes active, which asynchronously drives the
  // room's unread count back to 0 via a later `room_list:update`, so using
  // a live count/index would make the divider flash in and immediately
  // disappear (or, worse, silently drift forward) instead of staying put
  // above the same message until the user switches rooms. Freezing by
  // message key (not a frozen index recomputed against a growing array)
  // also survives new messages appending and older history prepending via
  // backward pagination — both change every live index without changing
  // which message was first unread.
  //
  // Uses `room.unread_messages` (ambient unread message count), not
  // `room.unread_count` (notifications/mentions only, per RoomSummary's own
  // doc comment) — a room can have unread messages with zero notifications,
  // or a mention buried mid-page, and `unread_count` reflects neither
  // correctly for "where does the unread history start".
  //
  // Seeding waits for a `loading` transition (via
  // hasStartedLoadingRoomIdRef), not just "loading currently reads false":
  // `useChatTimeline`'s `loading` state starts at `false` before its fetch
  // effect has run, so seeding on that premature render would freeze the
  // boundary against a stale/empty message snapshot.
  const unreadBoundaryKeyRef = useRef<string | null>(null);
  const seededUnreadRoomIdRef = useRef<string | null>(null);
  if (
    !loading &&
    hasStartedLoadingRoomIdRef.current === activeRoomId &&
    seededUnreadRoomIdRef.current !== activeRoomId
  ) {
    seededUnreadRoomIdRef.current = activeRoomId;
    const unreadCount = room?.unread_messages ?? 0;
    const boundaryIdx = unreadDividerIndex(messages.length, unreadCount);
    const boundaryMessage = boundaryIdx >= 0 ? messages[boundaryIdx] : undefined;
    unreadBoundaryKeyRef.current = boundaryMessage ? messageRowKey(boundaryMessage) : null;
  }
  const unreadStartIdx = unreadBoundaryKeyRef.current
    ? messages.findIndex((m) => messageRowKey(m) === unreadBoundaryKeyRef.current)
    : -1;
  // A date divider or the frozen unread divider breaks a consecutive-sender
  // run, even when the surrounding messages are literally from the same
  // sender — otherwise the message right after the divider renders without
  // its own avatar/name (looking like a continuation of the group above the
  // divider), and the message right before it can lose its timestamp.
  function isGroupBreakAt(index: number): boolean {
    return isDateDividerBoundary(messages, index) || index === unreadStartIdx;
  }
  const senders = messages.map((m) => m.sender);
  // Best-effort display-name lookup for read-receipt tooltips ("Read by
  // {name}") — built from senders already present in the loaded timeline
  // rather than a dedicated member-list fetch, since a reader is virtually
  // always someone who has also sent a message in view. Falls back to the
  // bare user id in MessageRow when a reader hasn't sent anything loaded.
  const senderNameByUserId = new Map<string, string>();
  for (const m of messages) {
    if (m.sender_display_name != null) senderNameByUserId.set(m.sender, m.sender_display_name);
  }
  const canRedactBySender = useCanRedactMap(roomId, currentUserId, senders);
  const { receiptsByEvent } = useReadReceipts(room?.room_id ?? null, currentUserId);
  const headerPresence = usePresence(room?.is_direct ? (room.dm_peer_user_id ?? null) : null);
  const { typingText, handleTypingInput, stopTyping } = useChatTyping(activeRoomId, currentUserId);
  const participants = useRoomParticipants(activeRoomId, currentUserId);
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

  // Sending (or replying) always scrolls to the user's own new message,
  // regardless of prior scroll position — `followOutput="auto"` alone won't
  // do this, since Virtuoso only follows new content while already
  // considered at bottom, and the "jump to present" pill deliberately
  // excludes the user's own messages from its count (sending is already an
  // intentional "return to present" action). Without this, sending while
  // scrolled up would leave the just-sent message offscreen with no visible
  // way back to it. Skipped for edits: saving an edit to an old message
  // shouldn't relocate the view to it.
  function handleComposerSubmitAndScroll(content: Parameters<typeof handleComposerSubmit>[0]) {
    const wasEditing = composerMode === "edit";
    handleComposerSubmit(content);
    if (!wasEditing) {
      virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end" });
      handleVirtuosoAtBottomStateChange(true);
    }
  }

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

      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* While `messages` is empty but `hasMore` is true (and no request
            has failed), older pages are being auto-fetched (see the effect
            above) looking for a renderable message — keep showing the
            loading state rather than "No messages yet", which would
            otherwise flash misleadingly for a room whose *newest* page
            happened to be entirely unsupported item types. */}
        {(loading || (messages.length === 0 && hasMore && !paginationError)) && (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        )}
        {!loading && messages.length === 0 && !hasMore && (
          <p className="p-4 text-sm text-muted-foreground">No messages yet</p>
        )}
        {!loading && messages.length === 0 && hasMore && paginationError && (
          <p className="p-4 text-sm text-muted-foreground">Couldn't load messages</p>
        )}
        {!loading && messages.length > 0 && (
          <Virtuoso
            // Remounts (and so resets Virtuoso's internal scroll/measurement
            // state, including `firstItemIndex`) on every room switch —
            // simpler and more robust than manually resetting each piece of
            // that state ourselves, and matches `useChatTimeline`'s own
            // per-room reset of `firstItemIndex`.
            key={room.room_id}
            ref={virtuosoRef}
            className="p-4"
            data={messages}
            firstItemIndex={firstItemIndex}
            initialTopMostItemIndex={messages.length - 1}
            alignToBottom
            followOutput="auto"
            startReached={loadMoreHistory}
            atBottomStateChange={handleVirtuosoAtBottomStateChange}
            context={{ loadingMore }}
            components={{ Header: LoadingOlderHeader }}
            // Without this, Virtuoso keys rendered rows by their current
            // position, not identity. A full `timeline:update` snapshot can
            // remove an item from the *middle* of `messages` (not just
            // append/prepend) — e.g. an `UnableToDecrypt` placeholder
            // resolving into a msgtype `RoomMessageSummary` filters out
            // entirely — which shifts every later message's index by one.
            // Index-keyed rows would then have every later message inherit
            // the previous row's React state and Virtuoso's per-row
            // measurement cache: open action menus, measured heights, and
            // row-local UI state could all end up attached to the wrong
            // message.
            computeItemKey={(_index, message) => messageRowKey(message)}
            itemContent={(index, message) => {
              const i = index - firstItemIndex;
              const own = message.sender === currentUserId;
              const prev = messages[i - 1];
              const next = messages[i + 1];
              // Own messages are always redactable — don't wait on the async
              // `canRedactBySender` resolution (which only matters for other
              // senders' power levels) or Delete flashes hidden-then-shown.
              const allowedToRedact = own || (canRedactBySender[message.sender] ?? false);
              const readers = receiptsByEvent.get(message.event_id) ?? [];

              return (
                // `flex flex-col` (not a plain block `div`): Virtuoso measures
                // this wrapper's own box to estimate/settle row height, but
                // `BubbleMessageRow`/`DiscordMessageRow` put their grouping
                // spacing on the row root as a top *margin* (`mt-3`/`mt-0.5`),
                // which a plain block parent with no padding/border lets
                // collapse through its own top edge — Virtuoso would then
                // under-measure the row by exactly that margin, breaking
                // bottom-detection and prepend-anchoring math. A flex
                // container's children never margin-collapse with it (they
                // participate in the flex formatting context, not the block
                // one), so this fully contains the row's true rendered height
                // with no visual change (still a single child either way).
                <div className="flex flex-col pb-1">
                  {isDateDividerBoundary(messages, i) && (
                    <div className="my-2 flex items-center gap-3 text-xs font-semibold text-muted-foreground">
                      {formatDateDividerLabel(message.timestamp_ms)}
                    </div>
                  )}
                  {i === unreadStartIdx && (
                    <div className="my-2 flex items-center gap-2">
                      <div className="h-px flex-1 bg-destructive-solid" />
                      <span className="text-[11px] font-semibold text-destructive-solid">
                        New messages
                      </span>
                      <div className="h-px flex-1 bg-destructive-solid" />
                    </div>
                  )}
                  <MessageRow
                    message={message}
                    roomId={room.room_id}
                    own={own}
                    sameSenderAsPrev={prev?.sender === message.sender && !isGroupBreakAt(i)}
                    sameSenderAsNext={next?.sender === message.sender && !isGroupBreakAt(i + 1)}
                    canRedact={allowedToRedact}
                    readers={readers}
                    senderNameByUserId={senderNameByUserId}
                    // Excludes `own` messages: `messageRowKey` (transaction_id ??
                    // event_id) isn't stable across the local-echo -> ack
                    // transition for a message *we* sent — `transaction_id()`
                    // only returns `Some` while an item is still local (see
                    // `timeline.rs`'s `build_message_summary`), so the row's key
                    // itself changes once the homeserver ack replaces the local
                    // echo. That makes the acked row look "unseen" and replay the
                    // entrance animation a second time. Other senders' messages
                    // have no local-echo phase to begin with, so this exclusion
                    // only ever skips the case that would otherwise double-animate.
                    isNew={!own && newMessageKeys.has(messageRowKey(message))}
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
                    onJumpToMessage={handleJumpToMessage}
                  />
                </div>
              );
            }}
          />
        )}
        {/* "Jump to present" (Spec 26 Phase 2): shown only while scrolled away
            from the live bottom and at least one new (non-own) message has
            arrived since — never while already at bottom, the Charm 1.0 #328
            failure mode this migration is meant to avoid. */}
        {!atBottom && newMessageCount > 0 && (
          <button
            type="button"
            onClick={handleJumpToPresent}
            className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-primary-solid px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-md hover:opacity-90"
          >
            {newMessageCount} new message{newMessageCount === 1 ? "" : "s"}
            <ChevronDown className="size-3.5" />
          </button>
        )}
      </div>

      {typingText && (
        <output className="flex items-center gap-2 px-4 pb-1 text-xs font-medium text-muted-foreground">
          <span className="flex items-center gap-[3px]" aria-hidden="true">
            <span
              className="typing-dot size-[5px] rounded-full bg-muted-foreground"
              style={{ animationDelay: "0s" }}
            />
            <span
              className="typing-dot size-[5px] rounded-full bg-muted-foreground"
              style={{ animationDelay: "0.2s" }}
            />
            <span
              className="typing-dot size-[5px] rounded-full bg-muted-foreground"
              style={{ animationDelay: "0.4s" }}
            />
          </span>
          <span>{typingText}</span>
        </output>
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
            onSubmit={handleComposerSubmitAndScroll}
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
