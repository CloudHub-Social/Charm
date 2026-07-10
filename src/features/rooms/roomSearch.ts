import type { RoomSummary, SpaceChild } from "@/lib/matrix";
import { displayName } from "./roomDisplay";

/**
 * Case-insensitive substring match against a room's resolved display name
 * (`displayName` — currently just `name ?? roomId`) or its raw room id, so
 * a matrix.to-style id still finds something even for an unnamed room. An
 * empty/whitespace-only query matches everything, so callers don't need a
 * separate "is search active" branch purely to skip filtering.
 */
export function filterRoomsByQuery(rooms: RoomSummary[], query: string): RoomSummary[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return rooms;
  return rooms.filter((room) => {
    const name = displayName(room.room_id, room.name).toLowerCase();
    return name.includes(trimmed) || room.room_id.toLowerCase().includes(trimmed);
  });
}

/**
 * Same matching rule as `filterRoomsByQuery`, but for `SpaceChild` — the
 * shape returned by the `/hierarchy` endpoint for a space's children that
 * the user hasn't joined yet, which never show up in `rooms`/`RoomSummary`.
 * Without this, searching a space you're browsing (but not a member of)
 * would report "No matching rooms" for a child that's plainly visible right
 * below in the unsearched hierarchy view.
 */
export function filterSpaceChildrenByQuery(children: SpaceChild[], query: string): SpaceChild[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return children;
  return children.filter((child) => {
    const name = (child.name ?? child.room_id).toLowerCase();
    return name.includes(trimmed) || child.room_id.toLowerCase().includes(trimmed);
  });
}
