import type { RoomSummary } from "@/lib/matrix";
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
