import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import { loadTimelineAroundEvent, type RoomMessageSummary, type RoomSummary } from "@/lib/matrix";
import { logAndIgnore } from "@/lib/logAndIgnore";
import { messageRowKey } from "./messageRowShared";
import { unreadDividerIndex } from "./timelineDividers";

// How long a successful load-around request gets to emit its timeline update
// before the jump is released without scrolling.
const JUMP_FALLBACK_TIMEOUT_MS = 5000;
const JUMP_HIGHLIGHT_MS = 1800;

interface UseTimelineViewportArgs {
  room: RoomSummary | null;
  currentUserId: string;
  messages: RoomMessageSummary[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  paginationError: boolean;
  prependedCount: number;
  awaitingEmptyPagePagination: boolean;
  jumpToEventId: string | null;
  jumpToTimestampMs: number | null;
  onJumpHandled?: () => void;
  handleAtBottomStateChange: (bottom: boolean) => void;
  resetToLive: () => Promise<boolean>;
}

/**
 * Owns the timeline viewport state machine independently from ChatShell's
 * message actions and composer wiring.
 *
 * This keeps Virtuoso positioning, Saved Messages focus recovery, fresh-row
 * detection, the jump-to-present counter, and the frozen unread boundary in
 * one place because they share the same room/load transition guards.
 */
export function useTimelineViewport({
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
  jumpToTimestampMs,
  onJumpHandled,
  handleAtBottomStateChange,
  resetToLive,
}: UseTimelineViewportArgs) {
  const activeRoomId = room?.room_id ?? null;
  const roomId = room?.room_id ?? "";
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(atBottom);
  atBottomRef.current = atBottom;
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [hasFocusedView, setHasFocusedView] = useState(false);
  const [highlightedEventId, setHighlightedEventId] = useState<string | null>(null);
  const [resolvedDateRequestKey, setResolvedDateRequestKey] = useState<string | null>(null);
  const latestMessagesRef = useRef(messages);
  latestMessagesRef.current = messages;
  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mightHaveFocusedViewRef = useRef(false);

  function handleVirtuosoAtBottomStateChange(bottom: boolean) {
    handleAtBottomStateChange(bottom);
    setAtBottom(bottom);
    if (bottom) setNewMessageCount(0);
  }

  function handleJumpToPresent() {
    // A load-around fallback can replace the room's live timeline with a
    // focused one. Keep the recovery affordance until resetToLive succeeds.
    if (mightHaveFocusedViewRef.current) {
      resetToLive()
        .then((succeeded) => {
          if (succeeded) {
            mightHaveFocusedViewRef.current = false;
            setHasFocusedView(false);
          }
        })
        .catch(logAndIgnore);
    } else {
      setHasFocusedView(false);
    }
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end" });
    handleVirtuosoAtBottomStateChange(true);
  }

  const pendingScrollTargetRef = useRef<{ roomId: string; eventId: string } | null>(null);
  function handleJumpToMessage(eventId: string) {
    const index = messages.findIndex((message) => message.event_id === eventId);
    // A target can arrive before Virtuoso mounts. Only that mount race is
    // retried; a missing target in an already-mounted window stays a no-op.
    if (!virtuosoRef.current) {
      if (roomId) pendingScrollTargetRef.current = { roomId, eventId };
      return;
    }
    pendingScrollTargetRef.current = null;
    if (index < 0) return;
    setHighlightedEventId(eventId);
    if (highlightTimeoutRef.current !== null) clearTimeout(highlightTimeoutRef.current);
    highlightTimeoutRef.current = setTimeout(() => {
      highlightTimeoutRef.current = null;
      setHighlightedEventId(null);
    }, JUMP_HIGHLIGHT_MS);
    virtuosoRef.current.scrollToIndex({
      index,
      align: "center",
      behavior: "smooth",
    });
  }

  useLayoutEffect(() => {
    const pending = pendingScrollTargetRef.current;
    if (pending === null || pending.roomId !== roomId || loading) return;
    handleJumpToMessage(pending.eventId);
    // The retry is driven only by the load commits that can mount Virtuoso.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, loading]);

  useEffect(() => {
    pendingScrollTargetRef.current = null;
    setHighlightedEventId(null);
    if (highlightTimeoutRef.current !== null) {
      clearTimeout(highlightTimeoutRef.current);
      highlightTimeoutRef.current = null;
    }
  }, [roomId]);

  // Reset before paint so a room never inherits another room's pill or
  // focused-view recovery state.
  const previousActiveRoomIdRef = useRef(activeRoomId);
  if (previousActiveRoomIdRef.current !== activeRoomId) {
    previousActiveRoomIdRef.current = activeRoomId;
    setAtBottom(true);
    setNewMessageCount(0);
    mightHaveFocusedViewRef.current = false;
    setHasFocusedView(false);
  }

  const seenRowKeysRef = useRef<Set<string>>(new Set());
  // A local echo changes row key when its event id arrives; its timestamp is
  // the stable secondary identity used to avoid counting the ack as new.
  const seenOwnTimestampsRef = useRef<Set<number>>(new Set());
  const seededRoomIdRef = useRef<string | null>(null);
  const hasStartedLoadingRoomIdRef = useRef<string | null>(null);
  if (loading) hasStartedLoadingRoomIdRef.current = activeRoomId;
  if (activeRoomId === null) {
    seededRoomIdRef.current = null;
    hasStartedLoadingRoomIdRef.current = null;
  }

  const loadRequestedForRef = useRef<string | null>(null);
  // The focused update can arrive before the IPC result. Preserve that
  // request long enough to apply installed_focused_view from the result.
  const handledAwaitingFocusedViewRef = useRef<string | null>(null);
  const dateAwaitingTimelineRef = useRef<{
    requestKey: string;
    messages: RoomMessageSummary[];
  } | null>(null);
  const jumpFallbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousJumpRoomIdRef = useRef(room?.room_id ?? null);
  if (previousJumpRoomIdRef.current !== (room?.room_id ?? null)) {
    previousJumpRoomIdRef.current = room?.room_id ?? null;
    loadRequestedForRef.current = null;
    handledAwaitingFocusedViewRef.current = null;
    dateAwaitingTimelineRef.current = null;
    setResolvedDateRequestKey(null);
    if (jumpFallbackTimeoutRef.current !== null) {
      clearTimeout(jumpFallbackTimeoutRef.current);
      jumpFallbackTimeoutRef.current = null;
    }
  }

  useEffect(() => {
    if (!jumpToEventId || !room) return;
    const requestKey = `${room.room_id}:${jumpToEventId}:${jumpToTimestampMs ?? "event"}`;
    const awaitingDateTimeline = dateAwaitingTimelineRef.current;
    if (
      jumpToTimestampMs !== null &&
      awaitingDateTimeline?.requestKey === requestKey &&
      messages !== awaitingDateTimeline.messages
    ) {
      dateAwaitingTimelineRef.current = null;
      setResolvedDateRequestKey(requestKey);
      return;
    }
    const visibleTarget =
      jumpToTimestampMs === null
        ? messages.find((message) => message.event_id === jumpToEventId)
        : messages.find((message) => message.timestamp_ms >= jumpToTimestampMs);
    const canHandleVisibleTarget =
      visibleTarget !== undefined &&
      (jumpToTimestampMs === null || resolvedDateRequestKey === requestKey);
    if (canHandleVisibleTarget) {
      // Prop-driven jumps (bookmarks, pins, search, and date navigation) get
      // an explicit return-to-live affordance even when the target was
      // already loaded and no focused server timeline had to be installed.
      setHasFocusedView(true);
      handleJumpToMessage(visibleTarget.event_id);
      if (loadRequestedForRef.current === requestKey) {
        handledAwaitingFocusedViewRef.current = requestKey;
      }
      loadRequestedForRef.current = null;
      setResolvedDateRequestKey(null);
      if (jumpFallbackTimeoutRef.current !== null) {
        clearTimeout(jumpFallbackTimeoutRef.current);
        jumpFallbackTimeoutRef.current = null;
      }
      onJumpHandled?.();
      return;
    }

    // useChatTimeline starts with loading=false before its first fetch effect,
    // so require proof that this room has actually entered the loading state.
    const initialLoadSettled = !loading && hasStartedLoadingRoomIdRef.current === activeRoomId;
    if (!initialLoadSettled || loadRequestedForRef.current === requestKey) return;
    loadRequestedForRef.current = requestKey;
    const messagesAtRequestStart = messages;
    loadTimelineAroundEvent(room.room_id, jumpToEventId)
      .then(({ found, installed_focused_view }) => {
        if (handledAwaitingFocusedViewRef.current === requestKey) {
          handledAwaitingFocusedViewRef.current = null;
          if (installed_focused_view) {
            mightHaveFocusedViewRef.current = true;
            setHasFocusedView(true);
          }
          return;
        }
        if (loadRequestedForRef.current !== requestKey) return;
        if (installed_focused_view) {
          mightHaveFocusedViewRef.current = true;
          setHasFocusedView(true);
        }
        if (!found) {
          loadRequestedForRef.current = null;
          setResolvedDateRequestKey(null);
          onJumpHandled?.();
          return;
        }
        if (jumpToTimestampMs !== null) {
          const latestMessages = latestMessagesRef.current;
          const focusedContextAlreadyCommitted =
            latestMessages !== messagesAtRequestStart &&
            (latestMessages.some((message) => message.event_id === jumpToEventId) ||
              latestMessages.some((message) => message.timestamp_ms < jumpToTimestampMs));
          if (!installed_focused_view || focusedContextAlreadyCommitted) {
            setResolvedDateRequestKey(requestKey);
          } else {
            dateAwaitingTimelineRef.current = {
              requestKey,
              messages: latestMessages,
            };
          }
          if (jumpFallbackTimeoutRef.current !== null) {
            clearTimeout(jumpFallbackTimeoutRef.current);
          }
          jumpFallbackTimeoutRef.current = setTimeout(() => {
            jumpFallbackTimeoutRef.current = null;
            if (loadRequestedForRef.current === requestKey) {
              loadRequestedForRef.current = null;
              setResolvedDateRequestKey(null);
              onJumpHandled?.();
            }
          }, JUMP_FALLBACK_TIMEOUT_MS);
          return;
        }
        // A focused server view is delivered by the timeline listener after
        // this IPC response. Do not resolve a timestamp against the captured
        // live-tail messages while that replacement is still in flight.
        if (installed_focused_view) {
          if (jumpFallbackTimeoutRef.current !== null) {
            clearTimeout(jumpFallbackTimeoutRef.current);
          }
          jumpFallbackTimeoutRef.current = setTimeout(() => {
            jumpFallbackTimeoutRef.current = null;
            if (loadRequestedForRef.current === requestKey) {
              loadRequestedForRef.current = null;
              onJumpHandled?.();
            }
          }, JUMP_FALLBACK_TIMEOUT_MS);
          return;
        }
        const currentVisibleTarget =
          jumpToTimestampMs === null
            ? messages.find((message) => message.event_id === jumpToEventId)
            : messages.find((message) => message.timestamp_ms >= jumpToTimestampMs);
        if (currentVisibleTarget) {
          setHasFocusedView(true);
          loadRequestedForRef.current = null;
          handleJumpToMessage(currentVisibleTarget.event_id);
          onJumpHandled?.();
          return;
        }
        if (jumpFallbackTimeoutRef.current !== null) {
          clearTimeout(jumpFallbackTimeoutRef.current);
        }
        jumpFallbackTimeoutRef.current = setTimeout(() => {
          jumpFallbackTimeoutRef.current = null;
          if (loadRequestedForRef.current === requestKey) {
            loadRequestedForRef.current = null;
            onJumpHandled?.();
          }
        }, JUMP_FALLBACK_TIMEOUT_MS);
      })
      .catch((error) => {
        if (loadRequestedForRef.current === requestKey) {
          loadRequestedForRef.current = null;
          onJumpHandled?.();
        }
        logAndIgnore(error);
      });
    // The request is intentionally keyed to committed timeline/load changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    jumpToEventId,
    jumpToTimestampMs,
    room?.room_id,
    messages,
    loading,
    activeRoomId,
    resolvedDateRequestKey,
  ]);

  useEffect(() => {
    return () => {
      if (jumpFallbackTimeoutRef.current !== null) {
        clearTimeout(jumpFallbackTimeoutRef.current);
        jumpFallbackTimeoutRef.current = null;
      }
      if (highlightTimeoutRef.current !== null) {
        clearTimeout(highlightTimeoutRef.current);
        highlightTimeoutRef.current = null;
      }
    };
  }, []);

  const newMessageKeys = useMemo(() => {
    const readyToSeed =
      !loading &&
      hasStartedLoadingRoomIdRef.current === activeRoomId &&
      !awaitingEmptyPagePagination;
    if (!readyToSeed || seededRoomIdRef.current !== activeRoomId) return new Set<string>();
    const fresh = new Set<string>();
    messages.forEach((message, index) => {
      if (index < prependedCount) return;
      const key = messageRowKey(message);
      if (seenRowKeysRef.current.has(key)) return;
      if (
        message.sender === currentUserId &&
        seenOwnTimestampsRef.current.has(message.timestamp_ms)
      ) {
        return;
      }
      fresh.add(key);
    });
    return fresh;
    // Keep this paired with the effect below: both run once per timeline
    // commit, not for incidental ChatShell renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, loading, loadingMore, activeRoomId, prependedCount, hasMore, paginationError]);

  useEffect(() => {
    const readyToSeed =
      !loading &&
      hasStartedLoadingRoomIdRef.current === activeRoomId &&
      !awaitingEmptyPagePagination;
    if (!readyToSeed) return;
    if (seededRoomIdRef.current !== activeRoomId) {
      seededRoomIdRef.current = activeRoomId;
      seenRowKeysRef.current = new Set(messages.map(messageRowKey));
      seenOwnTimestampsRef.current = new Set(
        messages
          .filter((message) => message.sender === currentUserId)
          .map((message) => message.timestamp_ms),
      );
      return;
    }
    if (!atBottomRef.current && newMessageKeys.size > 0) {
      setNewMessageCount((count) => count + newMessageKeys.size);
    }
    messages.forEach((message) => {
      seenRowKeysRef.current.add(messageRowKey(message));
      if (message.sender === currentUserId) {
        seenOwnTimestampsRef.current.add(message.timestamp_ms);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, loading, loadingMore, activeRoomId, prependedCount, hasMore, paginationError]);

  // Freeze the unread boundary by identity so room-list read reconciliation,
  // appends, and backward pagination cannot move or remove it mid-visit.
  const unreadBoundaryKeyRef = useRef<string | null>(null);
  const seededUnreadRoomIdRef = useRef<string | null>(null);
  if (
    !loading &&
    hasStartedLoadingRoomIdRef.current === activeRoomId &&
    !awaitingEmptyPagePagination &&
    seededUnreadRoomIdRef.current !== activeRoomId
  ) {
    seededUnreadRoomIdRef.current = activeRoomId;
    const boundaryIndex = unreadDividerIndex(messages.length, room?.unread_messages ?? 0);
    const boundaryMessage = boundaryIndex >= 0 ? messages[boundaryIndex] : undefined;
    unreadBoundaryKeyRef.current = boundaryMessage ? messageRowKey(boundaryMessage) : null;
  }
  const unreadStartIdx = unreadBoundaryKeyRef.current
    ? messages.findIndex((message) => messageRowKey(message) === unreadBoundaryKeyRef.current)
    : -1;

  function scrollToPresentAfterOwnSend() {
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end" });
    handleVirtuosoAtBottomStateChange(true);
  }

  return {
    virtuosoRef,
    atBottom,
    newMessageCount,
    hasFocusedView,
    highlightedEventId,
    newMessageKeys,
    unreadStartIdx,
    handleVirtuosoAtBottomStateChange,
    handleJumpToPresent,
    handleJumpToMessage,
    scrollToPresentAfterOwnSend,
  };
}
