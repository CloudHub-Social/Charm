import { describe, expect, it } from "vitest";
import { makeRoomSummary } from "@/features/rooms/testFixtures";
import { activityAttentionCount, activityRooms } from "./activityModel";

describe("activityModel", () => {
  it("excludes spaces and quiet rooms while counting marked-unread rooms once", () => {
    const rooms = [
      makeRoomSummary({ room_id: "!space:test", is_space: true, unread_count: 9 }),
      makeRoomSummary({ room_id: "!quiet:test" }),
      makeRoomSummary({ room_id: "!marked:test", is_marked_unread: true }),
      makeRoomSummary({ room_id: "!unread:test", unread_count: 4 }),
      makeRoomSummary({ room_id: "!invite:test", membership: "invite" }),
    ];

    expect(activityRooms(rooms).map((room) => room.room_id)).toEqual([
      "!invite:test",
      "!marked:test",
      "!unread:test",
    ]);
    expect(activityAttentionCount(rooms)).toBe(6);
  });
});
