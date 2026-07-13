import { useEffect, useRef, useState } from "react";
import {
  getTimelinePage,
  markRoomRead,
  onTimelineUpdate,
  type RoomMessageSummary,
  type RoomSummary,
} from "@/lib/matrix";
import { logAndIgnore } from "@/lib/logAndIgnore";
import { messageRowKey } from "./messageRowShared";

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
  // Mirrors `nextCursorRef.current !== null` as reactive state — `ChatShell`
  // needs this to auto-trigger `loadMoreHistory` when the newest page comes
  // back with zero *renderable* messages (some Matrix timeline items —
  // state events, polls, etc. — are filtered out of `RoomMessageSummary`
  // entirely) but more history to page back through: with `messages` empty,
  // Virtuoso never mounts at all, so there's no `startReached` sentinel to
  // trigger that load the normal way.
  const [hasMore, setHasMore] = useState(false);
  // Set when `loadMoreHistory`'s request itself fails (network/backend
  // error) — distinct from a request that *succeeds* but happens to add no
  // renderable rows (see `loadMoreHistory`'s own continuation logic for
  // that case). `ChatShell`'s empty-first-page auto-pagination effect must
  // stop retrying once this is true, or a persistent backend error would
  // otherwise loop that effect forever (same dependencies re-trigger it
  // every time `loadingMore` flips back to `false`). Cleared on room switch
  // and on any subsequent successful page.
  const [paginationError, setPaginationError] = useState(false);
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
  // The full previous `messages` array, so `applyMessages` below can locate
  // *any* still-surviving message from the old front of the list — not just
  // check whether the exact old first message is still first — and compute
  // exactly how `firstItemIndex` needs to move to keep it at the same
  // logical position. A plain "is the old first message still first"
  // check breaks if that specific message disappears from a later full
  // snapshot entirely (e.g. an `UnableToDecrypt` placeholder at the front
  // resolves into a msgtype `timeline_item_to_summary` filters out): the
  // next surviving row's logical index would silently be treated as
  // unchanged instead of shifting to compensate for the removal.
  const previousMessagesRef = useRef<RoomMessageSummary[]>([]);

  // Applies a fresh full message snapshot (from either the initial/backward-
  // pagination `getTimelinePage` response or a live `timeline:update`),
  // shifting `firstItemIndex` to keep whichever previously-loaded message
  // survives closest to the front at the same logical position — identified
  // by position, not a length diff (which misattributes any concurrently-
  // appended live messages as more prepended history; see
  // `loadMoreHistory`'s own comment below for the race this guards against).
  //
  // Returns the number of messages genuinely prepended ahead of that
  // surviving message (0 if none were, including the "the old front message
  // itself disappeared" case, which moves `firstItemIndex` the *other*
  // direction instead), so callers (`loadMoreHistory`) can tell "this page
  // genuinely added renderable history" from "this page's underlying
  // timeline items were all filtered out of `RoomMessageSummary` (state
  // events, polls, etc.), so nothing actually changed" — the two look
  // identical from `next_cursor` alone.
  function applyMessages(newMessages: RoomMessageSummary[]): number {
    const previous = previousMessagesRef.current;
    let prepended = 0;
    if (previous.length > 0 && newMessages.length > 0) {
      const newKeys = new Map(newMessages.map((m, i) => [messageRowKey(m), i]));
      for (let oldIndex = 0; oldIndex < previous.length; oldIndex++) {
        const newIndex = newKeys.get(messageRowKey(previous[oldIndex]));
        if (newIndex === undefined) continue;
        // This message's logical index must stay the same: it was
        // `firstItemIndex + oldIndex` before, so the new `firstItemIndex`
        // must satisfy `firstItemIndex' + newIndex === firstItemIndex +
        // oldIndex` — i.e. shift by `oldIndex - newIndex`. Positive when
        // messages ahead of it (including possibly itself, if `oldIndex`
        // was 0) were removed; negative when older history was prepended
        // ahead of it.
        const shift = oldIndex - newIndex;
        if (shift !== 0) setFirstItemIndex((current) => current + shift);
        prepended = shift < 0 ? -shift : 0;
        break;
      }
      // If no previously-loaded message survives anywhere in the new
      // snapshot at all (extremely unlikely — the entire loaded window
      // would have to have been replaced), there's no reliable anchor to
      // shift from; leave `firstItemIndex` as-is rather than guess.
    }
    previousMessagesRef.current = newMessages;
    setMessages(newMessages);
    return prepended;
  }

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
    setHasMore(false);
    setPaginationError(false);
    setFirstItemIndex(INITIAL_FIRST_ITEM_INDEX);
    // A fresh room's first snapshot is never "prepended history" relative to
    // anything — reset so `applyMessages`' first call for this room doesn't
    // compare against the *previous* room's last-known messages.
    previousMessagesRef.current = [];
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
        applyMessages(page.messages);
        nextCursorRef.current = page.next_cursor;
        setHasMore(page.next_cursor !== null);
      })
      .catch(logAndIgnore)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `applyMessages` closes over refs/setState, not state that should re-run this effect.
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
      // Live arrival *usually* only appends to `messages`' tail, but the
      // backend can also emit a `timeline:update` carrying the same
      // prepended-history diff a concurrent `loadMoreHistory` request is
      // still awaiting its own response for — `applyMessages` (not a plain
      // `setMessages`) detects that via identity, not just an appended tail,
      // and shifts `firstItemIndex` if so, without double-shifting once
      // `loadMoreHistory`'s own response lands afterward for the same change.
      applyMessages(update.messages);
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

  // Loads one more page of older history and prepends it. `applyMessages`
  // (see above) shifts `firstItemIndex` by however many messages actually
  // ended up prepended ahead of the previously-first-loaded message —
  // identified by position, not a length diff — which keeps whatever was
  // already visible visually still, replacing Phase 1's
  // `pendingAnchorRef`/manual `scrollHeight` delta math entirely. A no-op if
  // a request is already in flight or the room's history start has already
  // been reached.
  async function loadMoreHistory() {
    const roomId = currentRoomIdRef.current;
    if (!roomId || loadingMoreRef.current || !nextCursorRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const generation = visitGenerationRef.current;
    // A single backend page can legitimately contribute zero renderable
    // `RoomMessageSummary` rows (its underlying timeline items were all
    // state events/polls/etc. `timeline_item_to_summary` filters out) while
    // still advancing `next_cursor`, so this loops internally until a page
    // actually adds a row or history is confirmed exhausted — relying on the
    // caller to notice and re-request wouldn't work for `ChatShell`'s
    // Virtuoso `startReached`, which is deduped by rendered range and won't
    // refire on its own while an all-filtered-out response leaves that range
    // unchanged.
    //
    // Progress is judged by comparing the *whole loop's* starting front
    // message against the current one after each response, not
    // `applyMessages`' own per-call return value and not a plain
    // `messages.length` diff:
    // - A length diff breaks if a live tail message races this request:
    //   the total grows with no real prepend, stopping the loop one page
    //   too early (the same class of bug `firstItemIndex`'s own math had to
    //   be fixed for).
    // - `applyMessages`' per-call return breaks the *opposite* way if a live
    //   `timeline:update` for this same `paginate_backwards` call applies
    //   the prepend *before* this request's own response arrives: by the
    //   time this loop processes that response, `applyMessages` finds
    //   nothing new to shift (the live update already moved
    //   `previousMessagesRef`), reports zero progress, and this loop
    //   would call `getTimelinePage` again — needlessly walking further
    //   back than the single page the user's scroll-up asked for.
    // Comparing against the loop's own starting point catches genuine
    // progress regardless of which path (this loop's own responses, or a
    // racing live update) produced it.
    const initialFirstKey = messages.length > 0 ? messageRowKey(messages[0]) : null;
    const startedEmpty = messages.length === 0;
    try {
      for (;;) {
        const page = await getTimelinePage(roomId);
        // Stale if the room has changed since this request was issued —
        // including a revisit to the same room id, which `visitGenerationRef`
        // (unlike a plain `currentRoomIdRef` comparison) still distinguishes.
        // Don't apply this response's messages or index shift in that case.
        if (visitGenerationRef.current !== generation) return;
        nextCursorRef.current = page.next_cursor;
        setHasMore(page.next_cursor !== null);
        applyMessages(page.messages);
        setPaginationError(false);
        const currentFirstKey =
          previousMessagesRef.current.length > 0
            ? messageRowKey(previousMessagesRef.current[0])
            : null;
        const madeProgress =
          currentFirstKey !== initialFirstKey || (startedEmpty && page.messages.length > 0);
        if (madeProgress || page.next_cursor === null) break;
      }
    } catch (err) {
      // Stale if the room changed while this request was in flight — same
      // reasoning as the success path above; without this guard, room A's
      // failure could set `paginationError` for room B, blocking B's own
      // empty-page auto-pagination or showing "Couldn't load messages"
      // despite only A's request having failed.
      if (visitGenerationRef.current !== generation) return;
      // Distinct from a page that succeeds but adds nothing — this is a
      // genuine request failure, and `ChatShell`'s empty-first-page
      // auto-pagination effect must stop retrying once it's true rather
      // than immediately calling this again the moment `loadingMore` flips
      // back to `false` (its other trigger conditions are otherwise
      // unchanged by a failed request), which would otherwise loop forever
      // against a persistent backend/network error.
      setPaginationError(true);
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
    hasMore,
    paginationError,
    firstItemIndex,
    loadMoreHistory,
    handleAtBottomStateChange,
  };
}
