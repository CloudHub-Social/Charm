import { useEffect, useRef, useState } from "react";
import {
  getTimelinePage,
  markRoomRead,
  onTimelineUpdate,
  type RoomMessageSummary,
  type RoomSummary,
} from "@/lib/matrix";
import { logAndIgnore } from "@/lib/logAndIgnore";

// `react-virtuoso`'s prepend recipe: `firstItemIndex` is the logical index of
// `messages[0]` in an unbounded conceptual list that grows *backwards* as
// older history loads. It starts arbitrarily high so it can be decremented by
// however many older messages a `loadMoreHistory` page prepends without ever
// going negative — Virtuoso uses the *decrease* in this value (applied in the
// same update as the longer `messages` array) to keep the previously-visible
// rows exactly where they were, replacing Phase 1's manual
// `scrollHeight`/`scrollTop` delta math entirely.
const INITIAL_FIRST_ITEM_INDEX = 1_000_000_000;

export function useChatTimeline(room: RoomSummary | null, roomSettingsOpen: boolean) {
  const [messages, setMessages] = useState<RoomMessageSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [firstItemIndex, setFirstItemIndex] = useState(INITIAL_FIRST_ITEM_INDEX);
  const lastMarkedReadRoomId = useRef<string | null>(null);
  const lastMarkedReadEventId = useRef<string | null>(null);
  // Mirrors Virtuoso's own `atBottomStateChange` callback — the single
  // source of truth for "is the user currently at the live bottom of the
  // timeline" now that there's no permanently-mounted bottom sentinel to
  // drive a separate `IntersectionObserver` (see Spec 26 Phase 2's Open
  // Question on Spec 05's mark-as-read: Virtuoso's own bottom-visibility
  // signal answers it directly, so mark-as-read and sticky-bottom share one
  // boolean instead of needing two mechanisms).
  const isAtBottomRef = useRef(true);
  // Tracks which room `loadMoreHistory`'s in-flight request was issued for,
  // so a slow response landing after the user has since switched rooms (or
  // this room's own subsequent request) doesn't apply its scroll anchor or
  // messages to the wrong room — same reasoning as `ChatShell`'s
  // `requestedRoomIdRef` for `canRedact`.
  const currentRoomIdRef = useRef<string | null>(null);
  // A plain room-id comparison isn't enough to catch a *revisit* to the same
  // room: if the user leaves room A mid-`loadMoreHistory`, then returns to A
  // before that request resolves, `currentRoomIdRef.current` reads "A" again
  // even though the revisit's own fresh initial load has since run. This
  // counter increments on every "a room became active" transition (below),
  // including same-id revisits, so `loadMoreHistory` can tell its own
  // request apart from a later, unrelated one for the same room id.
  const visitGenerationRef = useRef(0);
  // `TimelinePage.next_cursor` sentinel from the most recent page fetched
  // for this room: `null` once the room's history start has been reached
  // (see `TimelinePage`'s doc comment), so `loadMoreHistory` becomes a no-op.
  const nextCursorRef = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);

  useEffect(() => {
    // Keyed on the room id, not the `room` object itself: `RoomsScreen` hands
    // this a fresh `room` reference on every `room_list:update`, and
    // `Timeline::paginate_backwards`'s pagination is now stateful per-room
    // (Spec 14), so re-running this on every such refresh would silently
    // walk further back into history each time instead of just loading the
    // room once.
    const timelineRoomId = room?.room_id;
    visitGenerationRef.current += 1;
    // A new room always opens scrolled to bottom, regardless of whether the
    // previously active room was scrolled up reading history.
    isAtBottomRef.current = true;
    currentRoomIdRef.current = timelineRoomId ?? null;
    nextCursorRef.current = null;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setFirstItemIndex(INITIAL_FIRST_ITEM_INDEX);
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
      //
      // Live arrival only ever appends to `messages`' tail — the oldest
      // loaded message (`messages[0]`) doesn't change from a live update, so
      // `firstItemIndex` doesn't need adjusting here (only `loadMoreHistory`
      // prepending older history moves it).
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

  // Marks the room read once the true bottom of the timeline is visible —
  // driven by Virtuoso's own `atBottomStateChange` (see
  // `handleAtBottomStateChange` below) instead of a permanently-mounted
  // bottom-sentinel `IntersectionObserver`, since a virtualized list's last
  // row is no longer always a mounted DOM node to observe.
  function markReadIfAtBottom() {
    if (!room || !latestEventId) return;
    if (roomSettingsOpen) return;
    if (!isAtBottomRef.current) return;
    if (lastMarkedReadEventId.current === latestEventId) return;
    lastMarkedReadEventId.current = latestEventId;
    markRoomRead(room.room_id).catch(logAndIgnore);
  }
  // Re-check on every message/room-settings change too: `roomSettingsOpen`
  // closing while already at bottom, or a new latest message arriving while
  // already at bottom, must mark read without needing a fresh
  // `atBottomStateChange` firing (Virtuoso only calls it on an actual
  // visibility transition).
  useEffect(() => {
    markReadIfAtBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `markReadIfAtBottom` closes over refs, not state.
  }, [room, latestEventId, roomSettingsOpen]);

  function handleAtBottomStateChange(atBottom: boolean) {
    isAtBottomRef.current = atBottom;
    if (atBottom) markReadIfAtBottom();
  }

  // Loads one more page of older history and prepends it. Virtuoso's own
  // `firstItemIndex` prepend recipe (see the constant's doc comment above)
  // keeps whatever was already visible visually still, replacing Phase 1's
  // `pendingAnchorRef`/manual `scrollHeight` delta math entirely. A no-op if
  // a request is already in flight or the room's history start has already
  // been reached.
  async function loadMoreHistory() {
    const roomId = currentRoomIdRef.current;
    if (!roomId || loadingMoreRef.current || !nextCursorRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const generation = visitGenerationRef.current;
    const previousLength = messages.length;
    try {
      const page = await getTimelinePage(roomId);
      // Stale if the room has changed since this request was issued —
      // including a revisit to the same room id, which `visitGenerationRef`
      // (unlike a plain `currentRoomIdRef` comparison) still distinguishes.
      // Don't apply this response's messages or index shift in that case.
      if (visitGenerationRef.current !== generation) return;
      nextCursorRef.current = page.next_cursor;
      const prepended = page.messages.length - previousLength;
      if (prepended > 0) {
        setFirstItemIndex((current) => current - prepended);
      }
      setMessages(page.messages);
    } catch (err) {
      logAndIgnore(err);
    } finally {
      if (visitGenerationRef.current === generation) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }

  return {
    messages,
    loading,
    loadingMore,
    firstItemIndex,
    loadMoreHistory,
    handleAtBottomStateChange,
  };
}
