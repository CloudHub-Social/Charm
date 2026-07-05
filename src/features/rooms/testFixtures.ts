import type { RoomSummary } from "@/lib/matrix";

/** Builds a fully-populated `RoomSummary` for tests, overriding only what a case cares about. */
export function makeRoomSummary(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    room_id: "!abc123:localhost",
    name: "general",
    unread_count: 0,
    unread_messages: 0,
    is_marked_unread: false,
    is_muted: false,
    is_favourite: false,
    is_low_priority: false,
    manual_order: null,
    is_space: false,
    parent_space_ids: [],
    is_direct: false,
    has_unread: false,
    ...overrides,
  };
}
