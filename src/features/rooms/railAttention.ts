import type { RoomSummary } from "@/lib/matrix";

export const MAX_VISIBLE_RAIL_DMS = 3;

/** One account-scoped direct-message shortcut rendered in the application rail. */
export interface RailAttentionItem {
  kind: "direct_message";
  room: RoomSummary;
  unread: number;
  highlight: number;
  lastActivityTs: number | null;
}

export interface RailAttentionState {
  visibleItems: RailAttentionItem[];
  /** Number of unread DM conversations not already represented by a visible avatar. */
  overflowUnread: number;
  /** Highlight count belonging only to overflow conversations. */
  overflowHighlight: number;
}

export interface RailAttentionOptions {
  activeRoomId?: string | null;
  visibleLimit?: number;
}

function toRailAttentionItem(room: RoomSummary): RailAttentionItem {
  return {
    kind: "direct_message",
    room,
    unread: room.has_unread ? 1 : 0,
    highlight: room.unread_count,
    lastActivityTs: room.last_activity_ts,
  };
}

/**
 * Produces the non-duplicating DM rail model from one account's room snapshot.
 * Recent activity wins; equal or missing timestamps preserve the authoritative
 * room-list order so the shortcuts do not jump around on unrelated renders.
 */
export function deriveRailAttention(
  rooms: RoomSummary[],
  { activeRoomId = null, visibleLimit = MAX_VISIBLE_RAIL_DMS }: RailAttentionOptions = {},
): RailAttentionState {
  const unreadRooms = rooms
    .map((room, index) => ({ room, index }))
    .filter(({ room }) => room.is_direct && !room.is_space && room.has_unread)
    .toSorted((a, b) => {
      const aTimestamp = a.room.last_activity_ts;
      const bTimestamp = b.room.last_activity_ts;
      if (aTimestamp === bTimestamp) return a.index - b.index;
      if (aTimestamp === null) return 1;
      if (bTimestamp === null) return -1;
      return bTimestamp - aTimestamp;
    });
  const activeRoom = rooms.find(
    (room) => room.room_id === activeRoomId && room.is_direct && !room.is_space,
  );
  const orderedRooms = activeRoom
    ? [activeRoom, ...unreadRooms.map(({ room }) => room).filter((room) => room !== activeRoom)]
    : unreadRooms.map(({ room }) => room);
  const limit = Math.max(0, visibleLimit);
  const visibleRooms = orderedRooms.slice(0, limit);
  const visibleRoomIds = new Set(visibleRooms.map((room) => room.room_id));
  const overflowRooms = unreadRooms
    .map(({ room }) => room)
    .filter((room) => !visibleRoomIds.has(room.room_id));

  return {
    visibleItems: visibleRooms.map(toRailAttentionItem),
    overflowUnread: overflowRooms.length,
    overflowHighlight: overflowRooms.reduce((sum, room) => sum + room.unread_count, 0),
  };
}
