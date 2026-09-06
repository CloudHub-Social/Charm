import type { RoomSummary } from "@/lib/matrix";

export function isActivityRoom(room: RoomSummary): boolean {
  return (
    !room.is_space &&
    (room.membership === "invite" || room.unread_count > 0 || room.is_marked_unread)
  );
}

export function activityAttentionCount(rooms: readonly RoomSummary[]): number {
  return rooms.reduce((total, room) => {
    if (!isActivityRoom(room)) return total;
    if (room.membership === "invite") return total + 1;
    return total + Math.max(1, room.unread_count);
  }, 0);
}

export function activityRooms(rooms: readonly RoomSummary[]): RoomSummary[] {
  return rooms.filter(isActivityRoom).sort((a, b) => {
    if (a.membership !== b.membership) return a.membership === "invite" ? -1 : 1;
    return (b.last_activity_ts ?? 0) - (a.last_activity_ts ?? 0);
  });
}
