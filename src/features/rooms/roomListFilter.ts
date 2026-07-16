import type { RoomSummary, SpaceHierarchyNode } from "@/lib/matrix";
import type { RoomListMode } from "./SpaceRail";

export type RoomListFilter = "all" | "unread";
export type RoomListFilterPreferences = Record<RoomListMode, RoomListFilter>;

export const ROOM_LIST_FILTER_STORAGE_KEY = "charm:room-list-filters";

const DEFAULT_FILTERS: RoomListFilterPreferences = {
  home: "all",
  dms: "all",
  space: "all",
};

function isRoomListFilter(value: unknown): value is RoomListFilter {
  return value === "all" || value === "unread";
}

/**
 * Reads the install-local filter choices. Each top-level list keeps its own
 * choice, so filtering DMs does not unexpectedly filter Home or every space.
 * Malformed or inaccessible storage fails back to the safe, unfiltered view.
 */
export function readRoomListFilters(): RoomListFilterPreferences {
  if (typeof window === "undefined") return { ...DEFAULT_FILTERS };
  try {
    const raw = window.localStorage.getItem(ROOM_LIST_FILTER_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_FILTERS };
    const parsed = JSON.parse(raw) as Partial<Record<RoomListMode, unknown>>;
    return {
      home: isRoomListFilter(parsed.home) ? parsed.home : "all",
      dms: isRoomListFilter(parsed.dms) ? parsed.dms : "all",
      space: isRoomListFilter(parsed.space) ? parsed.space : "all",
    };
  } catch {
    return { ...DEFAULT_FILTERS };
  }
}

/** Best-effort local persistence; a storage failure must not break navigation. */
export function persistRoomListFilters(filters: RoomListFilterPreferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ROOM_LIST_FILTER_STORAGE_KEY, JSON.stringify(filters));
  } catch {
    // The in-memory choice still works for this session.
  }
}

/** Uses RoomSummary.has_unread as the sole unread invariant, retaining the open room. */
export function filterRoomsToUnread(
  rooms: RoomSummary[],
  activeRoomId: string | null,
): RoomSummary[] {
  return rooms.filter((room) => room.has_unread || room.room_id === activeRoomId);
}

/**
 * Prunes a selected space's hierarchy to unread/open joined rooms. Ancestor
 * spaces stay visible when they lead to a retained descendant; unjoined rooms
 * have no local unread state and are omitted. The same hidden-room rules as
 * RoomList's normal hierarchy render keep counts and visible rows aligned.
 */
export function filterHierarchyToUnread(
  nodes: SpaceHierarchyNode[],
  roomById: Map<string, RoomSummary>,
  activeRoomId: string | null,
): SpaceHierarchyNode[] {
  return nodes.flatMap((node) => {
    const joinedRoom = roomById.get(node.child.room_id);
    if (!joinedRoom) return [];
    if (
      joinedRoom.is_direct ||
      (!joinedRoom.is_space && (joinedRoom.is_favourite || joinedRoom.is_low_priority))
    ) {
      return [];
    }

    const children = filterHierarchyToUnread(node.children, roomById, activeRoomId);
    const retainSelf = joinedRoom.has_unread || joinedRoom.room_id === activeRoomId;
    if (!retainSelf && children.length === 0) return [];

    return [{ ...node, children }];
  });
}
