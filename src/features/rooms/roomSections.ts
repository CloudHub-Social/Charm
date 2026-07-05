import type { RoomSummary } from "@/lib/matrix";

export interface SpaceRoomGroup {
  space: RoomSummary;
  rooms: RoomSummary[];
}

export interface RoomSections {
  spaces: RoomSummary[];
  favourites: RoomSummary[];
  spaceGroups: SpaceRoomGroup[];
  rooms: RoomSummary[];
  lowPriority: RoomSummary[];
}

/**
 * Groups a pre-sorted (by the Rust backend) room list into the sections
 * `RoomList.tsx` renders: Favourites, one group per space, the plain "Rooms"
 * section, and Low priority — see Spec 06's "Ordering strategy". This never
 * re-sorts `rooms` — the Rust-provided order within each resulting group is
 * preserved, only grouped.
 */
export function groupRoomsIntoSections(rooms: RoomSummary[]): RoomSections {
  const spaces = rooms.filter((room) => room.is_space);
  const nonSpaceRooms = rooms.filter((room) => !room.is_space);

  const favourites = nonSpaceRooms.filter((room) => room.is_favourite);
  const lowPriority = nonSpaceRooms.filter((room) => room.is_low_priority && !room.is_favourite);

  const spaceGroups: SpaceRoomGroup[] = spaces
    .map((space) => ({
      space,
      rooms: nonSpaceRooms.filter(
        (room) =>
          !room.is_favourite &&
          !room.is_low_priority &&
          room.parent_space_ids.includes(space.room_id),
      ),
    }))
    .filter((group) => group.rooms.length > 0);

  const groupedRoomIds = new Set(spaceGroups.flatMap((group) => group.rooms.map((r) => r.room_id)));
  const plainRooms = nonSpaceRooms.filter(
    (room) => !room.is_favourite && !room.is_low_priority && !groupedRoomIds.has(room.room_id),
  );

  return { spaces, favourites, spaceGroups, rooms: plainRooms, lowPriority };
}

/**
 * Computes the `TagInfo.order` midpoint for a drag-reorder: given the
 * section's rooms *excluding* the dragged one, and the index it's being
 * dropped at, derive a fractional-index value between its new neighbours.
 * `manual_order: null` on a neighbour means "no order constraint on that
 * side yet" (untagged rooms sort alphabetically) — not an order of 0 — so
 * only a neighbour with a real value anchors that side.
 */
export function computeManualOrder(
  sectionRoomsExcludingDragged: RoomSummary[],
  targetIndex: number,
): number {
  const clampedIndex = Math.max(0, Math.min(targetIndex, sectionRoomsExcludingDragged.length));
  const before = sectionRoomsExcludingDragged[clampedIndex - 1]?.manual_order ?? null;
  const after = sectionRoomsExcludingDragged[clampedIndex]?.manual_order ?? null;

  if (before !== null && after !== null) {
    return (before + after) / 2;
  }
  if (before !== null) {
    return before + 1;
  }
  if (after !== null) {
    return after - 1;
  }
  return 0;
}
