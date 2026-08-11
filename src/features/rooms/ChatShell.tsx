import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { ChevronDown, MessageCircle, Paperclip, Send, Type, X } from "lucide-react";
import { Virtuoso } from "react-virtuoso";
import * as Sentry from "@sentry/react";
import { usePresence } from "@/features/presence/usePresence";
import { cn } from "@/lib/utils";
import { useAdaptiveLayout } from "@/features/shell/useAdaptiveLayout";
import { useFeatureFlagPersistenceVersion, useFlag } from "@/featureFlags";
import { isWebBuild } from "@/lib/platform";
import { canRedactOthers, onRoomDetailsUpdate, type RoomSummary } from "@/lib/matrix";
import { avatarColor, displayName, initials } from "./roomDisplay";
import { Composer, type ComposerHandle, type ComposerMode } from "./Composer";
import { messageRowKey } from "./MessageRow";
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
import { useMessageSend } from "./useMessageSend";
import { MessagePillProfileDialog, type MessagePillProfile } from "./MessagePillProfileDialog";
import { useTimelineViewport } from "./useTimelineViewport";
import { ChatHeader } from "./ChatHeader";
import { useMessagePinning } from "./useMessagePinning";
import { useMessageActionController } from "./useMessageActionController";
import { MessageActionDialogs } from "./MessageActionDialogs";
import { TimelineMessageRow } from "./TimelineMessageRow";
import {
  hideMembershipEventsAtom,
  messageLayoutAtom,
  showHiddenEventsAtom,
} from "@/features/appearance/atoms";
import { bucketTimelineNotices, TimelineNoticeList } from "./TimelineNotices";

interface ChatShellProps {
  room: RoomSummary | null;
  currentUserId: string;
  onBack?: () => void;
  onNavigateToRoom?: (roomIdentifier: string) => void;
  /**
   * An event id to scroll to as soon as it's loaded in this room's timeline
   * (Spec 12's Saved Messages "jump to message"). Set by the caller after
   * selecting the bookmark's room; cleared via `onJumpHandled` once the jump
   * completes (found and scrolled to) or definitively fails (not reachable
   * even after `loadTimelineAroundEvent`), so a stale target doesn't
   * re-trigger a jump on some unrelated later render.
   */
  jumpToEventId?: string | null;
  onJumpHandled?: () => void;
}

/** Virtuoso `Header` component (Spec 26 Phase 2) — reads `loadingMore` off
 * Virtuoso's `context` prop rather than closing over component state, so it's
 * a stable reference across renders instead of being redefined on every one. */
function LoadingOlderHeader({ context }: { context?: { loadingMore: boolean; hasMore: boolean } }) {
  if (context?.loadingMore) {
    return (
      <p className="pb-2 text-center text-xs text-muted-foreground">Loading older messages…</p>
    );
  }
  if (context && !context.hasMore) {
    return (
      <div className="flex items-center gap-3 pb-3 text-[11px] font-medium text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        <span>You're all caught up</span>
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }
  return null;
}

function hasDraggedFiles(dataTransfer: DataTransfer): boolean {
  return dataTransfer.files.length > 0 || Array.from(dataTransfer.types).includes("Files");
}

/**
 * Per-message affordance state: whether the current user sent it, and
 * whether they're allowed to redact it (own messages always; others gated
 * by the room's redact power level). A redact check on someone else's
 * message depends only on the room's power levels and the current user's
 * own level — never on who actually sent it (see `can_redact_others_impl`'s
 * doc comment) — so this fetches `canRedactOthers` once per room rather than
 * once per unique sender. The prior per-sender `canRedact` version was a
 * pure N+1: every additional sender in a room repeated an identical query
 * (Sentry issue CHARM-3, Seer-confirmed root cause in this hook).
 * Resolution happens in an effect (not during render) so it can safely call
 * `setState` without triggering React's render-loop guard.
 */
function useCanRedactMap(roomId: string, currentUserId: string, senders: readonly string[]) {
  // A monotonic token bumped every time `roomId` changes, including
  // *returning* to a room previously visited — `roomId` alone isn't
  // sufficient to key a trusted resolved value, since it's reused on
  // re-entry: if the user was demoted from redact power while away, the
  // earlier visit's `allowed=true` would otherwise be trusted again as
  // soon as the room is reselected, for the whole window before the fresh
  // fetch below resolves (Codex review on #287, P2 — a follow-up on the
  // cross-room leak this hook already guards against). Bumped via React's
  // documented "adjusting state during render" pattern
  // (react.dev/learn/you-might-not-need-an-effect), not an effect, so the
  // stale value is invalidated before this render is ever painted rather
  // than after — the same reasoning that motivated deriving
  // `canRedactOthersInRoom` from render at all instead of an effect reset.
  const [activation, setActivation] = useState(() => ({ roomId, token: 0 }));
  if (activation.roomId !== roomId) {
    setActivation({ roomId, token: activation.token + 1 });
  }

  // Tagged with the activation it resolved *for* (not the room, and not a
  // plain boolean) — derived against the current activation at render time
  // below, rather than reset by a passive effect. An effect-based reset
  // doesn't run until *after* the new room's first paint, so that first
  // render would still see the *previous* activation's resolved value: a
  // room where redact was allowed, immediately followed by one where it
  // isn't (or the same room re-entered after a demotion), could briefly
  // show — and let the user submit — a Delete action the server then
  // rejects (Codex review on #287, P3, and the P2 above extending it to
  // same-room re-entry).
  const [resolvedPermission, setResolvedPermission] = useState<{
    token: number;
    allowed: boolean;
  } | null>(null);
  const canRedactOthersInRoom =
    resolvedPermission?.token === activation.token ? resolvedPermission.allowed : false;
  // Tracks the activation a `canRedactOthers` call was actually issued for,
  // so its resolution can be checked against whatever activation is
  // current by the time it lands — without this, a slow response for a
  // room the user has since navigated away from (or back to, bumping the
  // token again) can overwrite a *different*, already-current activation's
  // permission result.
  const activationTokenRef = useRef(activation.token);
  activationTokenRef.current = activation.token;

  useEffect(() => {
    // No room selected (ChatShell's empty state, before its `if (!room)`
    // early return further down) — `canRedactOthers("")` would fail on
    // both the Rust IPC path (`RoomId::parse("")`) and the web transport
    // (`/api/rooms//can-redact-others`), surfacing as a spurious
    // backend/Sentry error on nothing but opening/closing a room (Codex
    // review on #287, P2).
    if (!roomId) return undefined;

    const requestedToken = activation.token;
    // A per-request sequence number, distinct from `activation.token`: the
    // token alone only distinguishes *activations* (room changes), not
    // multiple in-flight requests *within* the same activation. The initial
    // fetch below and a later `room_details:update`-triggered refetch share
    // one token, so without this, the initial request resolving *after* the
    // refetch (e.g. the refetch answering a demotion faster) would overwrite
    // the fresher, already-current result with its own stale one (Codex
    // review on #287, P2). Only the highest sequence number seen so far is
    // ever applied, regardless of resolution order.
    let latestRequestSeq = 0;
    const fetchPermission = () => {
      latestRequestSeq += 1;
      const requestSeq = latestRequestSeq;
      canRedactOthers(roomId)
        .then((allowed) => {
          if (activationTokenRef.current !== requestedToken) return;
          if (requestSeq !== latestRequestSeq) return;
          setResolvedPermission({ token: requestedToken, allowed });
        })
        .catch(logAndIgnore);
    };
    fetchPermission();

    // Re-fetches on `room_details:update`, not just on room entry: a power
    // level change (promotion/demotion) while the room stays open used to
    // leave `canRedactOthersInRoom` stuck at whatever it was when the room
    // was entered, silently hiding or wrongly showing the Delete affordance
    // until the user switched rooms (Codex review on #287, P2).
    const unlistenPromise = onRoomDetailsUpdate((details) => {
      if (details.room_id === roomId) fetchPermission();
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(logAndIgnore);
    };
  }, [roomId, activation.token]);

  return useMemo(() => {
    const bySender: Record<string, boolean> = {};
    for (const sender of senders) {
      bySender[sender] = sender === currentUserId || canRedactOthersInRoom;
    }
    return bySender;
  }, [senders, currentUserId, canRedactOthersInRoom]);
}

export function ChatShell({
  room,
  currentUserId,
  onBack,
  onNavigateToRoom,
  jumpToEventId = null,
  onJumpHandled,
}: ChatShellProps) {
  const layout = useAdaptiveLayout();
  const mobileChatRedesignEnabled = useFlag("mobile_chat_redesign");
  const mediaSendPolishEnabled = useFlag("media_send_polish");
  const timelineStateEventsEnabled = useFlag("timeline_state_events");
  const timelineStateEventsPersistenceVersion =
    useFeatureFlagPersistenceVersion("timeline_state_events");
  const messageLayout = useAtomValue(messageLayoutAtom);
  const hideMembershipEvents = useAtomValue(hideMembershipEventsAtom);
  const showHiddenEvents = useAtomValue(showHiddenEventsAtom);
  const userProfileCardsEnabled = useFlag("user_profile_cards");
  const mobile = layout === "mobile" && mobileChatRedesignEnabled;
  const [showMobileFormatting, setShowMobileFormatting] = useState(false);
  const composerRef = useRef<ComposerHandle>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const fileDragLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Drives the Send button's `disabled` state — there's no attachment
  // concept in the composer today (files upload and send independently via
  // `useAttachmentUploads`), so trimmed text emptiness is the only signal.
  const [isComposerEmpty, setIsComposerEmpty] = useState(true);
  const [followingExpanded, setFollowingExpanded] = useState(false);
  const [pillProfile, setPillProfile] = useState<MessagePillProfile | null>(null);
  const openProfile = (userId: string, label: string, source: "mention" | "message-sender") => {
    Sentry.addBreadcrumb({
      category: "ui.profile",
      message: "User profile opened",
      data: { source },
    });
    setPillProfile({ userId, label });
  };
  const [fileDragActive, setFileDragActive] = useState(false);
  // A file picked/dropped/pasted while `media_send_polish` is on is staged
  // here (rather than uploaded immediately) so the user gets a chance to add
  // a caption before it sends — see `handleConfirmPendingAttachment`.
  const [pendingAttachment, setPendingAttachment] = useState<{
    file: string | File;
    filename: string;
    roomId: string | null;
  } | null>(null);
  const [pendingAttachmentCaption, setPendingAttachmentCaption] = useState("");
  const roomId = room?.room_id ?? "";
  useEffect(() => {
    setPillProfile(null);
  }, [roomId]);
  const activeRoomId = room?.room_id ?? null;
  const visiblePendingAttachment =
    pendingAttachment?.roomId === activeRoomId ? pendingAttachment : null;
  useEffect(() => {
    setShowMobileFormatting(false);
    if (fileDragLeaveTimerRef.current !== null) {
      clearTimeout(fileDragLeaveTimerRef.current);
      fileDragLeaveTimerRef.current = null;
    }
    setFileDragActive(false);
    return () => {
      if (fileDragLeaveTimerRef.current !== null) {
        clearTimeout(fileDragLeaveTimerRef.current);
        fileDragLeaveTimerRef.current = null;
      }
    };
  }, [activeRoomId]);
  const [replyTarget, setReplyTarget] = useAtom(
    room ? activeReplyTargetAtomFamily(roomId) : noRoomActiveReplyTargetAtom,
  );
  const [editingEventId, setEditingEventId] = useAtom(
    room ? editingEventIdAtomFamily(roomId) : noRoomEditingEventIdAtom,
  );
  const [membersDrawerOpen, setMembersDrawerOpen] = useAtom(
    room ? membersDrawerOpenAtomFamily(roomId) : noRoomMembersDrawerOpenAtom,
  );
  // The right panel is a single slot (see `RoomsScreen`) — ChatShell keeps
  // the cross-feature exclusivity wiring while the pinning hook owns the
  // pinning-specific state below.
  const {
    enabled: messagePinningEnabled,
    drawerOpen: pinnedMessagesDrawerOpen,
    setDrawerOpen: setPinnedMessagesDrawerOpen,
    pinnedEventIds,
    canPinMessages,
  } = useMessagePinning(room);
  const roomSettingsTarget = useAtomValue(roomSettingsAtom);
  const setRoomSettingsTarget = useSetAtom(roomSettingsAtom);
  // Room settings is a full modal covering the chat — messages arriving (or
  // already at the bottom) behind it shouldn't be silently marked read, same
  // reasoning as `RoomsScreen`'s focus-suppression check for this atom.
  const roomSettingsOpen = roomSettingsTarget !== null;
  const {
    messages,
    timelineItems,
    loading,
    loadingMore,
    hasMore,
    paginationError,
    firstItemIndex,
    prependedCount,
    loadMoreHistory,
    handleAtBottomStateChange,
    hydrateCurrentTimeline,
    resetToLive,
  } = useChatTimeline(
    room,
    roomSettingsOpen,
    jumpToEventId !== null,
    timelineStateEventsEnabled,
    hideMembershipEvents,
    showHiddenEvents,
  );
  const noticeBuckets = useMemo(
    () =>
      timelineStateEventsEnabled
        ? bucketTimelineNotices(timelineItems, hideMembershipEvents, showHiddenEvents)
        : { beforeMessage: new Map(), trailing: [] },
    [hideMembershipEvents, showHiddenEvents, timelineItems, timelineStateEventsEnabled],
  );
  const hasVisibleNotices =
    noticeBuckets.beforeMessage.size > 0 || noticeBuckets.trailing.length > 0;
  const noticeOnlyScrollerRef = useRef<HTMLDivElement>(null);
  const noticeOnlyPinnedRef = useRef(true);
  useEffect(() => {
    noticeOnlyPinnedRef.current = true;
  }, [roomId]);
  useEffect(() => {
    const scroller = noticeOnlyScrollerRef.current;
    if (messages.length === 0 && hasVisibleNotices && scroller && noticeOnlyPinnedRef.current) {
      scroller.scrollTop = scroller.scrollHeight;
      handleAtBottomStateChange(true);
    }
  }, [
    handleAtBottomStateChange,
    hasVisibleNotices,
    messages.length,
    noticeBuckets.trailing.length,
  ]);
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
  // While this is true, `messages` is empty only because the empty-first-
  // page auto-pagination above is still working toward either real content
  // or a confirmed-exhausted history — not because the room's history is
  // actually empty. The various "seed once per room" effects below
  // (entrance-animation seen-set, unread-divider boundary) must not treat
  // this transient empty array as the room's real initial state: doing so
  // would permanently mark the seed as done against zero messages, so the
  // *real* first batch (whenever auto-pagination finds it) would incorrectly
  // read as a fresh arrival — animating in and (if scrolled away, though
  // unlikely this early) counting toward the jump-to-present pill — and
  // would freeze the unread divider's position against an empty snapshot
  // instead of the room's actual unread boundary.
  const awaitingEmptyPagePagination = messages.length === 0 && hasMore && !paginationError;
  const {
    virtuosoRef,
    atBottom,
    newMessageCount,
    hasFocusedView,
    newMessageKeys,
    unreadStartIdx,
    handleVirtuosoAtBottomStateChange,
    handleJumpToPresent,
    handleJumpToMessage,
    scrollToPresentAfterOwnSend,
  } = useTimelineViewport({
    room,
    currentUserId,
    messages,
    loading,
    loadingMore,
    hasMore,
    paginationError,
    prependedCount,
    awaitingEmptyPagePagination,
    jumpToEventId,
    onJumpHandled,
    handleAtBottomStateChange,
    resetToLive,
  });
  const noticeSignature = useMemo(
    () =>
      [...[...noticeBuckets.beforeMessage.values()].flat(), ...noticeBuckets.trailing]
        .map((item) => item.event_id)
        .join("\u0000"),
    [noticeBuckets],
  );
  const noticeAnchorRef = useRef<{
    roomId: string;
    eventId: string;
    top: number;
    signature: string;
  } | null>(null);
  useLayoutEffect(() => {
    const rows = [...document.querySelectorAll<HTMLElement>("[data-message-event-id]")].filter(
      (row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < window.innerHeight;
      },
    );
    const previous = noticeAnchorRef.current;
    if (previous?.roomId === roomId && previous.signature !== noticeSignature) {
      const anchored = rows.find((row) => row.dataset.messageEventId === previous.eventId);
      if (anchored) {
        const delta = anchored.getBoundingClientRect().top - previous.top;
        if (Math.abs(delta) > 0.5) {
          virtuosoRef.current?.scrollBy({ top: delta, behavior: "auto" });
        }
      }
    }
    const firstVisible = rows[0];
    noticeAnchorRef.current = firstVisible
      ? {
          roomId,
          eventId: firstVisible.dataset.messageEventId ?? "",
          top: firstVisible.getBoundingClientRect().top,
          signature: noticeSignature,
        }
      : null;
  }, [messages, noticeSignature, roomId, virtuosoRef]);
  const previousTimelineStateEventsPersistenceVersionRef = useRef(
    timelineStateEventsPersistenceVersion,
  );
  useEffect(() => {
    const previousVersion = previousTimelineStateEventsPersistenceVersionRef.current;
    previousTimelineStateEventsPersistenceVersionRef.current =
      timelineStateEventsPersistenceVersion;
    if (
      timelineStateEventsPersistenceVersion !== previousVersion &&
      timelineStateEventsEnabled &&
      room
    ) {
      void hydrateCurrentTimeline();
    }
    // hydrateCurrentTimeline closes over the current room visit generation; the flag
    // transition and room id are the only activation inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.room_id, timelineStateEventsEnabled, timelineStateEventsPersistenceVersion]);
  const trailingNoticeInitialScrollRoomRef = useRef<string | null>(null);
  const leadingNoticeInitialScrollRoomRef = useRef<string | null>(null);
  useEffect(() => {
    trailingNoticeInitialScrollRoomRef.current = null;
    leadingNoticeInitialScrollRoomRef.current = null;
  }, [room?.room_id]);
  useEffect(() => {
    if (
      room &&
      messages.length > 0 &&
      noticeBuckets.trailing.length > 0 &&
      trailingNoticeInitialScrollRoomRef.current !== room.room_id
    ) {
      trailingNoticeInitialScrollRoomRef.current = room.room_id;
      if (!atBottom) return undefined;
      const frame = requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end" });
      });
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [atBottom, messages.length, noticeBuckets.trailing.length, room, virtuosoRef]);
  const finalLeadingNoticeCount =
    messages.length > 0
      ? (noticeBuckets.beforeMessage.get(messages.at(-1)?.event_id ?? "")?.length ?? 0)
      : 0;
  useEffect(() => {
    if (
      room &&
      messages.length > 0 &&
      finalLeadingNoticeCount > 0 &&
      leadingNoticeInitialScrollRoomRef.current !== room.room_id
    ) {
      leadingNoticeInitialScrollRoomRef.current = room.room_id;
      if (!atBottom) return undefined;
      const frame = requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end" });
      });
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [atBottom, finalLeadingNoticeCount, messages.length, room, virtuosoRef]);
  // Memoized, not a plain `.map()`, because `useCanRedactMap` uses this as
  // a `useMemo` dependency — a fresh array every render would defeat that
  // memoization entirely (Sentry review on #287, LOW).
  const senders = useMemo(() => messages.map((m) => m.sender), [messages]);
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
    setPendingAttachment(null);
    setPendingAttachmentCaption("");
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
  const messageActionController = useMessageActionController({
    roomId: activeRoomId,
    currentUserId,
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
  // regardless of prior scroll position — `followOutput="auto"` only follows
  // new content while Virtuoso already considers the viewport at bottom.
  // Skipped for edits: saving an edit to an old message shouldn't relocate
  // the view to it. Gated on `handleComposerSubmit`'s own success signal —
  // if the queueing call itself rejected (network/validation error) before
  // any local echo was created, there's no new message to scroll to.
  async function handleComposerSubmitAndScroll(
    content: Parameters<typeof handleComposerSubmit>[0],
  ) {
    const wasEditing = composerMode === "edit";
    const succeeded = await handleComposerSubmit(content);
    if (!wasEditing && succeeded) scrollToPresentAfterOwnSend();
  }
  // A slash command (e.g. `/me ...`, which sends an emote message the same
  // way a plain send does — see `src-tauri/src/matrix/commands.rs`) goes
  // through this separate path, not `onSubmit` — the same "scroll to the
  // user's own new message" gap applies here and was missed by the fix
  // above. Gated on both `parsed.command === "me"` *and* the command
  // actually succeeding: most slash commands (`/topic`, `/invite`, `/kick`,
  // `/ban`, ...) never append a `RoomMessageSummary` even on success, and a
  // failed `/me` (bad args, no permission) doesn't either — scrolling
  // unconditionally would yank the user to the bottom (and mark them
  // at-bottom/read) for a command that sent nothing.
  async function handleSlashCommandAndScroll(parsed: Parameters<typeof handleSlashCommand>[0]) {
    const succeeded = await handleSlashCommand(parsed);
    if (parsed.command === "me" && succeeded) scrollToPresentAfterOwnSend();
  }

  // Files stage for an optional caption when `media_send_polish` is on;
  // otherwise (or if the polish flag never lands for this build) they upload
  // immediately, matching pre-Spec-42 behavior.
  function stageOrSendAttachment(file: string | File) {
    if (!mediaSendPolishEnabled) {
      handleAttachFile(file);
      return;
    }
    const filename = typeof file === "string" ? (file.split(/[/\\]/).pop() ?? file) : file.name;
    setPendingAttachmentCaption("");
    setPendingAttachment({ file, filename, roomId: activeRoomId });
  }

  function handleConfirmPendingAttachment() {
    if (!pendingAttachment || pendingAttachment.roomId !== activeRoomId) {
      setPendingAttachment(null);
      setPendingAttachmentCaption("");
      return;
    }
    const caption = pendingAttachmentCaption.trim();
    handleAttachFile(pendingAttachment.file, caption.length > 0 ? caption : undefined);
    setPendingAttachment(null);
    setPendingAttachmentCaption("");
  }

  function handleCancelPendingAttachment() {
    setPendingAttachment(null);
    setPendingAttachmentCaption("");
  }

  async function handleAttachClick() {
    if (isWebBuild()) {
      attachmentInputRef.current?.click();
      return;
    }
    const selected = await openFileDialog({ multiple: false });
    if (typeof selected === "string") {
      stageOrSendAttachment(selected);
    }
  }

  function handleAttachmentInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) {
      stageOrSendAttachment(file);
    }
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (fileDragLeaveTimerRef.current !== null) {
      clearTimeout(fileDragLeaveTimerRef.current);
      fileDragLeaveTimerRef.current = null;
    }
    setFileDragActive(false);
    const files = Array.from(event.dataTransfer.files) as (File & { path?: string })[];
    const file = files[0];
    const upload = file ? attachmentUploadPayload(file) : null;
    if (upload) {
      stageOrSendAttachment(upload);
    }
  }

  function handleDragEnter(event: React.DragEvent<HTMLDivElement>) {
    if (!mediaSendPolishEnabled || !hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (fileDragLeaveTimerRef.current !== null) {
      clearTimeout(fileDragLeaveTimerRef.current);
      fileDragLeaveTimerRef.current = null;
    }
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;
    setFileDragActive(true);
  }

  function handleDragOver(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (hasDraggedFiles(event.dataTransfer)) event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: React.DragEvent<HTMLDivElement>) {
    if (!mediaSendPolishEnabled) return;
    event.preventDefault();
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;

    // A few webviews omit `relatedTarget` for child-to-child transitions. Delay
    // clearing by one task so the matching `dragenter` can cancel it without a
    // one-frame overlay flicker.
    if (fileDragLeaveTimerRef.current !== null) clearTimeout(fileDragLeaveTimerRef.current);
    fileDragLeaveTimerRef.current = setTimeout(() => {
      fileDragLeaveTimerRef.current = null;
      setFileDragActive(false);
    }, 0);
  }

  function handlePaste(event: React.ClipboardEvent<HTMLDivElement>) {
    const files = Array.from(event.clipboardData.files) as (File & { path?: string })[];
    const file = files.find((f) => f.type.startsWith("image/"));
    const upload = file ? attachmentUploadPayload(file) : null;
    if (upload) {
      event.preventDefault();
      stageOrSendAttachment(upload);
    }
  }

  return (
    <div
      data-testid="chat-shell"
      className="relative flex min-w-0 flex-1 flex-col"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {mediaSendPolishEnabled && fileDragActive && (
        <output
          aria-live="polite"
          className="pointer-events-none absolute inset-3 z-40 flex items-center justify-center rounded-xl border-2 border-dashed border-primary-solid bg-background/90 text-center shadow-lg backdrop-blur-sm"
        >
          <div className="flex flex-col items-center gap-2 px-6 text-foreground">
            <Paperclip className="size-8 text-primary" />
            <span className="text-base font-semibold">
              Drop files in {displayName(room.room_id, room.name)}
            </span>
            <span className="text-sm text-muted-foreground">Release to upload</span>
          </div>
        </output>
      )}
      <ChatHeader
        room={room}
        mobile={mobile}
        onBack={onBack}
        presence={headerPresence}
        membersDrawerOpen={membersDrawerOpen}
        onToggleMembers={() => {
          setMembersDrawerOpen((open) => !open);
          setPinnedMessagesDrawerOpen(false);
        }}
        messagePinningEnabled={messagePinningEnabled}
        pinnedMessagesDrawerOpen={pinnedMessagesDrawerOpen}
        pinnedMessageCount={pinnedEventIds.length}
        onTogglePinnedMessages={() => {
          setPinnedMessagesDrawerOpen((open) => !open);
          setMembersDrawerOpen(false);
        }}
        onOpenRoomSettings={() =>
          setRoomSettingsTarget({ roomId: room.room_id, section: "general" })
        }
      />

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
        {!loading && messages.length === 0 && !hasMore && !hasVisibleNotices && mobile && (
          <div className="flex flex-1 items-center justify-center px-6 text-center">
            <div className="flex max-w-xs flex-col items-center">
              <span className="mb-3 flex size-12 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                <MessageCircle className="size-6" aria-hidden="true" />
              </span>
              <p className="text-sm font-semibold text-foreground">No messages yet</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Send the first message to start the conversation.
              </p>
            </div>
          </div>
        )}
        {!loading && messages.length === 0 && !hasMore && !hasVisibleNotices && !mobile && (
          <p className="p-4 text-sm text-muted-foreground">No messages yet</p>
        )}
        {!loading && messages.length === 0 && hasVisibleNotices && (
          <div
            ref={noticeOnlyScrollerRef}
            className="flex-1 overflow-y-auto p-4"
            onScroll={(event) => {
              const scroller = event.currentTarget;
              const pinned =
                scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
              noticeOnlyPinnedRef.current = pinned;
              handleAtBottomStateChange(pinned);
            }}
          >
            <TimelineNoticeList notices={noticeBuckets.trailing} irc={messageLayout === "irc"} />
          </div>
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
            // `flex-1` (not just padding): the old scroller was itself the
            // `flex-1 overflow-y-auto` child of this `min-h-0 flex-1`
            // container. Without it, Virtuoso's root has no bounded height
            // to size its internal scroll area against — in a room with
            // enough messages to scroll, it grows to fit its own content
            // instead of owning the remaining chat pane, breaking viewport
            // measurement and potentially pushing the composer offscreen.
            className="flex-1 p-4"
            data={messages}
            firstItemIndex={firstItemIndex}
            initialTopMostItemIndex={messages.length - 1}
            alignToBottom
            followOutput="auto"
            startReached={loadMoreHistory}
            atBottomStateChange={handleVirtuosoAtBottomStateChange}
            context={{ loadingMore, hasMore }}
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
            // eslint-disable-next-line react/no-unstable-nested-components -- Virtuoso's row render prop intentionally closes over the active room/controller snapshot.
            itemContent={(index, message) => {
              const i = index - firstItemIndex;
              const readers = receiptsByEvent.get(message.event_id) ?? [];
              const before = noticeBuckets.beforeMessage.get(message.event_id) ?? [];
              const nextMessage = messages[i + 1];
              const hasNoticesBeforeNext =
                nextMessage !== undefined &&
                (noticeBuckets.beforeMessage.get(nextMessage.event_id)?.length ?? 0) > 0;
              const trailing = i === messages.length - 1 ? noticeBuckets.trailing : [];
              const previousMessageTimestamp = messages[i - 1]?.timestamp_ms ?? null;
              const previousTimelineTimestamp =
                before.at(-1)?.timestamp_ms ?? previousMessageTimestamp;

              return (
                <>
                  {before.length > 0 && (
                    <TimelineNoticeList
                      notices={before}
                      irc={messageLayout === "irc"}
                      previousTimestampMs={previousMessageTimestamp}
                    />
                  )}
                  <TimelineMessageRow
                    index={i}
                    messages={messages}
                    message={message}
                    roomId={room.room_id}
                    currentUserId={currentUserId}
                    unreadStartIndex={unreadStartIdx}
                    canRedact={canRedactBySender[message.sender] ?? false}
                    canPin={canPinMessages}
                    isPinned={pinnedEventIds.includes(message.event_id)}
                    readers={readers}
                    senderNameByUserId={senderNameByUserId}
                    newMessageKeys={newMessageKeys}
                    controller={messageActionController}
                    onJumpToMessage={handleJumpToMessage}
                    onSenderClick={
                      userProfileCardsEnabled
                        ? (userId, label) => openProfile(userId, label, "message-sender")
                        : undefined
                    }
                    onUserPillClick={(userId, label) => openProfile(userId, label, "mention")}
                    onRoomPillClick={onNavigateToRoom}
                    previousTimelineTimestampMs={previousTimelineTimestamp}
                    hasNoticesBefore={before.length > 0}
                    hasNoticesBeforeNext={hasNoticesBeforeNext}
                  />
                  {trailing.length > 0 && (
                    <TimelineNoticeList
                      notices={trailing}
                      irc={messageLayout === "irc"}
                      previousTimestampMs={message.timestamp_ms}
                    />
                  )}
                </>
              );
            }}
          />
        )}
        {/* "Jump to present" (Spec 26 Phase 2): shown while scrolled away
            from the live bottom with at least one new (non-own) message
            arrived since — never while already at bottom, the Charm 1.0
            #328 failure mode this migration is meant to avoid.
            Review fix: also shown whenever `hasFocusedView` is set,
            regardless of `newMessageCount` — a focused (`TimelineFocus::Event`)
            view from a Saved Messages jump never receives live updates, so
            `newMessageCount` would otherwise stay 0 forever after such a
            jump, leaving the user with no in-room way to reset back to
            live short of leaving and reopening the room. */}
        {(hasFocusedView || (!atBottom && newMessageCount > 0)) && (
          <button
            type="button"
            onClick={handleJumpToPresent}
            className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-primary-solid px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-md hover:opacity-90"
          >
            {newMessageCount > 0
              ? `${newMessageCount} new message${newMessageCount === 1 ? "" : "s"}`
              : "Jump to present"}
            <ChevronDown className="size-3.5" />
          </button>
        )}
      </div>

      <MessageActionDialogs
        target={messageActionController.visibleDialogTarget}
        onClose={messageActionController.closeDialog}
        onConfirm={messageActionController.confirmDialog}
      />

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

      {mediaSendPolishEnabled && visiblePendingAttachment && (
        <div className="flex flex-col gap-2 px-4 pb-2">
          <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-[13px]">
            <span className="truncate text-foreground">{visiblePendingAttachment.filename}</span>
            <input
              type="text"
              value={pendingAttachmentCaption}
              onChange={(e) => setPendingAttachmentCaption(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleConfirmPendingAttachment();
                } else if (e.key === "Escape") {
                  handleCancelPendingAttachment();
                }
              }}
              placeholder="Add a caption (optional)"
              aria-label="Attachment caption"
              className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-foreground outline-none focus:border-primary-solid"
            />
            <button
              type="button"
              aria-label="Send attachment"
              onClick={handleConfirmPendingAttachment}
              className="shrink-0 rounded bg-primary-solid px-2.5 py-1 text-primary-foreground hover:opacity-90"
            >
              Send
            </button>
            <button
              type="button"
              aria-label="Cancel attachment"
              onClick={handleCancelPendingAttachment}
              className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      <UploadTray
        uploads={uploads}
        onDismiss={dismissUpload}
        cancellationEnabled={mediaSendPolishEnabled}
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

      {mobile && participants.length > 0 && (
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
      <div
        data-testid="composer-shell"
        className={cn(
          "pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]",
          mobile ? "px-2" : "px-3",
        )}
      >
        <input
          ref={attachmentInputRef}
          type="file"
          className="hidden"
          onChange={handleAttachmentInputChange}
        />
        <div
          className={cn(
            "flex items-end border border-border bg-card",
            mobile ? "gap-1 rounded-2xl p-1" : "gap-2 rounded-lg p-2",
          )}
          onPaste={handlePaste}
        >
          <button
            aria-label="Attach"
            onClick={handleAttachClick}
            className={cn(
              "flex shrink-0 items-center justify-center text-muted-foreground hover:bg-accent disabled:cursor-not-allowed",
              mobile ? "size-11 rounded-full" : "size-9 rounded-md",
            )}
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
            placeholder={mobile ? "Message" : `Message ${displayName(room.room_id, room.name)}`}
            onSubmit={handleComposerSubmitAndScroll}
            onSlashCommand={handleSlashCommandAndScroll}
            onEscape={() => {
              if (editingEventId) setEditingEventId(null);
              else if (replyTarget) setReplyTarget(null);
            }}
            onTypingInput={handleTypingInput}
            onBlur={stopTyping}
            onEmptyChange={setIsComposerEmpty}
            showFormattingToolbar={!mobile || showMobileFormatting}
          />
          {mobile && (
            <button
              type="button"
              aria-label={showMobileFormatting ? "Hide formatting" : "Show formatting"}
              aria-pressed={showMobileFormatting}
              onClick={() => setShowMobileFormatting((visible) => !visible)}
              className={cn(
                "flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent",
                showMobileFormatting && "bg-accent text-accent-foreground",
              )}
            >
              <Type className="size-5" />
            </button>
          )}
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
            className={cn(
              "flex shrink-0 items-center justify-center bg-primary-solid text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50",
              mobile ? "size-11 rounded-full" : "size-9 rounded-md",
            )}
          >
            <Send size={16} />
          </button>
        </div>
      </div>
      {!mobile && participants.length > 0 && (
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
      <MessagePillProfileDialog
        profile={pillProfile}
        accountId={currentUserId}
        currentUserId={currentUserId}
        roomId={roomId}
        detailed={userProfileCardsEnabled}
        onNavigateToRoom={onNavigateToRoom}
        onClose={() => setPillProfile(null)}
      />
    </div>
  );
}
