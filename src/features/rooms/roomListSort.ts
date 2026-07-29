import type { RoomSummary } from "@/lib/matrix";
import type { RoomListMode } from "./SpaceRail";
import { displayName } from "./roomDisplay";

export type RoomListSort = "default" | "az" | "unread" | "activity";
export type RoomListSortPreferences = Record<RoomListMode, RoomListSort>;

export const ROOM_LIST_SORT_STORAGE_KEY = "charm:room-list-sort";

const DEFAULT_SORTS: RoomListSortPreferences = {
  home: "default",
  dms: "default",
  space: "default",
};

const SORT_VALUES: RoomListSort[] = ["default", "az", "unread", "activity"];

function isRoomListSort(value: unknown): value is RoomListSort {
  return typeof value === "string" && SORT_VALUES.includes(value as RoomListSort);
}

/** Reads the install-local sort choices, mirroring `roomListFilter.ts`'s
 * per-list-mode persistence so sorting DMs doesn't unexpectedly resort Home. */
export function readRoomListSorts(): RoomListSortPreferences {
  if (typeof window === "undefined") return { ...DEFAULT_SORTS };
  try {
    const raw = window.localStorage.getItem(ROOM_LIST_SORT_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SORTS };
    const parsed = JSON.parse(raw) as Partial<Record<RoomListMode, unknown>>;
    return {
      home: isRoomListSort(parsed.home) ? parsed.home : "default",
      dms: isRoomListSort(parsed.dms) ? parsed.dms : "default",
      space: isRoomListSort(parsed.space) ? parsed.space : "default",
    };
  } catch {
    return { ...DEFAULT_SORTS };
  }
}

/** Best-effort local persistence; a storage failure must not break navigation. */
export function persistRoomListSorts(sorts: RoomListSortPreferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ROOM_LIST_SORT_STORAGE_KEY, JSON.stringify(sorts));
  } catch {
    // The in-memory choice still works for this session.
  }
}

/**
 * Reorders `rooms` per `sort` — applied per-section (Favourites, a space
 * group, plain Rooms, Low priority) by `RoomList.tsx`, never across
 * sections, so a sort choice can't move a room out of its favourite/
 * low-priority/space grouping.
 *
 * "default" is a no-op: the Rust backend already orders by
 * (section, manual_order, name) — see `rooms.rs`'s `snapshot_rooms` doc
 * comment — so this preserves that order exactly, including manual
 * drag-reorder positions.
 *
 * "activity" sorts by `last_activity_ts` descending (most recent first);
 * a room with no known timestamp yet (activity sort just turned on, or
 * nothing computed) sorts after every room that has one, in the
 * pre-existing default order among themselves.
 */
export function sortRoomsForDisplay(rooms: RoomSummary[], sort: RoomListSort): RoomSummary[] {
  if (sort === "default") return rooms;
  if (sort === "az") {
    return [...rooms].sort((a, b) =>
      displayName(a.room_id, a.name).localeCompare(displayName(b.room_id, b.name)),
    );
  }
  if (sort === "unread") {
    return stableSortByKey(rooms, (room) => (room.has_unread ? 0 : 1));
  }
  return stableSortByKey(rooms, (room) => -(room.last_activity_ts ?? -1));
}

/** A stable sort by a numeric key — smaller sorts first — preserving the
 * relative order of rooms with equal keys (native `Array.prototype.sort` is
 * stable per spec, but the comparator itself must not collapse to 0 for
 * unequal inputs it doesn't care about, which this helper guarantees). */
function stableSortByKey<T>(items: T[], key: (item: T) => number): T[] {
  return [...items].sort((a, b) => key(a) - key(b));
}
