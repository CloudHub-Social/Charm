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
 * Computes the `TagInfo.order` midpoint for a drag-reorder within a section
 * that already has at least one real `manual_order` value: given the
 * section's rooms *excluding* the dragged one, and the index it's being
 * dropped at, derive a fractional-index value between its new neighbours.
 * A `null` neighbour falls back to its array position as an anchor.
 *
 * This alone is **not** safe to use for a still-fully-alphabetical section
 * (every room's `manual_order` is `null`): the Rust comparator sorts any
 * concrete `Some(order)` ahead of every `null`, so giving *only* the dragged
 * room a number — regardless of what that number is — makes it jump to the
 * top of the section instead of landing at the drop position among its
 * still-`null` siblings. [`planManualReorder`] handles that case by seeding
 * the whole section at once; use this directly only when the section is
 * already in numeric-order mode.
 */
export function computeManualOrder(
  sectionRoomsExcludingDragged: RoomSummary[],
  targetIndex: number,
): number {
  const clampedIndex = Math.max(0, Math.min(targetIndex, sectionRoomsExcludingDragged.length));
  const effectiveOrder = (index: number) =>
    sectionRoomsExcludingDragged[index]?.manual_order ?? index;

  const before = clampedIndex > 0 ? effectiveOrder(clampedIndex - 1) : null;
  const after =
    clampedIndex < sectionRoomsExcludingDragged.length ? effectiveOrder(clampedIndex) : null;

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

/**
 * Plans the `setRoomManualOrder` calls a drag-reorder needs to persist the
 * drop position — see Spec 06's manual-order acceptance criterion.
 *
 * If every room in the section (the dragged one included) still has
 * `manual_order: null`, a single new order on just the dragged room can't
 * express "insert here": any `Some(order)` sorts ahead of every `null` in
 * the Rust comparator, so the dragged room would jump to the top of the
 * section instead of landing at the drop position. In that case this seeds
 * **the whole section** with sequential integer orders reflecting the
 * post-drop visual order, atomically switching the section from
 * alphabetical to numeric ordering.
 *
 * Otherwise (the section already has at least one real `manual_order`) a
 * single midpoint update via [`computeManualOrder`] is sufficient.
 */
export function planManualReorder(
  sectionRooms: RoomSummary[],
  draggedRoomId: string,
  targetIndex: number,
): { room_id: string; order: number }[] {
  const dragged = sectionRooms.find((room) => room.room_id === draggedRoomId);
  const others = sectionRooms.filter((room) => room.room_id !== draggedRoomId);
  if (!dragged) return [];

  const allUnordered = sectionRooms.every((room) => room.manual_order === null);
  if (allUnordered) {
    const clampedIndex = Math.max(0, Math.min(targetIndex, others.length));
    const reordered = [...others.slice(0, clampedIndex), dragged, ...others.slice(clampedIndex)];
    return reordered.map((room, index) => ({ room_id: room.room_id, order: index }));
  }

  return [{ room_id: draggedRoomId, order: computeManualOrder(others, targetIndex) }];
}

// Matches RoomListItem's `min-h-11` (2.75rem) row height plus its `gap-0.5`
// spacing — the fallback used below for a row not measured yet (e.g. one
// that just mounted).
const ROW_HEIGHT_PX = 46;

/**
 * Walks from `index` toward the drag's direction, summing each row's actual
 * measured height (falling back to `ROW_HEIGHT_PX`) until half of the *next*
 * row's height has been crossed — i.e. snaps to whichever row boundary the
 * drag has passed the midpoint of. Rows aren't all the same height (the
 * message-preview flag grows some rows a second text line), so a fixed-
 * height division would round to the wrong row; this measures each row
 * instead.
 */
export function targetIndexFromMeasuredHeights(
  sectionRooms: RoomSummary[],
  index: number,
  my: number,
  rowHeights: Map<string, number>,
): number {
  const heightAt = (i: number) => rowHeights.get(sectionRooms[i]?.room_id ?? "") ?? ROW_HEIGHT_PX;
  let target = index;
  let remaining = my;
  if (my > 0) {
    while (target < sectionRooms.length - 1) {
      const h = heightAt(target);
      if (remaining < h / 2) break;
      remaining -= h;
      target += 1;
    }
  } else if (my < 0) {
    while (target > 0) {
      const h = heightAt(target - 1);
      if (-remaining < h / 2) break;
      remaining += h;
      target -= 1;
    }
  }
  return target;
}
