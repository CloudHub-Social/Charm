import { useAtomValue } from "jotai";
import { useDrag } from "@use-gesture/react";
import { MoonIcon, SearchIcon, SettingsIcon } from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useFlag } from "@/featureFlags";
import { useFocusMode } from "@/features/focus/useFocusMode";
import { PresenceDot } from "@/features/presence/PresenceDot";
import { useOwnProfile } from "@/features/profile/useOwnProfile";
import { useSettingsNavigation } from "@/features/settings/useSettingsNavigation";
import { badgeAtom } from "@/features/shell/badgeAtom";
import {
  markRoomRead,
  joinRoom,
  knockRoom,
  listSpaceHierarchy,
  removeSpaceChild,
  setRoomFavourite,
  setRoomLowPriority,
  setRoomManualOrder,
  setRoomMarkedUnread,
  setRoomMuted,
  type RoomSummary,
  type SpaceChild,
  type SpaceHierarchyNode,
} from "@/lib/matrix";
import { isWebBuild } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { RoomListItem } from "./RoomListItem";
import { RoomInviteItem } from "./RoomInviteItem";
import { RoomListSection } from "./SpaceSection";
import {
  filterHierarchyToUnread,
  filterRoomsToUnread,
  persistRoomListFilters,
  readRoomListFilters,
  type RoomListFilter,
} from "./roomListFilter";
import {
  persistRoomListSorts,
  readRoomListSorts,
  sortRoomsForDisplay,
  type RoomListSort,
} from "./roomListSort";
import {
  groupRoomsIntoSections,
  planManualReorder,
  targetIndexFromMeasuredHeights,
} from "./roomSections";
import { filterRoomsByQuery, filterSpaceChildrenByQuery } from "./roomSearch";
import { avatarColor, displayName, initials, resolveAvatar } from "./roomDisplay";
import { useRoomListTyping } from "./useRoomListTyping";
import { logAndIgnore } from "@/lib/logAndIgnore";
import type { RoomListMode } from "./SpaceRail";

interface RoomListProps {
  rooms: RoomSummary[];
  loading?: boolean;
  activeRoomId: string | null;
  onSelectRoom: (id: string) => void;
  onSelectSpace: (id: string) => void;
  /**
   * Selecting a search result found via "Search everywhere" (or one that's
   * otherwise outside the current scope) needs to switch context — mode,
   * selected space, `showAllRooms` — not just set the active room, the way
   * an already-in-scope row's `onSelectRoom` does. Falls back to
   * `onSelectRoom` if omitted, for callers that don't care about
   * cross-scope search (e.g. tests).
   */
  onSelectSearchResult?: (room: RoomSummary) => void;
  mode: RoomListMode;
  selectedSpace: RoomSummary | null;
  /**
   * The id `selectedSpace` is expected to resolve to, even before it shows
   * up in `rooms` (e.g. right after creating/joining a space, before the
   * next room-list sync lands it). Lets the empty state below tell "a space
   * is selected but hasn't loaded yet" apart from "no space selected at
   * all" — both look identical from `selectedSpace` alone (`null`). Distinct
   * from the `selectedSpaceId` derived below from the *resolved* space —
   * this one is the caller's intent, which may be ahead of it.
   */
  intendedSpaceId?: string | null;
  showAllRooms: boolean;
  onShowAllRoomsChange: (showAll: boolean) => void;
  onAcceptInvite?: (roomId: string) => Promise<void>;
  onDeclineInvite?: (roomId: string) => Promise<void>;
  /** Bumped by the caller after "Add Existing" (owned by a sibling
   * `SpaceRail`) files a room/space under the selected space — the open
   * lobby's own `/hierarchy` fetch below doesn't otherwise know a mutation
   * happened, since `mode`/`selectedSpaceId` haven't changed. */
  hierarchyRefreshToken?: number;
}

const noopInviteAction = (): Promise<void> => Promise.resolve();
// Stable empty-set reference so a flag-off render doesn't hand
// `renderHierarchy` a fresh `Set` every time (defeats nothing correctness-
// wise here, but keeping it a constant avoids an unnecessary allocation).
const EMPTY_TYPING_IDS: Set<string> = new Set();

function unreadBadgeLabel(totalUnread: number, totalHighlight: number): string {
  const rooms = `${totalUnread} unread room${totalUnread === 1 ? "" : "s"}`;
  const mentions =
    totalHighlight > 0 ? `, ${totalHighlight} mention${totalHighlight === 1 ? "" : "s"}` : "";
  return `${rooms}${mentions}`;
}

function reorderWithin(sectionRooms: RoomSummary[], roomId: string, targetIndex: number) {
  const updates = planManualReorder(sectionRooms, roomId, targetIndex);
  for (const { room_id, order } of updates) {
    setRoomManualOrder(room_id, order).catch(logAndIgnore);
  }
}

export function RoomList({
  rooms,
  loading = false,
  activeRoomId,
  onSelectRoom,
  onSelectSpace,
  onSelectSearchResult,
  mode,
  selectedSpace,
  intendedSpaceId = null,
  showAllRooms,
  onShowAllRoomsChange,
  onAcceptInvite = noopInviteAction,
  onDeclineInvite = noopInviteAction,
  hierarchyRefreshToken,
}: RoomListProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState("");
  // Off by default: search is scoped to the current Home/space/DMs context,
  // matching Charm 1.0's Search.tsx pattern — this is the escape hatch to
  // search every joined room instead.
  const [searchEverywhere, setSearchEverywhere] = useState(false);
  const [roomListFilters, setRoomListFilters] = useState(readRoomListFilters);
  const [roomListSorts, setRoomListSorts] = useState(readRoomListSorts);
  const [spaceHierarchy, setSpaceHierarchy] = useState<SpaceHierarchyNode[]>([]);
  const [spaceLoading, setSpaceLoading] = useState(false);
  // Kept separate from `joinError`: this is specifically "the hierarchy
  // fetch itself failed", which is the only case that should block a scoped
  // search from showing results (see the render guard below) — a room the
  // user failed to *join* doesn't mean the already-loaded hierarchy can't be
  // searched.
  const [spaceError, setSpaceError] = useState<string | null>(null);
  // A join/knock failure from `handleJoin`, surfaced as a banner but — unlike
  // `spaceError` — never blocking scoped search results, since the hierarchy
  // itself loaded fine.
  const [joinError, setJoinError] = useState<string | null>(null);
  const [pendingRoomId, setPendingRoomId] = useState<string | null>(null);
  const [pendingInviteRoomId, setPendingInviteRoomId] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  // Space-child mutations aren't power-level-gated in the UI (Remove from
  // space is offered unconditionally), so a rejection — missing power
  // level, offline, a since-removed link — is a normal reachable outcome
  // that needs to be visible, not silently dropped.
  const [removeError, setRemoveError] = useState<string | null>(null);
  const pendingJoinRoomIdRef = useRef<string | null>(null);
  const currentScopeRef = useRef({ mode, selectedSpaceId: selectedSpace?.room_id ?? null });
  // Rows aren't a fixed height (the message-preview flag grows some rows a
  // second text line) — drag-reorder measures each row's actual rendered
  // height (keyed by room id, set by `DraggableRoomRow`) instead of assuming
  // `ROW_HEIGHT_PX`, so manual reordering still works correctly regardless.
  const rowHeightsRef = useRef<Map<string, number>>(new Map());
  const { data: ownProfile } = useOwnProfile();
  const { openSettings } = useSettingsNavigation();
  const badge = useAtomValue(badgeAtom);
  // Spec 30: small chrome indicator while Do Not Disturb is active — flag-
  // gated the same as the Settings entry point (FocusPanel) and the tray
  // menu, so this can't appear for a build where DND can't be toggled at
  // all. Does not affect unread badge computation above, which is untouched
  // by DND (see `shell::compute_badge_state`'s own doc comment).
  const focusModeFlagEnabled = useFlag("focus_mode");
  const roomListUnreadFilterFlagEnabled = useFlag("room_list_unread_filter");
  // Same flag `SpaceRail`'s own space-management actions are gated behind —
  // "Remove from space" on a regular room row is the counterpart to that
  // menu's `Remove` for sub-space rows, so it ships/rolls out together.
  const spaceRailManagementEnabled = useFlag("space_rail_management");
  const roomListSortFlagEnabled = useFlag("room_list_sort");
  const roomListTypingFlagEnabled = useFlag("room_list_typing_indicator");
  // Called unconditionally (rules of hooks); only its result is honored
  // below, gated on the flag — mirrors `useChatTyping`'s own
  // `detailControlsEnabled` pattern.
  const typingRoomIds = useRoomListTyping(ownProfile?.user_id ?? "");
  const { enabled: dndEnabled } = useFocusMode();
  const selectedSpaceId = selectedSpace?.room_id ?? null;
  const activeFilter: RoomListFilter = roomListUnreadFilterFlagEnabled
    ? roomListFilters[mode]
    : "all";
  const unreadOnly = activeFilter === "unread";
  const activeSort: RoomListSort = roomListSortFlagEnabled ? roomListSorts[mode] : "default";
  currentScopeRef.current = { mode, selectedSpaceId };

  const invitedRooms = useMemo(() => rooms.filter((room) => room.membership === "invite"), [rooms]);
  const joinedRooms = useMemo(() => rooms.filter((room) => room.membership === "join"), [rooms]);
  const roomById = useMemo(
    () => new Map(joinedRooms.map((room) => [room.room_id, room])),
    [joinedRooms],
  );
  const filteredSpaceHierarchy = useMemo(
    () =>
      unreadOnly ? filterHierarchyToUnread(spaceHierarchy, roomById, activeRoomId) : spaceHierarchy,
    [unreadOnly, spaceHierarchy, roomById, activeRoomId],
  );
  const visibleHierarchyCount = useMemo(
    () => countVisibleHierarchyNodes(filteredSpaceHierarchy, roomById),
    [filteredSpaceHierarchy, roomById],
  );
  // Maps each descendant's room id to its *immediate* parent's id, per the
  // freshly-fetched `/hierarchy` snapshot — not `room.parent_space_ids`
  // (Codex review on #290, P2). Two gaps that check alone has: a tagged
  // (favourite/low-priority) room Add Existing just published can appear in
  // this hierarchy fetch before the next `/sync` updates its
  // `parent_space_ids`, so the local-only check would miss it entirely; and
  // for a descendant under a *nested* space, `parent_space_ids` doesn't say
  // which immediate parent to detach from (only the hierarchy's own tree
  // shape does — the room's top-level `selectedSpaceId` membership isn't
  // its actual removal target for a deeper node).
  const hierarchyParentById = useMemo(
    () =>
      mode === "space" && selectedSpaceId
        ? hierarchyParentByRoomId(spaceHierarchy, selectedSpaceId)
        : new Map<string, string>(),
    [mode, selectedSpaceId, spaceHierarchy],
  );
  const scopedRooms = useMemo(
    () =>
      getScopedRooms({
        rooms: joinedRooms,
        mode,
        selectedSpace,
        showAllRooms,
        hierarchy: spaceHierarchy,
      }),
    [joinedRooms, mode, selectedSpace, showAllRooms, spaceHierarchy],
  );
  // Used to decide whether a search result is already visible in the current
  // scope (just select it) or requires switching context first (mode,
  // selected space, showAllRooms) via onSelectSearchResult — otherwise every
  // hit, even ones already on screen, would over-eagerly switch scope.
  const scopedRoomIds = useMemo(
    () => new Set(scopedRooms.map((room) => room.room_id)),
    [scopedRooms],
  );
  // `roomListItemPropsEqual` deliberately excludes callback props from its
  // comparison (RoomList creates fresh closures every render regardless of
  // whether captured values changed, so comparing them would defeat the
  // memoization entirely). That's safe as long as a stale closure still
  // *behaves* correctly if React skips a re-render and reuses it — which a
  // closure over `scopedRoomIds`/`onSelectSearchResult` directly would not:
  // a search result row could stay memoized across a scope change and fire
  // the wrong branch on click (Codex review on #288, P2). Refs sidestep
  // this: any closure created from `handleSelectSearchResult`, however old,
  // always reads the current scope when it's actually invoked.
  //
  // Resolving by `room_id` through `roomByIdRef` (rather than trusting the
  // `RoomSummary` object baked into a search-result row's `onSelect`
  // closure) closes a related staleness gap Codex re-flagged after the
  // above fix (comments 3599666130/3599749219): `roomListItemPropsEqual`
  // doesn't compare `parent_space_ids` (unbounded-length array, not a cheap
  // per-field check like the rest), so a memoized row can survive a sync
  // update that changes it — and `onSelectSearchResult`
  // (`selectRoomInVisibleMode`) reads exactly that field to decide whether
  // to land on Home or a space. The stale closure still fires the right
  // *branch* now (scope check is ref-backed above), but was still handing
  // that branch a possibly-outdated room. Looking it up fresh here means
  // even a maximally stale closure always acts on current routing data.
  const roomByIdRef = useRef(roomById);
  roomByIdRef.current = roomById;
  const scopedRoomIdsRef = useRef(scopedRoomIds);
  scopedRoomIdsRef.current = scopedRoomIds;
  const onSelectSearchResultRef = useRef(onSelectSearchResult);
  onSelectSearchResultRef.current = onSelectSearchResult;
  // `onSelectRoom` ref-backed too (Sentry review, LOW): not observably
  // buggy today since `selectRoom` doesn't currently close over anything
  // that changes between renders, but it's the same fragile pattern this
  // callback already guards against for its other captures, and a stale
  // reference here was simply overlooked rather than deliberate.
  const onSelectRoomRef = useRef(onSelectRoom);
  onSelectRoomRef.current = onSelectRoom;
  const handleSelectSearchResult = useCallback((roomId: string) => {
    const inScope = scopedRoomIdsRef.current.has(roomId);
    if (!inScope && onSelectSearchResultRef.current) {
      // `roomById` only indexes joined rooms (see its definition above),
      // which is exactly this callback's domain — an out-of-scope search
      // result being switched to must already be joined, or there'd be no
      // scope for `onSelectSearchResult` to switch into.
      const current = roomByIdRef.current.get(roomId);
      if (current) onSelectSearchResultRef.current(current);
    } else {
      onSelectRoomRef.current(roomId);
    }
    setSearchQuery("");
    setSearchEverywhere(false);
  }, []);
  const visibleScopedRooms = useMemo(
    () => (unreadOnly ? filterRoomsToUnread(scopedRooms, activeRoomId) : scopedRooms),
    [unreadOnly, scopedRooms, activeRoomId],
  );
  const sections = useMemo(() => {
    const grouped = groupRoomsIntoSections(visibleScopedRooms);
    // Sorted within each section only — never across Favourites/a space
    // group/plain Rooms/Low priority, so a sort choice can't move a room out
    // of its existing grouping. A non-"default" sort naturally disables
    // manual drag-reorder for the affected rows: `renderSectionRooms`'s
    // `canReorder` already requires this visible order to match
    // `fullSections`' unsorted one, which a resort deliberately breaks.
    return {
      ...grouped,
      favourites: sortRoomsForDisplay(grouped.favourites, activeSort),
      spaceGroups: grouped.spaceGroups.map((group) => ({
        ...group,
        rooms: sortRoomsForDisplay(group.rooms, activeSort),
      })),
      rooms: sortRoomsForDisplay(grouped.rooms, activeSort),
      lowPriority: sortRoomsForDisplay(grouped.lowPriority, activeSort),
    };
  }, [visibleScopedRooms, activeSort]);
  const fullSections = useMemo(() => groupRoomsIntoSections(joinedRooms), [joinedRooms]);
  const fullFavouriteSectionRooms = getFullSectionRooms(
    sections.favourites,
    fullSections.favourites,
  );
  const fullLowPrioritySectionRooms = getFullSectionRooms(
    sections.lowPriority,
    fullSections.lowPriority,
  );
  const roomSectionRooms = mode === "space" ? [] : sections.rooms;
  const fullRoomSectionRooms =
    mode === "dms" ? roomSectionRooms : getFullSectionRooms(roomSectionRooms, fullSections.rooms);

  const isSearching = searchQuery.trim().length > 0;
  const searchResults = useMemo(() => {
    if (!isSearching) return [];
    // Spaces aren't a destination search should surface — selecting one
    // isn't a single unambiguous action the way a room/DM row is (see
    // HierarchyRow's separate "Open" affordance for that).
    const joinedPool = searchEverywhere ? joinedRooms : scopedRooms;
    const visiblePool = unreadOnly ? filterRoomsToUnread(joinedPool, activeRoomId) : joinedPool;
    const pool = visiblePool.filter((room) => !room.is_space);
    return filterRoomsByQuery(pool, searchQuery);
  }, [
    isSearching,
    searchEverywhere,
    joinedRooms,
    scopedRooms,
    unreadOnly,
    activeRoomId,
    searchQuery,
  ]);
  // Unjoined children of the currently selected space's hierarchy: `rooms`
  // (and therefore `scopedRooms`) only ever contains rooms the account has
  // joined, so a public/knock child the user can see in the unsearched
  // hierarchy view (rendered straight from `spaceHierarchy` below) would
  // otherwise silently vanish from search — reported as a real bug (PR #150
  // review thread on this file). Scoped to the selected space's own
  // hierarchy regardless of "Search everywhere", since that toggle only
  // widens the *joined-room* pool above; unjoined children of other spaces
  // aren't loaded here to search in the first place.
  const unjoinedHierarchyMatches = useMemo(() => {
    if (!isSearching || unreadOnly || mode !== "space" || !selectedSpaceId) return [];
    const unjoinedChildren = flattenHierarchy(spaceHierarchy)
      .map((node) => node.child)
      .filter((child) => !child.is_space && !roomById.has(child.room_id));
    return filterSpaceChildrenByQuery(unjoinedChildren, searchQuery);
  }, [isSearching, unreadOnly, mode, selectedSpaceId, spaceHierarchy, roomById, searchQuery]);

  // Every hierarchy fetch (the mount/mode-switch effect below, plus any
  // manual `refetchSpaceHierarchy` call after a mutation) claims the next
  // id and only applies its result if it's still the *latest* one issued —
  // not just "not stale for its own effect run". Without a single shared
  // counter, an older mount-time request that happens to resolve after a
  // newer post-mutation refetch (or vice versa) could win the race and
  // silently overwrite the more current result.
  const hierarchyRequestIdRef = useRef(0);

  useEffect(() => {
    if (mode !== "space" || !selectedSpaceId) {
      hierarchyRequestIdRef.current += 1;
      setSpaceHierarchy([]);
      setSpaceError(null);
      setJoinError(null);
      setSpaceLoading(false);
      // A Remove-from-space failure from a prior space shouldn't keep
      // rendering as a banner after the user navigates to Home, DMs, or a
      // different space — this error is specific to whatever space it
      // happened in, unlike a join failure the user might still want to
      // retry from the same view.
      setRemoveError(null);
      return;
    }
    const requestId = ++hierarchyRequestIdRef.current;
    setSpaceLoading(true);
    setSpaceError(null);
    setJoinError(null);
    setSpaceHierarchy([]);
    setRemoveError(null);
    listSpaceHierarchy(selectedSpaceId)
      .then((result) => {
        if (hierarchyRequestIdRef.current === requestId) setSpaceHierarchy(result);
      })
      .catch((err) => {
        if (hierarchyRequestIdRef.current === requestId) setSpaceError(String(err));
      })
      .finally(() => {
        if (hierarchyRequestIdRef.current === requestId) setSpaceLoading(false);
      });
  }, [mode, selectedSpaceId]);

  // `spaceHierarchy` is a point-in-time `/hierarchy` snapshot, not something
  // Matrix sync keeps current — an `m.space.child` write (Remove from space,
  // Add Existing) doesn't retrigger the effect above on its own, since
  // `mode`/`selectedSpaceId` haven't changed. Called after those mutations
  // settle so the open lobby's row list reflects the edit immediately
  // instead of only after the user navigates away and back.
  function refetchSpaceHierarchy() {
    // Reads `currentScopeRef` rather than closing over `mode`/`selectedSpaceId`
    // directly — this function is often invoked from a `.then()` attached to
    // a mutation kicked off in an earlier render (e.g. `onRemoveFromSpace`
    // for a row that belonged to a space the user has since navigated away
    // from). Using the closed-over values would fetch (and let win, via
    // `hierarchyRequestIdRef`) a *stale* space's hierarchy over whatever the
    // user is actually looking at now.
    const scope = currentScopeRef.current;
    if (scope.mode !== "space" || !scope.selectedSpaceId) return;
    const requestedSpaceId = scope.selectedSpaceId;
    const requestId = ++hierarchyRequestIdRef.current;
    listSpaceHierarchy(requestedSpaceId)
      .then((result) => {
        if (hierarchyRequestIdRef.current !== requestId) return;
        if (currentScopeRef.current.selectedSpaceId !== requestedSpaceId) return;
        setSpaceHierarchy(result);
        // A prior load failure shouldn't keep masking a hierarchy that has
        // since recovered — e.g. connectivity returned and this refetch
        // (triggered by a successful mutation, which implies the server is
        // reachable) succeeded.
        setSpaceError(null);
      })
      .catch(logAndIgnore)
      .finally(() => {
        // If this refetch overtook the initial mount-time load (e.g. a
        // sibling SpaceRail's Add Existing/Remove bumped the request id
        // while that load was still in flight), that load's own `finally`
        // sees itself as stale and skips clearing `spaceLoading` — this is
        // the only path left to do it, or the lobby stays stuck on
        // "Loading space…" even after this refetch settles (Codex review,
        // #290). Doesn't check `currentScopeRef` like the `.then()` above:
        // even if the user has since navigated away, `spaceLoading` isn't
        // scoped to a particular space, so it's still correct to clear it
        // once whatever fetch was still "current" for it has settled.
        if (hierarchyRequestIdRef.current === requestId) setSpaceLoading(false);
      });
  }

  // `hierarchyRefreshToken` is the "Add Existing" side of the same gap —
  // owned by a sibling `SpaceRail`, so it can't call `refetchSpaceHierarchy`
  // directly; the caller bumps this token instead. Skips the very first run
  // (the mount-time fetch effect above already covers that) so mounting
  // already in space mode doesn't fire a redundant duplicate fetch.
  const hierarchyRefreshMountedRef = useRef(false);
  useEffect(() => {
    if (!hierarchyRefreshMountedRef.current) {
      hierarchyRefreshMountedRef.current = true;
      return;
    }
    refetchSpaceHierarchy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hierarchyRefreshToken]);

  // A query typed in one context (Home, DMs, a specific space) shouldn't
  // silently keep filtering an unrelated one after the user switches scope —
  // `RoomList` isn't remounted on a mode/space change, so its local search
  // state would otherwise persist across it.
  useEffect(() => {
    setSearchQuery("");
    setSearchEverywhere(false);
  }, [mode, selectedSpaceId]);

  // "Search everywhere" is meant to be re-opted-into per search session, not
  // remembered across an emptied box — otherwise reopening the search field
  // after clearing it silently defaults back to a global search the user
  // never re-selected.
  useEffect(() => {
    if (!isSearching) setSearchEverywhere(false);
  }, [isSearching]);

  function isExpanded(key: string): boolean {
    return expanded[key] ?? true;
  }

  function renderSectionRooms(sectionRooms: RoomSummary[], fullSectionRooms = sectionRooms) {
    // Reordering a filtered subset would compute positions against missing
    // rows and silently corrupt the full section order once "All" is restored.
    const canReorder = !unreadOnly && hasSameRoomOrder(sectionRooms, fullSectionRooms);
    return sectionRooms.map((room, index) => {
      // Favourite/low-priority rooms bypass the hierarchy view entirely (see
      // `isHiddenHierarchyRoom`) and render through this same section-rows
      // path even in space mode — so this is the only place those tagged
      // rows can pick up `Remove from space`; the untagged hierarchy rows
      // get theirs from `renderHierarchy` instead. Prefers the freshly
      // fetched `/hierarchy` snapshot's own parent over `parent_space_ids`
      // (Codex review on #290, P2): a tagged room Add Existing just
      // published can appear in that snapshot before the next `/sync`
      // updates `parent_space_ids`, and a descendant under a nested space
      // needs its *immediate* parent, which `parent_space_ids` alone
      // doesn't distinguish from the top-level selected space.
      const removeFromSpaceTargetId =
        spaceRailManagementEnabled && mode === "space" && selectedSpaceId
          ? (hierarchyParentById.get(room.room_id) ??
            (room.parent_space_ids.includes(selectedSpaceId) ? selectedSpaceId : undefined))
          : undefined;
      return (
        <DraggableRoomRow
          key={room.room_id}
          room={room}
          index={index}
          sectionRooms={sectionRooms}
          canReorder={canReorder}
          rowHeights={rowHeightsRef.current}
          active={room.room_id === activeRoomId}
          isTyping={roomListTypingFlagEnabled && typingRoomIds.has(room.room_id)}
          onSelect={() => onSelectRoom(room.room_id)}
          onReorder={(targetIndex) => reorderWithin(fullSectionRooms, room.room_id, targetIndex)}
          onRemoveFromSpace={
            removeFromSpaceTargetId
              ? () => {
                  setRemoveError(null);
                  removeSpaceChild(removeFromSpaceTargetId, room.room_id)
                    .then(refetchSpaceHierarchy)
                    .catch((err) =>
                      setRemoveError(err instanceof Error ? err.message : String(err)),
                    );
                }
              : undefined
          }
          removeFromSpaceTargetId={removeFromSpaceTargetId}
        />
      );
    });
  }

  // Deliberately not renderSectionRooms/DraggableRoomRow: search results are
  // a filtered view, not a real section — dragging one would compute a
  // manual_order target against the *filtered* list's positions rather than
  // the room's true section, silently corrupting its order once the search
  // is cleared.
  function renderSearchResults(results: RoomSummary[]) {
    return results.map((room) => (
      <RoomListItem
        key={room.room_id}
        room={room}
        active={room.room_id === activeRoomId}
        isTyping={roomListTypingFlagEnabled && typingRoomIds.has(room.room_id)}
        // Clearing search state here (inside `handleSelectSearchResult`)
        // rather than relying solely on the mode/selectedSpaceId reset
        // effect below matters because `onSelectSearchResult` can land back
        // on the *same* mode/space (e.g. a space still loading its
        // hierarchy misjudges an in-scope room as an out-of-scope result,
        // so `selectRoomInVisibleMode` re-selects the same space id), which
        // is a no-op state update that never triggers that effect, leaving
        // the search box and "Search everywhere" stuck on.
        onSelect={() => handleSelectSearchResult(room.room_id)}
        onToggleFavourite={() =>
          setRoomFavourite(room.room_id, !room.is_favourite).catch(logAndIgnore)
        }
        onToggleLowPriority={() =>
          setRoomLowPriority(room.room_id, !room.is_low_priority).catch(logAndIgnore)
        }
        onToggleMuted={
          isWebBuild()
            ? undefined
            : () => setRoomMuted(room.room_id, !room.is_muted).catch(logAndIgnore)
        }
        onMarkRead={() => markRoomRead(room.room_id).catch(logAndIgnore)}
        onMarkUnread={() => setRoomMarkedUnread(room.room_id, true).catch(logAndIgnore)}
      />
    ));
  }

  const allEmpty =
    invitedRooms.length === 0 &&
    sections.favourites.length === 0 &&
    sections.spaceGroups.length === 0 &&
    roomSectionRooms.length === 0 &&
    sections.lowPriority.length === 0;

  async function handleInviteAction(roomId: string, action: (roomId: string) => Promise<void>) {
    if (pendingInviteRoomId) return;
    setPendingInviteRoomId(roomId);
    setInviteError(null);
    try {
      await action(roomId);
    } catch (error) {
      setInviteError(String(error));
    } finally {
      setPendingInviteRoomId(null);
    }
  }

  async function handleJoin(child: SpaceChild) {
    if (pendingJoinRoomIdRef.current) return;
    const requestScope = { mode, selectedSpaceId };
    pendingJoinRoomIdRef.current = child.room_id;
    setPendingRoomId(child.room_id);
    setJoinError(null);
    try {
      if (child.join_rule === "knock") {
        await knockRoom(child.room_id);
      } else {
        await joinRoom(child.room_id);
      }
    } catch (err) {
      const currentScope = currentScopeRef.current;
      if (
        currentScope.mode === requestScope.mode &&
        currentScope.selectedSpaceId === requestScope.selectedSpaceId
      ) {
        setJoinError(String(err));
      }
    } finally {
      pendingJoinRoomIdRef.current = null;
      setPendingRoomId(null);
    }
  }

  const title =
    mode === "space"
      ? selectedSpace
        ? displayName(selectedSpace.room_id, selectedSpace.name)
        : "Space"
      : mode === "dms"
        ? "Direct messages"
        : "Home";

  function selectRoomFilter(filter: RoomListFilter) {
    setRoomListFilters((previous) => {
      const next = { ...previous, [mode]: filter };
      persistRoomListFilters(next);
      return next;
    });
  }

  function selectRoomSort(sort: RoomListSort) {
    setRoomListSorts((previous) => {
      const next = { ...previous, [mode]: sort };
      persistRoomListSorts(next);
      return next;
    });
  }

  return (
    <TooltipProvider>
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between gap-2 p-4">
          {ownProfile ? (
            <div className="flex min-w-0 items-center gap-2">
              <Avatar size="sm">
                <AvatarImage
                  src={resolveAvatar(ownProfile.avatar_path, ownProfile.avatar_url)}
                  alt=""
                />
                <AvatarFallback
                  style={{ background: avatarColor(ownProfile.user_id) }}
                  className="font-bold text-white"
                >
                  {initials(ownProfile.user_id, ownProfile.display_name)}
                </AvatarFallback>
                <PresenceDot presence={ownProfile.presence} />
              </Avatar>
              <span className="truncate text-base font-bold text-foreground">
                {ownProfile.display_name ?? ownProfile.user_id}
              </span>
            </div>
          ) : (
            <span className="text-base font-bold text-foreground">Charm</span>
          )}
          <div className="flex shrink-0 items-center gap-2">
            {focusModeFlagEnabled && dndEnabled && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    data-testid="dnd-chrome-indicator"
                    aria-label="Do Not Disturb is on"
                    className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-muted text-muted-foreground"
                  >
                    <MoonIcon className="size-3" aria-hidden="true" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">Do Not Disturb is on</TooltipContent>
              </Tooltip>
            )}
            {badge && badge.total_unread > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={cn(
                      "flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[11px] font-bold",
                      badge.total_highlight > 0
                        ? "bg-primary-solid text-primary-foreground"
                        : "bg-muted text-muted-foreground",
                    )}
                    aria-label={unreadBadgeLabel(badge.total_unread, badge.total_highlight)}
                  >
                    {badge.total_highlight > 0 ? badge.total_highlight : badge.total_unread}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {unreadBadgeLabel(badge.total_unread, badge.total_highlight)}
                </TooltipContent>
              </Tooltip>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Open settings"
              onClick={() => openSettings("account")}
            >
              <SettingsIcon />
            </Button>
          </div>
        </div>
        <div className="border-b border-border px-4 pb-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
            {mode === "home" && (
              <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="size-3.5 accent-primary"
                  checked={showAllRooms}
                  onChange={(event) => onShowAllRoomsChange(event.target.checked)}
                />
                Show all rooms
              </label>
            )}
          </div>
          {roomListUnreadFilterFlagEnabled && (
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">Show</span>
              <fieldset className="flex rounded-md border border-border bg-muted/40 p-0.5">
                <legend className="sr-only">Room filter</legend>
                {(["all", "unread"] as const).map((filter) => {
                  const selected = activeFilter === filter;
                  const label = filter === "all" ? "All" : "Unread";
                  return (
                    <button
                      key={filter}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => selectRoomFilter(filter)}
                      className={cn(
                        "rounded px-2 py-1 text-xs font-medium transition-colors",
                        selected
                          ? "bg-background text-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {label}
                    </button>
                  );
                })}
              </fieldset>
            </div>
          )}
          {roomListSortFlagEnabled && (
            <div className="mt-2 flex items-center justify-between gap-2">
              <label htmlFor="room-list-sort" className="text-xs text-muted-foreground">
                Sort
              </label>
              <select
                id="room-list-sort"
                value={activeSort}
                onChange={(event) => selectRoomSort(event.target.value as RoomListSort)}
                className="rounded-md border border-border bg-muted/40 px-2 py-1 text-xs font-medium text-foreground"
              >
                <option value="default">Default</option>
                <option value="activity">Activity</option>
                <option value="az">A-Z</option>
                <option value="unread">Unread first</option>
              </select>
            </div>
          )}
          <div className="mt-2 flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <SearchIcon
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                type="search"
                placeholder="Search rooms"
                aria-label="Search rooms"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                className="h-8 pl-8 text-sm"
              />
            </div>
          </div>
          {isSearching && (
            <label className="mt-2 flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="size-3.5 accent-primary"
                checked={searchEverywhere}
                onChange={(event) => setSearchEverywhere(event.target.checked)}
              />
              Search everywhere
            </label>
          )}
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {loading ? (
            <output
              aria-label="Loading rooms"
              className="flex animate-pulse flex-col gap-2 px-1 py-2"
            >
              {[0, 1, 2, 3, 4, 5].map((row) => (
                <span key={row} className="flex min-h-11 items-center gap-2 rounded-md px-2">
                  <span className="size-8 shrink-0 rounded-full bg-muted" />
                  <span className={cn("h-3 rounded bg-muted", row % 3 === 0 ? "w-2/3" : "w-1/2")} />
                </span>
              ))}
              <span className="sr-only">Loading rooms…</span>
            </output>
          ) : mode === "space" && !selectedSpace ? (
            // Space mode with nothing selected has nothing to search *in* —
            // this guard wins over an active query rather than showing search
            // results (or "No matching rooms") for an undefined scope.
            <p className="px-3 py-2 text-sm text-muted-foreground">
              {intendedSpaceId ? "Loading space…" : "Select a space."}
            </p>
          ) : mode === "space" && spaceLoading && !(isSearching && searchEverywhere) ? (
            // Same reasoning: a search over an as-yet-empty `scopedRooms` while
            // the space is still loading would otherwise misreport "No
            // matching rooms" for a query that hasn't actually been evaluated
            // against the space's real contents yet. Exempted when "Search
            // everywhere" is on: that pool is `rooms`, not the space's
            // hierarchy, so it doesn't depend on this load finishing.
            <p className="px-3 py-2 text-sm text-muted-foreground">Loading space…</p>
          ) : mode === "space" && spaceError && !(isSearching && searchEverywhere) ? (
            // A failed hierarchy fetch should stay visible instead of a scoped
            // search silently reporting "No matching rooms" against contents
            // that were never actually loaded. Global search is unaffected —
            // it doesn't read the hierarchy either. Deliberately checks
            // `spaceError` (the hierarchy fetch) only, not `joinError` — a
            // failed join/knock doesn't mean the hierarchy that already loaded
            // can't be searched, so it must not hide scoped search results.
            <p className="px-3 py-2 text-sm text-destructive">{spaceError}</p>
          ) : isSearching ? (
            searchResults.length === 0 && unjoinedHierarchyMatches.length === 0 ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">No matching rooms</p>
            ) : (
              <div className="flex flex-col gap-0.5">
                {renderSearchResults(searchResults)}
                {unjoinedHierarchyMatches.map((child) => (
                  <HierarchyRow
                    key={child.room_id}
                    child={child}
                    joinedRoom={undefined}
                    depth={0}
                    active={false}
                    pending={pendingRoomId === child.room_id}
                    onSelectRoom={onSelectRoom}
                    onSelectSpace={onSelectSpace}
                    onJoin={handleJoin}
                  />
                ))}
              </div>
            )
          ) : !spaceError && allEmpty && (mode !== "space" || visibleHierarchyCount === 0) ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              {unreadOnly
                ? mode === "dms"
                  ? "No unread direct messages"
                  : "No unread rooms"
                : mode === "dms"
                  ? "No direct messages yet"
                  : "No rooms yet"}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {inviteError && <p className="px-3 py-2 text-sm text-destructive">{inviteError}</p>}
              {(spaceError || joinError) && (
                <p className="px-3 py-2 text-sm text-destructive">{spaceError ?? joinError}</p>
              )}
              {removeError && (
                <p role="alert" className="px-3 py-2 text-sm text-destructive">
                  {removeError}
                </p>
              )}
              <RoomListSection
                title="Invites"
                count={invitedRooms.length}
                expanded={isExpanded("invites")}
                onExpandedChange={(v) => setExpanded((prev) => ({ ...prev, invites: v }))}
              >
                {invitedRooms.map((room) => (
                  <RoomInviteItem
                    key={room.room_id}
                    room={room}
                    pending={pendingInviteRoomId === room.room_id}
                    onAccept={() => handleInviteAction(room.room_id, onAcceptInvite)}
                    onDecline={() => handleInviteAction(room.room_id, onDeclineInvite)}
                  />
                ))}
              </RoomListSection>
              <RoomListSection
                title="Favourites"
                count={sections.favourites.length}
                expanded={isExpanded("favourites")}
                onExpandedChange={(v) => setExpanded((prev) => ({ ...prev, favourites: v }))}
              >
                {renderSectionRooms(sections.favourites, fullFavouriteSectionRooms)}
              </RoomListSection>

              {mode === "space" && selectedSpace ? (
                <RoomListSection
                  title="Space rooms"
                  count={visibleHierarchyCount}
                  expanded={isExpanded("spaceRooms")}
                  onExpandedChange={(v) => setExpanded((prev) => ({ ...prev, spaceRooms: v }))}
                >
                  {renderHierarchy(
                    filteredSpaceHierarchy,
                    {
                      roomById,
                      activeRoomId,
                      onSelectRoom,
                      onSelectSpace,
                      onJoin: handleJoin,
                      pendingRoomId,
                      spaceManagementEnabled: spaceRailManagementEnabled,
                      onRemoved: refetchSpaceHierarchy,
                      onRemoveError: setRemoveError,
                      typingRoomIds: roomListTypingFlagEnabled ? typingRoomIds : EMPTY_TYPING_IDS,
                    },
                    selectedSpace.room_id,
                  )}
                </RoomListSection>
              ) : (
                sections.spaceGroups.map(({ space, rooms: spaceRooms }) => {
                  const fullSpaceRooms =
                    fullSections.spaceGroups.find((group) => group.space.room_id === space.room_id)
                      ?.rooms ?? spaceRooms;
                  return (
                    <RoomListSection
                      key={space.room_id}
                      title={displayName(space.room_id, space.name)}
                      count={spaceRooms.length}
                      expanded={isExpanded(space.room_id)}
                      onExpandedChange={(v) =>
                        setExpanded((prev) => ({ ...prev, [space.room_id]: v }))
                      }
                    >
                      {renderSectionRooms(spaceRooms, fullSpaceRooms)}
                    </RoomListSection>
                  );
                })
              )}

              <RoomListSection
                title={mode === "home" && showAllRooms ? "All rooms" : "Rooms"}
                count={roomSectionRooms.length}
                expanded={isExpanded("rooms")}
                onExpandedChange={(v) => setExpanded((prev) => ({ ...prev, rooms: v }))}
              >
                {renderSectionRooms(roomSectionRooms, fullRoomSectionRooms)}
              </RoomListSection>

              <RoomListSection
                title="Low priority"
                count={sections.lowPriority.length}
                expanded={isExpanded("lowPriority")}
                onExpandedChange={(v) => setExpanded((prev) => ({ ...prev, lowPriority: v }))}
              >
                {renderSectionRooms(sections.lowPriority, fullLowPrioritySectionRooms)}
              </RoomListSection>
            </div>
          )}
        </div>
      </aside>
    </TooltipProvider>
  );
}

function getScopedRooms({
  rooms,
  mode,
  selectedSpace,
  showAllRooms,
  hierarchy,
}: {
  rooms: RoomSummary[];
  mode: RoomListMode;
  selectedSpace: RoomSummary | null;
  showAllRooms: boolean;
  hierarchy: SpaceHierarchyNode[];
}) {
  if (mode === "dms") {
    return rooms.filter((room) => room.is_direct);
  }
  if (mode === "space" && selectedSpace) {
    const descendantIds = new Set(flattenHierarchy(hierarchy).map((node) => node.child.room_id));
    return rooms.filter(
      (room) => !room.is_space && !room.is_direct && descendantIds.has(room.room_id),
    );
  }
  if (showAllRooms) {
    return rooms.filter((room) => !room.is_space && !room.is_direct);
  }
  return rooms.filter(
    (room) => !room.is_space && !room.is_direct && room.parent_space_ids.length === 0,
  );
}

function flattenHierarchy(nodes: SpaceHierarchyNode[]): SpaceHierarchyNode[] {
  return nodes.flatMap((node) => [node, ...flattenHierarchy(node.children)]);
}

/** Maps every descendant room id in `nodes` to its immediate parent's id —
 * `parentId` is the id each top-level node in `nodes` is a direct child of. */
function hierarchyParentByRoomId(
  nodes: SpaceHierarchyNode[],
  parentId: string,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of nodes) {
    map.set(node.child.room_id, parentId);
    for (const [childId, childParentId] of hierarchyParentByRoomId(
      node.children,
      node.child.room_id,
    )) {
      map.set(childId, childParentId);
    }
  }
  return map;
}

function getFullSectionRooms(visibleSectionRooms: RoomSummary[], fullSectionRooms: RoomSummary[]) {
  const visibleRoomIds = new Set(visibleSectionRooms.map((room) => room.room_id));
  return fullSectionRooms.filter((room) => visibleRoomIds.has(room.room_id));
}

function countVisibleHierarchyNodes(
  nodes: SpaceHierarchyNode[],
  roomById: Map<string, RoomSummary>,
): number {
  return nodes.reduce((count, node) => {
    const joinedRoom = roomById.get(node.child.room_id);
    if (isHiddenHierarchyRoom(joinedRoom)) return count;
    return count + 1 + countVisibleHierarchyNodes(node.children, roomById);
  }, 0);
}

function renderHierarchy(
  nodes: SpaceHierarchyNode[],
  options: {
    roomById: Map<string, RoomSummary>;
    activeRoomId: string | null;
    onSelectRoom: (id: string) => void;
    onSelectSpace: (id: string) => void;
    onJoin: (child: SpaceChild) => void;
    pendingRoomId: string | null;
    /** Enables the "Remove from space" row action — the same
     * `space_rail_management` flag `SpaceRail`'s own management actions are
     * gated behind, since this is the counterpart to its `Remove` for
     * sub-space rows. */
    spaceManagementEnabled: boolean;
    /** Called after a successful removal — `spaceHierarchy` is a point-in-time
     * snapshot Matrix sync doesn't keep current, so the caller needs to
     * explicitly refetch it for the removed row to disappear immediately. */
    onRemoved: () => void;
    /** Called with a message when a removal is rejected (e.g. missing power
     * level) — this action isn't power-level-gated in the UI, so a rejection
     * is a normal reachable outcome that needs to be visible. */
    onRemoveError: (message: string) => void;
    typingRoomIds: Set<string>;
  },
  /** The id of the space each node in `nodes` is a direct child of — root
   * spaces are children of the currently selected space; recursing into a
   * node's own `children` passes that node's own room id down, so `Remove
   * from space` always detaches from the row's *actual* immediate parent,
   * not the top-level selected space. */
  parentSpaceId: string,
  depth = 0,
  path = "root",
): ReactElement[] {
  return nodes.flatMap((node, index) => {
    const joinedRoom = options.roomById.get(node.child.room_id);
    if (isHiddenHierarchyRoom(joinedRoom)) return [];
    const nodeKey = `${path}/${index}:${node.child.room_id}`;
    return [
      <HierarchyRow
        key={nodeKey}
        child={node.child}
        joinedRoom={joinedRoom}
        depth={depth}
        active={node.child.room_id === options.activeRoomId}
        pending={options.pendingRoomId === node.child.room_id}
        isTyping={options.typingRoomIds.has(node.child.room_id)}
        onSelectRoom={options.onSelectRoom}
        onSelectSpace={options.onSelectSpace}
        onJoin={options.onJoin}
        onRemoveFromSpace={
          options.spaceManagementEnabled && !node.child.is_space
            ? () =>
                removeSpaceChild(parentSpaceId, node.child.room_id)
                  .then(options.onRemoved)
                  .catch((err) =>
                    options.onRemoveError(err instanceof Error ? err.message : String(err)),
                  )
            : undefined
        }
        removeFromSpaceTargetId={
          options.spaceManagementEnabled && !node.child.is_space ? parentSpaceId : undefined
        }
      />,
      ...renderHierarchy(node.children, options, node.child.room_id, depth + 1, nodeKey),
    ];
  });
}

function isHiddenHierarchyRoom(room: RoomSummary | undefined) {
  return room?.is_direct === true || isTaggedNonSpaceRoom(room);
}

function isTaggedNonSpaceRoom(room: RoomSummary | undefined) {
  return room?.is_space !== true && (room?.is_favourite === true || room?.is_low_priority === true);
}

function hasSameRoomOrder(visibleRooms: RoomSummary[], fullSectionRooms: RoomSummary[]) {
  return (
    visibleRooms.length === fullSectionRooms.length &&
    visibleRooms.every((room, index) => room.room_id === fullSectionRooms[index]?.room_id)
  );
}

interface HierarchyRowProps {
  child: SpaceChild;
  joinedRoom: RoomSummary | undefined;
  depth: number;
  active: boolean;
  pending: boolean;
  isTyping?: boolean;
  onSelectRoom: (id: string) => void;
  onSelectSpace: (id: string) => void;
  onJoin: (child: SpaceChild) => void;
  onRemoveFromSpace?: () => void;
  removeFromSpaceTargetId?: string;
}

function HierarchyRow({
  child,
  joinedRoom,
  depth,
  active,
  pending,
  isTyping = false,
  onSelectRoom,
  onSelectSpace,
  onJoin,
  onRemoveFromSpace,
  removeFromSpaceTargetId,
}: HierarchyRowProps) {
  const indent = `${Math.min(depth, 6) * 16}px`;
  if (joinedRoom?.is_space) {
    return (
      <div style={{ paddingLeft: indent }}>
        <button
          type="button"
          className="flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-accent hover:text-accent-foreground"
          onClick={() => onSelectSpace(joinedRoom.room_id)}
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">
              {displayName(joinedRoom.room_id, joinedRoom.name)}
            </p>
            {child.topic && <p className="truncate text-xs text-muted-foreground">{child.topic}</p>}
          </div>
          <span className="text-xs font-medium text-muted-foreground">Open</span>
        </button>
      </div>
    );
  }
  if (joinedRoom && !joinedRoom.is_space) {
    return (
      <div style={{ paddingLeft: indent }}>
        <RoomListItem
          room={joinedRoom}
          active={active}
          isTyping={isTyping}
          onSelect={() => onSelectRoom(joinedRoom.room_id)}
          onToggleFavourite={() =>
            setRoomFavourite(joinedRoom.room_id, !joinedRoom.is_favourite).catch(logAndIgnore)
          }
          onToggleLowPriority={() =>
            setRoomLowPriority(joinedRoom.room_id, !joinedRoom.is_low_priority).catch(logAndIgnore)
          }
          onToggleMuted={
            isWebBuild()
              ? undefined
              : () => setRoomMuted(joinedRoom.room_id, !joinedRoom.is_muted).catch(logAndIgnore)
          }
          onMarkRead={() => markRoomRead(joinedRoom.room_id).catch(logAndIgnore)}
          onMarkUnread={() => setRoomMarkedUnread(joinedRoom.room_id, true).catch(logAndIgnore)}
          onRemoveFromSpace={onRemoveFromSpace}
          removeFromSpaceTargetId={removeFromSpaceTargetId}
        />
      </div>
    );
  }
  return (
    <div style={{ paddingLeft: indent }}>
      <div className="flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-left">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {child.name ?? child.room_id}
          </p>
          {child.topic && <p className="truncate text-xs text-muted-foreground">{child.topic}</p>}
        </div>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => onJoin(child)}>
          {child.join_rule === "knock" ? "Request" : "Join"}
        </Button>
      </div>
    </div>
  );
}

interface DraggableRoomRowProps {
  room: RoomSummary;
  index: number;
  sectionRooms: RoomSummary[];
  canReorder: boolean;
  /** Measured row heights by room id — see `rowHeightsRef`'s doc comment. */
  rowHeights: Map<string, number>;
  active: boolean;
  isTyping?: boolean;
  onSelect: () => void;
  onReorder: (targetIndex: number) => void;
  onRemoveFromSpace?: () => void;
  removeFromSpaceTargetId?: string;
}

function DraggableRoomRow({
  room,
  index,
  sectionRooms,
  canReorder,
  rowHeights,
  active,
  isTyping = false,
  onSelect,
  onReorder,
  onRemoveFromSpace,
  removeFromSpaceTargetId,
}: DraggableRoomRowProps) {
  const [dragOffset, setDragOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

  const bind = useDrag(
    ({ movement: [, my], down }) => {
      if (!canReorder) return;
      setDragging(down);
      setDragOffset(down ? my : 0);
      if (!down) {
        const targetIndex = targetIndexFromMeasuredHeights(sectionRooms, index, my, rowHeights);
        const clamped = Math.max(0, Math.min(targetIndex, sectionRooms.length - 1));
        if (clamped !== index) {
          onReorder(clamped);
        }
      }
    },
    {
      axis: "y",
      filterTaps: true,
      enabled: canReorder,
    },
  );

  // A `ResizeObserver`, not a one-shot read, because this ref callback's
  // own identity is stable across re-renders (see `dragHandleProps` below)
  // so React won't re-invoke it when only the row's rendered *content*
  // changes — e.g. a `last_message_preview` arriving asynchronously and
  // adding a second line of text (Codex review on #288, P2). The observer
  // keeps `rowHeights` current regardless of what caused the resize.
  const measureRow = useCallback(
    (node: HTMLElement | null) => {
      if (!node) return undefined;
      rowHeights.set(room.room_id, node.getBoundingClientRect().height);
      const observer = new ResizeObserver(() => {
        rowHeights.set(room.room_id, node.getBoundingClientRect().height);
      });
      observer.observe(node);
      return () => observer.disconnect();
    },
    [room.room_id, rowHeights],
  );

  // Memoized so `RoomListItem`'s memo comparator (which checks these by
  // reference) can actually skip a re-render when nothing relevant changed
  // (Codex review on #288, P2) — an inline object literal here would be a
  // fresh reference on every `RoomList` render regardless, defeating that
  // comparator for every row in the main, non-virtualized list.
  //
  // `bind` deliberately excluded from the deps array (Sentry review on
  // #288): `useDrag` returns a *new* bound function every render
  // (`ctrl.bind.bind(ctrl)` in `@use-gesture/react`'s `useRecognizers`), so
  // including it here would recompute this memo — and therefore defeat the
  // downstream `React.memo` — on every single render, exactly the bug this
  // memoization exists to prevent. `canReorder` (the one config value that
  // actually varies — `axis`/`filterTaps` below are fixed literals) stands
  // in for it instead: the gesture handler itself always dispatches through
  // the same persistent `Controller` instance regardless of which render's
  // `bind()` produced the specific function in hand (`ctrl.applyHandlers`/
  // `ctrl.applyConfig` re-apply this render's closure unconditionally,
  // before `useRecognizers` ever returns), so a "stale" handler is still
  // behaviorally current — but `bind()`'s *returned props themselves* can
  // embed config-derived values (the mocked `data-reorder-enabled` in
  // `RoomList.test.tsx` stands in for this; verified against a regression
  // there), which a reused call would freeze at whatever `canReorder` was
  // on the render that produced it. Recomputing only when `canReorder`
  // itself changes keeps both correct: memoized across unrelated
  // re-renders, refreshed exactly when the value it's derived from does.
  const dragHandleProps = useMemo(
    () => ({ ...bind(), ref: measureRow }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `bind` deliberately omitted, see comment above
    [canReorder, measureRow],
  );
  const style = useMemo(
    () => ({
      transform: dragging ? `translateY(${dragOffset}px)` : undefined,
      position: dragging ? ("relative" as const) : undefined,
      zIndex: dragging ? 10 : undefined,
      // Only opt out of touch scrolling while a drag is actually in
      // progress — applying this unconditionally would swallow a normal
      // vertical scroll gesture that merely starts on a room row.
      touchAction: dragging ? "none" : undefined,
    }),
    [dragging, dragOffset],
  );

  return (
    <RoomListItem
      room={room}
      active={active}
      isTyping={isTyping}
      onSelect={onSelect}
      onToggleFavourite={() =>
        setRoomFavourite(room.room_id, !room.is_favourite).catch(logAndIgnore)
      }
      onToggleLowPriority={() =>
        setRoomLowPriority(room.room_id, !room.is_low_priority).catch(logAndIgnore)
      }
      onToggleMuted={
        isWebBuild()
          ? undefined
          : () => setRoomMuted(room.room_id, !room.is_muted).catch(logAndIgnore)
      }
      onMarkRead={() => markRoomRead(room.room_id).catch(logAndIgnore)}
      onMarkUnread={() => setRoomMarkedUnread(room.room_id, true).catch(logAndIgnore)}
      onRemoveFromSpace={onRemoveFromSpace}
      removeFromSpaceTargetId={removeFromSpaceTargetId}
      dragHandleProps={dragHandleProps}
      style={style}
    />
  );
}
