import { describe, expect, it } from "vitest";
import type { RoomSummary } from "@/lib/matrix";
import { filterRoomsByQuery } from "./roomSearch";

function room(overrides: Partial<RoomSummary> & { room_id: string }): RoomSummary {
  return {
    name: null,
    unread_count: 0,
    unread_messages: 0,
    is_marked_unread: false,
    is_muted: false,
    notification_mode: null,
    is_favourite: false,
    is_low_priority: false,
    manual_order: null,
    is_space: false,
    parent_space_ids: [],
    is_direct: false,
    has_unread: false,
    avatar_url: null,
    avatar_path: null,
    dm_peer_user_id: null,
    ...overrides,
  };
}

describe("filterRoomsByQuery", () => {
  const rooms = [
    room({ room_id: "!alpha:example.org", name: "Alpha Team" }),
    room({ room_id: "!beta:example.org", name: "Beta Squad" }),
    room({ room_id: "!gamma:example.org", name: null }),
  ];

  it("returns every room for an empty query", () => {
    expect(filterRoomsByQuery(rooms, "")).toEqual(rooms);
  });

  it("returns every room for a whitespace-only query", () => {
    expect(filterRoomsByQuery(rooms, "   ")).toEqual(rooms);
  });

  it("matches case-insensitively against the display name", () => {
    expect(filterRoomsByQuery(rooms, "alpha")).toEqual([rooms[0]]);
    expect(filterRoomsByQuery(rooms, "BETA")).toEqual([rooms[1]]);
  });

  it("matches a substring, not just a prefix", () => {
    expect(filterRoomsByQuery(rooms, "team")).toEqual([rooms[0]]);
  });

  it("falls back to matching the raw room id for an unnamed room", () => {
    expect(filterRoomsByQuery(rooms, "gamma")).toEqual([rooms[2]]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterRoomsByQuery(rooms, "nonexistent")).toEqual([]);
  });
});
