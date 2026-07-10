import { useAtomValue } from "jotai";
import { useDrag } from "@use-gesture/react";
import { SettingsIcon } from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { PresenceDot } from "@/features/presence/PresenceDot";
import { useOwnProfile } from "@/features/profile/useOwnProfile";
import { useSettingsNavigation } from "@/features/settings/useSettingsNavigation";
import { badgeAtom } from "@/features/shell/badgeAtom";
import {
  markRoomRead,
  joinRoom,
  knockRoom,
  listSpaceHierarchy,
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
import { RoomListSection } from "./SpaceSection";
import { groupRoomsIntoSections, planManualReorder } from "./roomSections";
import { avatarColor, displayName, initials, resolveAvatar } from "./roomDisplay";
import { logAndIgnore } from "@/lib/logAndIgnore";
import type { RoomListMode } from "./SpaceRail";

interface RoomListProps {
  rooms: RoomSummary[];
  activeRoomId: string | null;
  onSelectRoom: (id: string) => void;
  onSelectSpace: (id: string) => void;
  mode: RoomListMode;
  selectedSpace: RoomSummary | null;
  showAllRooms: boolean;
  onShowAllRoomsChange: (showAll: boolean) => void;
}

// Matches RoomListItem's `min-h-11` (2.75rem) row height plus its `gap-0.5`
// spacing — used to translate a drag's pixel delta into a target index.
const ROW_HEIGHT_PX = 46;

function reorderWithin(sectionRooms: RoomSummary[], roomId: string, targetIndex: number) {
  const updates = planManualReorder(sectionRooms, roomId, targetIndex);
  for (const { room_id, order } of updates) {
    setRoomManualOrder(room_id, order).catch(logAndIgnore);
  }
}

export function RoomList({
  rooms,
  activeRoomId,
  onSelectRoom,
  onSelectSpace,
  mode,
  selectedSpace,
  showAllRooms,
  onShowAllRoomsChange,
}: RoomListProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [spaceHierarchy, setSpaceHierarchy] = useState<SpaceHierarchyNode[]>([]);
  const [spaceLoading, setSpaceLoading] = useState(false);
  const [spaceError, setSpaceError] = useState<string | null>(null);
  const [pendingRoomId, setPendingRoomId] = useState<string | null>(null);
  const pendingJoinRoomIdRef = useRef<string | null>(null);
  const currentScopeRef = useRef({ mode, selectedSpaceId: selectedSpace?.room_id ?? null });
  const { data: ownProfile } = useOwnProfile();
  const { openSettings } = useSettingsNavigation();
  const badge = useAtomValue(badgeAtom);
  const selectedSpaceId = selectedSpace?.room_id ?? null;
  currentScopeRef.current = { mode, selectedSpaceId };

  const roomById = useMemo(() => new Map(rooms.map((room) => [room.room_id, room])), [rooms]);
  const visibleHierarchyCount = useMemo(
    () => countVisibleHierarchyNodes(spaceHierarchy, roomById),
    [spaceHierarchy, roomById],
  );
  const scopedRooms = useMemo(
    () => getScopedRooms({ rooms, mode, selectedSpace, showAllRooms, hierarchy: spaceHierarchy }),
    [rooms, mode, selectedSpace, showAllRooms, spaceHierarchy],
  );
  const sections = useMemo(() => groupRoomsIntoSections(scopedRooms), [scopedRooms]);
  const fullSections = useMemo(() => groupRoomsIntoSections(rooms), [rooms]);
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

  useEffect(() => {
    if (mode !== "space" || !selectedSpaceId) {
      setSpaceHierarchy([]);
      setSpaceError(null);
      setSpaceLoading(false);
      return undefined;
    }
    let stale = false;
    setSpaceLoading(true);
    setSpaceError(null);
    setSpaceHierarchy([]);
    listSpaceHierarchy(selectedSpaceId)
      .then((result) => {
        if (!stale) setSpaceHierarchy(result);
      })
      .catch((err) => {
        if (!stale) setSpaceError(String(err));
      })
      .finally(() => {
        if (!stale) setSpaceLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [mode, selectedSpaceId]);

  function isExpanded(key: string): boolean {
    return expanded[key] ?? true;
  }

  function renderSectionRooms(sectionRooms: RoomSummary[], fullSectionRooms = sectionRooms) {
    const canReorder = hasSameRoomOrder(sectionRooms, fullSectionRooms);
    return sectionRooms.map((room, index) => (
      <DraggableRoomRow
        key={room.room_id}
        room={room}
        index={index}
        sectionRooms={sectionRooms}
        canReorder={canReorder}
        active={room.room_id === activeRoomId}
        onSelect={() => onSelectRoom(room.room_id)}
        onReorder={(targetIndex) => reorderWithin(fullSectionRooms, room.room_id, targetIndex)}
      />
    ));
  }

  const allEmpty =
    sections.favourites.length === 0 &&
    sections.spaceGroups.length === 0 &&
    roomSectionRooms.length === 0 &&
    sections.lowPriority.length === 0;

  async function handleJoin(child: SpaceChild) {
    if (pendingJoinRoomIdRef.current) return;
    const requestScope = { mode, selectedSpaceId };
    pendingJoinRoomIdRef.current = child.room_id;
    setPendingRoomId(child.room_id);
    setSpaceError(null);
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
        setSpaceError(String(err));
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

  return (
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
          {badge && badge.total_unread > 0 && (
            <span
              className={cn(
                "flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[11px] font-bold",
                badge.total_highlight > 0
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground",
              )}
              aria-label={`${badge.total_unread} unread rooms${
                badge.total_highlight > 0 ? `, ${badge.total_highlight} mentions` : ""
              }`}
            >
              {badge.total_highlight > 0 ? badge.total_highlight : badge.total_unread}
            </span>
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
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {mode === "space" && !selectedSpace ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">Select a space.</p>
        ) : mode === "space" && spaceLoading ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">Loading space…</p>
        ) : !spaceError && allEmpty && (mode !== "space" || visibleHierarchyCount === 0) ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            {mode === "dms" ? "No direct messages yet" : "No rooms yet"}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {spaceError && <p className="px-3 py-2 text-sm text-destructive">{spaceError}</p>}
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
                {renderHierarchy(spaceHierarchy, {
                  roomById,
                  activeRoomId,
                  onSelectRoom,
                  onSelectSpace,
                  onJoin: handleJoin,
                  pendingRoomId,
                })}
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
  },
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
        onSelectRoom={options.onSelectRoom}
        onSelectSpace={options.onSelectSpace}
        onJoin={options.onJoin}
      />,
      ...renderHierarchy(node.children, options, depth + 1, nodeKey),
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
  onSelectRoom: (id: string) => void;
  onSelectSpace: (id: string) => void;
  onJoin: (child: SpaceChild) => void;
}

function HierarchyRow({
  child,
  joinedRoom,
  depth,
  active,
  pending,
  onSelectRoom,
  onSelectSpace,
  onJoin,
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
  active: boolean;
  onSelect: () => void;
  onReorder: (targetIndex: number) => void;
}

function DraggableRoomRow({
  room,
  index,
  sectionRooms,
  canReorder,
  active,
  onSelect,
  onReorder,
}: DraggableRoomRowProps) {
  const [dragOffset, setDragOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

  const bind = useDrag(
    ({ movement: [, my], down }) => {
      if (!canReorder) return;
      setDragging(down);
      setDragOffset(down ? my : 0);
      if (!down) {
        const targetIndex = Math.round(index + my / ROW_HEIGHT_PX);
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

  return (
    <RoomListItem
      room={room}
      active={active}
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
      dragHandleProps={bind()}
      style={{
        transform: dragging ? `translateY(${dragOffset}px)` : undefined,
        position: dragging ? "relative" : undefined,
        zIndex: dragging ? 10 : undefined,
        // Only opt out of touch scrolling while a drag is actually in
        // progress — applying this unconditionally would swallow a normal
        // vertical scroll gesture that merely starts on a room row.
        touchAction: dragging ? "none" : undefined,
      }}
    />
  );
}
