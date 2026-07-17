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

export function useChatTimeline(
  room: RoomSummary | null,
  roomSettingsOpen: boolean,
  hasPendingJump = false,
) {
  const [messages, setMessages] = useState<RoomMessageSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [firstItemIndex, setFirstItemIndex] = useState(INITIAL_FIRST_ITEM_INDEX);
  // How many *leading* entries in the current `messages` were genuinely
  // prepended (older history just loaded), as of the last `applyMessages`
  // call — see that function's own comment for why this must be `newIndex`
  // (the surviving anchor's new position), not the `firstItemIndex` shift.
  // `ChatShell` uses this to exclude those specific leading rows from its
  // entrance-animation/jump-to-present "fresh" diff, since they're old
  // history that was never seen before but shouldn't be treated as a new
  // arrival either.
  const [prependedCount, setPrependedCount] = useState(0);
  // Mirrors `firstItemIndex` synchronously, so `loadMoreHistory`'s pagination
  // loop can read its *current* value mid-call — the `firstItemIndex`
  // component-state variable itself only updates on the next render, which
  // is too late for a same-call before/after comparison across loop
  // iterations (`setFirstItemIndex`'s updater form batches, it doesn't
  // resolve synchronously).
  const firstItemIndexRef = useRef(INITIAL_FIRST_ITEM_INDEX);
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
  // Review fix: `hasPendingJump` alone isn't a wide enough suppression
  // window for mark-read — `ChatShell` clears its `jumpToEventId` (flipping
  // `hasPendingJump` back to `false`) immediately after calling Virtuoso's
  // `scrollToIndex`, which is synchronous but whose resulting
  // `atBottomStateChange` report is not — it lands on a later render once
  // Virtuoso has actually measured the new scroll position. In that gap,
  // `hasPendingJump` already reads `false` while `isAtBottomRef` still holds
  // whatever value it had *before* the jump (typically `true`, from the
  // room's initial mount), so `markReadIfAtBottom` would fire prematurely.
  // This ref stays `true` from the moment a jump starts until Virtuoso's own
  // `atBottomStateChange` callback actually reports a position afterward —
  // a real signal, not just a prop having changed — so mark-read stays
  // suppressed for the entire gap, however long it turns out to be.
  const suppressMarkReadRef = useRef(false);
  if (hasPendingJump) suppressMarkReadRef.current = true;
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
  // Mirrors `prependedCount` state synchronously — lets `applyMessages`
  // recover the still-correct value for a *redundant echo* call (see that
  // function's own comment) without racing the `prependedCount` state
  // variable, which doesn't update until next render.
  const prependedCountRef = useRef(0);
  // Tracks the room id these refs were last reset for — `undefined` (not
  // `null`) as the initial sentinel, since `null` ("no room active") is
  // itself a valid target state distinct from "never reset yet".
  const lastResetRoomIdRef = useRef<string | null | undefined>(undefined);
  // Resets the refs `loadMoreHistory`/`applyMessages` depend on for
  // correctness *synchronously during render*, not inside the `useEffect`
  // below — a child component (Virtuoso, keyed by room id so it remounts on
  // every room switch) can call `startReached` from its own mount-time
  // effect, and React fires child effects before parent effects in the same
  // commit. If these refs were only reset inside this hook's own effect,
  // a short enough room B that immediately "reaches the top" could trigger
  // `loadMoreHistory` while `currentRoomIdRef`/`nextCursorRef` still held
  // room A's values from before the switch — issuing a stateful backward-
  // pagination request against the wrong room's Timeline. Plain mutations
  // during render are safe for this exact "adjust bookkeeping when a prop
  // changed" pattern (see react.dev's guidance on storing information from
  // previous renders); the actual data fetch still has to happen in the
  // effect below, since starting a request during render is not allowed.
  const timelineRoomId = room?.room_id ?? null;
  if (lastResetRoomIdRef.current !== timelineRoomId) {
    lastResetRoomIdRef.current = timelineRoomId;
    visitGenerationRef.current += 1;
    isAtBottomRef.current = true;
    currentRoomIdRef.current = timelineRoomId;
    nextCursorRef.current = null;
    loadingMoreRef.current = false;
    previousMessagesRef.current = [];
    prependedCountRef.current = 0;
    firstItemIndexRef.current = INITIAL_FIRST_ITEM_INDEX;
  }

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
    // A *redundant echo*: this call's content is identical — by key AND by
    // value, in the same order — to what's already loaded. This happens when
    // a racing `timeline:update` and this same `loadMoreHistory` request's
    // own response both carry the same diff — whichever call runs second
    // finds nothing new to compare against (its "previous" already *is* this
    // content), so recomputing from scratch would report zero prepended
    // rows, overwriting the still-unconsumed real `prependedCount` the first
    // call correctly set (React batches both into the same commit, so
    // `ChatShell` never observes the correct intermediate value) — silently
    // losing the entrance-animation/jump-to-present exclusion for those
    // rows, or (see `loadMoreHistory`) misreading a genuine prepend as no
    // progress and fetching an unneeded extra page. `newMessages.length > 0`
    // guards against a room-switch reset (`previousMessagesRef` synchronously
    // cleared to `[]`, `messages` state not yet caught up) where both sides
    // being empty is coincidence, not a real duplicate to preserve. The value
    // comparison (not just matching keys) matters because a message's key
    // (`transaction_id ?? event_id`) can stay the same across a real content
    // change this call must still apply — e.g. a local echo's `send_state`
    // flipping from "pending" to "sent", or a message becoming `redacted` —
    // which a key-only match would wrongly treat as "nothing changed" and
    // silently drop. This is exactly why `previousMessagesRef` is stored as a
    // deep clone below rather than the live array/objects themselves: a
    // *different* row (not this call's subject) can be mutated in place by
    // something else — e.g. a reaction toggle mutating a message's
    // `reactions` array — between when it was stored as "previous" and when
    // this call runs; comparing against a live (still-mutating) reference
    // would see that unrelated row's *current* content and misreport this
    // call as a no-op redundant echo even though it's the first time this
    // exact snapshot has actually reached `applyMessages`.
    if (
      newMessages.length > 0 &&
      previous.length === newMessages.length &&
      previous.every((m, i) => messageRowKey(m) === messageRowKey(newMessages[i])) &&
      JSON.stringify(previous) === JSON.stringify(newMessages)
    ) {
      return prependedCountRef.current;
    }
    // The count of genuinely new *leading* entries in `newMessages` — i.e.
    // how many positions come before wherever the first surviving
    // previously-loaded message now sits. This is `newIndex` itself, not
    // the `firstItemIndex` shift (`oldIndex - newIndex`): those two only
    // coincide when `oldIndex` is 0 (a plain prepend with no front-row
    // removal). If the update *both* prepends history *and* drops one or
    // more old front rows (e.g. an `UnableToDecrypt` placeholder resolving
    // into a filtered-out type, mixed with a real prepend in the same
    // snapshot), the shift is only the *net* movement — using it here would
    // under-count and let some genuinely-old prepended rows slip through as
    // "fresh" to `ChatShell`'s entrance-animation/jump-to-present logic.
    // `newIndex` is unaffected by that: it's exactly the boundary between
    // "new content ahead of the anchor" and the anchor itself, regardless of
    // how many old rows were removed along the way.
    let newPrependedCount = 0;
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
        if (shift !== 0) {
          firstItemIndexRef.current += shift;
          setFirstItemIndex(firstItemIndexRef.current);
        }
        newPrependedCount = newIndex;
        break;
      }
      // If no previously-loaded message survives anywhere in the new
      // snapshot at all (extremely unlikely — the entire loaded window
      // would have to have been replaced), there's no reliable anchor to
      // shift from; leave `firstItemIndex` as-is rather than guess.
    }
    // A deep clone, not `newMessages` itself — see the redundant-echo check
    // above for why: a message object elsewhere in this array can still be
    // mutated in place later (this is IPC-sourced data, but nothing stops a
    // caller from holding onto and later touching one of these objects), and
    // `previousMessagesRef` must keep reflecting the content *as of this
    // call*, not whatever that object happens to look like by the time a
    // later call reads it back out.
    previousMessagesRef.current = JSON.parse(JSON.stringify(newMessages)) as RoomMessageSummary[];
    prependedCountRef.current = newPrependedCount;
    setPrependedCount(newPrependedCount);
    setMessages(newMessages);
    return newPrependedCount;
  }

  useEffect(() => {
    // Keyed on the room id, not the `room` object itself: `RoomsScreen` hands
    // this a fresh `room` reference on every `room_list:update`, and
    // `Timeline::paginate_backwards`'s pagination is now stateful per-room
    // (Spec 14), so re-running this on every such refresh would silently
    // walk further back into history each time instead of just loading the
    // room once.
    //
    // The refs `loadMoreHistory` depends on for correctness were already
    // reset synchronously during render, above — this effect only resets
    // the *state* (which can safely lag a commit, since nothing reads it
    // before this effect runs) and kicks off the actual fetch.
    setLoadingMore(false);
    setHasMore(false);
    setPaginationError(false);
    setFirstItemIndex(INITIAL_FIRST_ITEM_INDEX);
    setPrependedCount(0);
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
    //
    // `forceLive: true` — this effect fires only on a genuine room open
    // (keyed on `room?.room_id` below), so it's the right place to reset a
    // stale focused (Saved Messages jump) view back to live; the separate
    // pagination call further down must not do the same (see its own
    // comment) or scrolling further back while still viewing a bookmark's
    // context would snap back to the live tail mid-scroll.
    getTimelinePage(timelineRoomId, undefined, undefined, true)
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

  // Review fix: once a Saved Messages jump falls back to the Rust
  // `TimelineFocus::Event` path (the live-tail-only client-side scan in
  // `load_timeline_around_event` gave up and it resolved the target via the
  // server's `/context` endpoint instead), the room's cached backend
  // `Timeline` stays swapped to that focused view — `replace_timeline`
  // installs it, and nothing resets it back to live afterward. The
  // room-open effect above is the *only* place that passes `forceLive:
  // true`, and it's keyed on `room?.room_id`, which never changes for this
  // case (the user is still in the same room, just scrolled to older
  // history within it) — so it never re-runs. Without an explicit reset,
  // "Jump to Present" only scrolls within whatever's loaded in that
  // (possibly narrow) focused window, and the room stops receiving live
  // updates entirely (the listener is on the focused timeline, not the live
  // one) until the user leaves and reopens the room. `ChatShell`'s
  // "Jump to Present" handler calls this to force the same live-tail
  // re-fetch/reset the room-open path does, without needing a room switch.
  async function resetToLive() {
    if (!room) return;
    const targetRoomId = room.room_id;
    // Review fix: without this, a slow response landing after the user has
    // since switched rooms (or revisited this same room id — a plain
    // `currentRoomIdRef` comparison wouldn't catch that, see
    // `loadMoreHistory`'s identical use of this same ref) would still apply
    // its `messages`/pagination state to whatever room is currently
    // mounted, the same staleness class `loadMoreHistory`'s own generation
    // check already guards against.
    const generation = visitGenerationRef.current;
    setLoadingMore(false);
    setHasMore(false);
    setPaginationError(false);
    setFirstItemIndex(INITIAL_FIRST_ITEM_INDEX);
    setPrependedCount(0);
    setLoading(true);
    try {
      const page = await getTimelinePage(targetRoomId, undefined, undefined, true);
      if (visitGenerationRef.current !== generation) return;
      applyMessages(page.messages);
      nextCursorRef.current = page.next_cursor;
      setHasMore(page.next_cursor !== null);
    } catch (err) {
      if (visitGenerationRef.current !== generation) return;
      logAndIgnore(err);
    } finally {
      if (visitGenerationRef.current === generation) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    const listenerRoomId = room?.room_id;
    if (!listenerRoomId) return undefined;
    const unlisten = onTimelineUpdate((update) => {
      if (update.room_id !== listenerRoomId) return;
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
    // Review fix: without this, a jump interrupted by a manual room switch
    // before Virtuoso ever reported a post-jump position (the only thing
    // that otherwise clears it — see `suppressMarkReadRef`'s own comment)
    // would leave mark-read suppressed forever for whatever room the user
    // opens next, even though that room has no pending jump of its own.
    // Set (not unconditionally cleared) from the current `hasPendingJump`
    // rather than hardcoded `false`: this effect and the render-time
    // `if (hasPendingJump) suppressMarkReadRef.current = true` statement
    // above can both apply to the very same room-open (opening a *new*
    // room via a bookmark jump) — resetting to a bare `false` here would
    // undo that render's own correct suppression.
    suppressMarkReadRef.current = hasPendingJump;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only re-runs on room change; reads the latest hasPendingJump from this render's closure.
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
    // Review fix: a Saved Messages jump opens this room to scroll to an
    // older bookmarked message, not the live tail. Blindly mark-reading the
    // whole room here (as a normal room-open otherwise does) would send a
    // read receipt/fully-read marker for the room's latest event and clear
    // its unread state even though the user is about to view — and hasn't
    // actually seen — messages newer than the bookmark. Skip the blanket
    // mark-read for this open (still consuming the dedup key above, so it
    // doesn't fire retroactively once the jump resolves either);
    // `markReadIfAtBottom` below still marks read normally if/when the user
    // actually scrolls down to the live tail themselves.
    if (hasPendingJump) return;
    markRoomRead(room.room_id).catch(logAndIgnore);
  }, [room, roomSettingsOpen, hasPendingJump]);

  // Marks the room read once the true bottom of the timeline is visible —
  // driven by Virtuoso's own `atBottomStateChange` (see
  // `handleAtBottomStateChange` below) instead of a permanently-mounted
  // bottom-sentinel `IntersectionObserver`, since a virtualized list's last
  // row is no longer always a mounted DOM node to observe.
  function markReadIfAtBottom() {
    if (!room || !latestEventId) return;
    if (roomSettingsOpen) return;
    // Review fix: checks the suppression ref (which stays set across the
    // gap between `hasPendingJump` clearing and Virtuoso's own
    // `atBottomStateChange` report — see that ref's own comment), not
    // `hasPendingJump` directly. `isAtBottomRef` defaults to `true` (assumes
    // the live tail until Virtuoso reports otherwise), so without this,
    // mark-read could still fire on the very first post-jump render, before
    // Virtuoso has had a chance to report the real post-jump scroll
    // position at all.
    if (suppressMarkReadRef.current) return;
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
  }, [room, latestEventId, roomSettingsOpen, hasPendingJump]);

  function handleAtBottomStateChange(atBottom: boolean) {
    isAtBottomRef.current = atBottom;
    // Review fix: this is the actual signal `suppressMarkReadRef` is
    // waiting for — Virtuoso reporting a real post-jump scroll position,
    // not just `hasPendingJump` having flipped back to `false` on a
    // possibly-earlier render. Clearing it here (rather than wherever
    // `hasPendingJump` changes) is what closes that gap.
    //
    // Review fix: only while a jump *isn't* pending, though — Virtuoso can
    // still report `atBottom=true` for the room's initial live-tail
    // snapshot before a not-yet-loaded bookmark's own `loadTimelineAroundEvent`
    // has resolved and scrolled anywhere (that resolution, and the
    // `scrollToIndex` it triggers, is what actually clears `hasPendingJump`
    // — see `ChatShell`'s jump effect). Clearing suppression on *that*
    // report would mark read off the room's unrelated live tail while the
    // jump to older, unseen history is still in flight. The render-time
    // `if (hasPendingJump) suppressMarkReadRef.current = true` above already
    // re-asserts suppression on every render while a jump is pending, but
    // this callback can run independently of that render cycle (a child's
    // effect, not a state update), so it must not undo it in between.
    if (!hasPendingJump) suppressMarkReadRef.current = false;
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
    // Progress is judged per-iteration, from three signals combined (any one
    // being true is enough):
    // - `firstItemIndexRef` has decreased since the whole loop started. This
    //   catches a prepend that a *racing* `timeline:update` already applied
    //   (via its own `applyMessages` call, outside this loop) before this
    //   iteration's own response arrives — by the time this call runs,
    //   `applyMessages` finds nothing new to shift and reports zero prepended
    //   rows itself, so only comparing against the loop's own starting point
    //   (not just this call's return value) catches that the real work was
    //   already done.
    // - This iteration's own `applyMessages` return value — the count of
    //   genuinely prepended rows ahead of whichever previously-loaded message
    //   survives (see that function's comment) — rather than relying on the
    //   `firstItemIndex` diff alone. A page that both prepends real history
    //   *and* drops an equal number of old front rows (e.g. an
    //   `UnableToDecrypt` placeholder resolving into a filtered-out type)
    //   nets that diff to zero even though real progress was made in this
    //   very call, which the first signal alone would misread as "no
    //   progress" and over-page.
    // - Whether `previousMessagesRef` was empty *immediately before this
    //   iteration's own `applyMessages` call* (not hoisted once before the
    //   loop) combined with this page contributing any renderable rows at
    //   all — needed because `applyMessages`'s matching logic has no anchor
    //   to shift from when there's nothing previously loaded to compare
    //   against, so it always reports zero prepended rows in that case even
    //   on a genuine first page of real history. Checking this fresh on
    //   every iteration (rather than once, from `messages.length` as of when
    //   the loop started) matters because a live `timeline:update` racing
    //   this same call can populate `previousMessagesRef` mid-loop with,
    //   say, just a new tail message — at that point it's no longer "empty",
    //   so a later iteration's page containing only that same racing message
    //   (with no real older content) correctly reads as zero progress via the
    //   second signal instead of being misread as a genuine first page.
    const initialFirstItemIndex = firstItemIndexRef.current;
    try {
      for (;;) {
        // `forceLive` defaults to `false` here (deliberately not passed) —
        // this loop is pagination within whatever's already the active view,
        // which may itself be a focused (Saved Messages jump) timeline the
        // user is still scrolling further back through; forcing live here
        // would snap that view back to the room's live tail mid-scroll. Only
        // the room-open effect above passes `true`.
        const page = await getTimelinePage(roomId);
        // Stale if the room has changed since this request was issued —
        // including a revisit to the same room id, which `visitGenerationRef`
        // (unlike a plain `currentRoomIdRef` comparison) still distinguishes.
        // Don't apply this response's messages or index shift in that case.
        if (visitGenerationRef.current !== generation) return;
        nextCursorRef.current = page.next_cursor;
        setHasMore(page.next_cursor !== null);
        const wasEmpty = previousMessagesRef.current.length === 0;
        const prependedByThisPage = applyMessages(page.messages);
        setPaginationError(false);
        const madeProgress =
          firstItemIndexRef.current < initialFirstItemIndex ||
          prependedByThisPage > 0 ||
          (wasEmpty && page.messages.length > 0);
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
    prependedCount,
    loadMoreHistory,
    handleAtBottomStateChange,
    resetToLive,
  };
}
