import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  getTimelinePage,
  markRoomRead,
  onTimelineUpdate,
  type RoomMessageSummary,
  type RoomSummary,
} from "@/lib/matrix";
import { logAndIgnore } from "@/lib/logAndIgnore";

export function useChatTimeline(room: RoomSummary | null, roomSettingsOpen: boolean) {
  const [messages, setMessages] = useState<RoomMessageSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const lastMarkedReadRoomId = useRef<string | null>(null);
  const lastMarkedReadEventId = useRef<string | null>(null);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
  // The scrollable message-list element itself — needed (not just the
  // sentinels) so backward-pagination can read/adjust `scrollTop` directly.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  // Whether the bottom sentinel was intersecting (i.e. the user was scrolled
  // to the bottom) the last time the IntersectionObserver below fired.
  // Defaults to true so the very first render (before any observation has
  // happened yet) still scrolls to bottom once the initial page loads.
  const isAtBottomRef = useRef(true);
  // Tracks which room `loadMoreHistory`'s in-flight request was issued for,
  // so a slow response landing after the user has since switched rooms (or
  // this room's own subsequent request) doesn't apply its scroll anchor or
  // messages to the wrong room — same reasoning as `ChatShell`'s
  // `requestedRoomIdRef` for `canRedact`.
  const currentRoomIdRef = useRef<string | null>(null);
  // `TimelinePage.next_cursor` sentinel from the most recent page fetched
  // for this room: `null` once the room's history start has been reached
  // (see `TimelinePage`'s doc comment), so `loadMoreHistory` becomes a no-op.
  const nextCursorRef = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);
  // Set by `loadMoreHistory` right before its response is applied to
  // `messages`, so the layout effect below can keep whatever was already
  // visible visually still once older messages are prepended above it
  // (Spec 26 Phase 1's backward-pagination scroll anchor).
  const pendingAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);

  useEffect(() => {
    // Keyed on the room id, not the `room` object itself: `RoomsScreen` hands
    // this a fresh `room` reference on every `room_list:update`, and
    // `Timeline::paginate_backwards`'s pagination is now stateful per-room
    // (Spec 14), so re-running this on every such refresh would silently
    // walk further back into history each time instead of just loading the
    // room once.
    const timelineRoomId = room?.room_id;
    // A new room always opens scrolled to bottom, regardless of whether the
    // previously active room was scrolled up reading history.
    isAtBottomRef.current = true;
    currentRoomIdRef.current = timelineRoomId ?? null;
    nextCursorRef.current = null;
    pendingAnchorRef.current = null;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    if (!timelineRoomId) {
      setMessages([]);
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    let cancelled = false;
    // `page.messages` now comes from `matrix-sdk-ui`'s `Timeline` (Spec 14),
    // which holds items in their natural oldest-to-newest order — unlike the
    // old `room.messages()` backward-pagination page, which was newest-first
    // and needed reversing.
    getTimelinePage(timelineRoomId)
      .then((page) => {
        if (cancelled) return;
        setMessages(page.messages);
        nextCursorRef.current = page.next_cursor;
      })
      .catch(logAndIgnore)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [room?.room_id]);

  useEffect(() => {
    const timelineRoomId = room?.room_id;
    if (!timelineRoomId) return undefined;
    const unlisten = onTimelineUpdate((update) => {
      if (update.room_id !== timelineRoomId) return;
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
      unlisten.then((fn) => fn()).catch(logAndIgnore);
    };
  }, [room?.room_id]);

  const latestEventId = messages.length > 0 ? messages[messages.length - 1].event_id : null;

  useEffect(() => {
    lastMarkedReadEventId.current = null;
  }, [room?.room_id]);

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
    markRoomRead(room.room_id).catch(logAndIgnore);
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
        isAtBottomRef.current = isVisible;
        if (!isVisible) return;
        if (lastMarkedReadEventId.current === latestEventId) return;
        lastMarkedReadEventId.current = latestEventId;
        markRoomRead(room.room_id).catch(logAndIgnore);
      },
      { threshold: 1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [room, latestEventId, roomSettingsOpen]);

  // Scroll-to-bottom on initial load, and "sticky bottom" on live message
  // arrival: whenever `messages` changes, jump to the newest message only if
  // the sentinel's last known intersection state (tracked by the observer
  // above) said the user was already at the bottom — never yank the view
  // down while they've scrolled up to read history (see Spec 26, and Charm
  // 1.0 issue #328 for the regression this guards against). `useLayoutEffect`
  // rather than `useEffect` so the jump happens before paint, avoiding a
  // visible flash of the pre-scroll position.
  useLayoutEffect(() => {
    if (!isAtBottomRef.current) return;
    // jsdom (unit tests) doesn't implement `scrollIntoView` at all.
    bottomSentinelRef.current?.scrollIntoView?.({ block: "end" });
  }, [messages]);

  // Backward-pagination scroll anchor (Spec 26 Phase 1 item 4): loads one
  // more page of older history and keeps whatever was already visible
  // visually still, rather than the load silently jumping the view (the
  // load-more-history counterpart to the media-reservation reflow problem
  // in `MediaMessage.tsx`). A no-op if a request is already in flight or the
  // room's history start has already been reached.
  async function loadMoreHistory() {
    const roomId = currentRoomIdRef.current;
    if (!roomId || loadingMoreRef.current || !nextCursorRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await getTimelinePage(roomId);
      // The user may have switched rooms (or this room issued a newer
      // request) while this one was in flight — don't apply a stale
      // response's messages or scroll anchor.
      if (currentRoomIdRef.current !== roomId) return;
      const container = containerRef.current;
      pendingAnchorRef.current = container
        ? { scrollHeight: container.scrollHeight, scrollTop: container.scrollTop }
        : null;
      nextCursorRef.current = page.next_cursor;
      setMessages(page.messages);
    } catch (err) {
      logAndIgnore(err);
    } finally {
      if (currentRoomIdRef.current === roomId) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }

  // Triggers `loadMoreHistory` once the top sentinel scrolls into view, i.e.
  // the user has scrolled close to the oldest currently-loaded message.
  // Re-created whenever `messages` changes so a just-prepended page's new
  // (now-higher-up) sentinel position is re-evaluated immediately — this is
  // what makes an early scroll-up load enough history to fill the viewport,
  // and it self-terminates once `nextCursorRef` goes `null`.
  useEffect(() => {
    if (!room) return undefined;
    const sentinel = topSentinelRef.current;
    if (!sentinel) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          loadMoreHistory();
        }
      },
      { rootMargin: "200px 0px 0px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `loadMoreHistory` closes over refs, not state; re-created per render is unnecessary to depend on.
  }, [room?.room_id, messages]);

  // Restores the scroll position `loadMoreHistory` recorded right before
  // prepending older messages, so the content the user was already reading
  // doesn't visually jump once the taller list renders above it. Runs for
  // every `messages` change but is a no-op unless a backward-pagination
  // response is what triggered this one (`pendingAnchorRef` is only set
  // there).
  useLayoutEffect(() => {
    const anchor = pendingAnchorRef.current;
    if (!anchor) return;
    pendingAnchorRef.current = null;
    const container = containerRef.current;
    if (!container) return;
    const delta = container.scrollHeight - anchor.scrollHeight;
    container.scrollTop = anchor.scrollTop + delta;
  }, [messages]);

  return {
    messages,
    loading,
    loadingMore,
    bottomSentinelRef,
    topSentinelRef,
    containerRef,
  };
}
