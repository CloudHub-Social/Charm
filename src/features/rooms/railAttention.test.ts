import { describe, expect, it } from "vitest";
import { deriveRailAttention } from "./railAttention";
import { makeRoomSummary } from "./testFixtures";

function unreadDm(roomId: string, lastActivityTs: number | null, unreadCount = 0) {
  return makeRoomSummary({
    room_id: roomId,
    name: roomId,
    is_direct: true,
    has_unread: true,
    unread_count: unreadCount,
    last_activity_ts: lastActivityTs,
  });
}

describe("deriveRailAttention", () => {
  it("returns no shortcuts or overflow for an account without unread DMs", () => {
    expect(
      deriveRailAttention([
        makeRoomSummary({ room_id: "!read:example.org", is_direct: true }),
        makeRoomSummary({ room_id: "!room:example.org", has_unread: true }),
      ]),
    ).toEqual({ visibleItems: [], overflowUnread: 0, overflowHighlight: 0 });
  });

  it("orders shortcuts by recent activity and preserves stable order for missing timestamps", () => {
    const state = deriveRailAttention([
      unreadDm("!missing-a:example.org", null),
      unreadDm("!recent:example.org", 300),
      unreadDm("!older:example.org", 100),
      unreadDm("!missing-b:example.org", null),
    ]);

    expect(state.visibleItems.map((item) => item.room.room_id)).toEqual([
      "!recent:example.org",
      "!older:example.org",
      "!missing-a:example.org",
    ]);
  });

  it("counts only additional conversations and highlights in the DM overflow badge", () => {
    const state = deriveRailAttention([
      unreadDm("!one:example.org", 500, 1),
      unreadDm("!two:example.org", 400, 2),
      unreadDm("!three:example.org", 300, 3),
      unreadDm("!four:example.org", 200, 4),
      unreadDm("!five:example.org", 100, 5),
    ]);

    expect(state.visibleItems).toHaveLength(3);
    expect(state.overflowUnread).toBe(2);
    expect(state.overflowHighlight).toBe(9);
  });

  it("supports zero, one, and three visible shortcuts without overflow", () => {
    expect(deriveRailAttention([], { visibleLimit: 0 }).visibleItems).toHaveLength(0);
    expect(deriveRailAttention([unreadDm("!one:example.org", 1)]).overflowUnread).toBe(0);
    expect(
      deriveRailAttention([
        unreadDm("!one:example.org", 3),
        unreadDm("!two:example.org", 2),
        unreadDm("!three:example.org", 1),
      ]).overflowUnread,
    ).toBe(0);
  });

  it("keeps the active DM visible after reading it without adding it to overflow", () => {
    const activeRoom = makeRoomSummary({
      room_id: "!active:example.org",
      name: "Active",
      is_direct: true,
      has_unread: false,
    });
    const state = deriveRailAttention(
      [
        unreadDm("!one:example.org", 3),
        unreadDm("!two:example.org", 2),
        unreadDm("!three:example.org", 1),
        activeRoom,
      ],
      { activeRoomId: activeRoom.room_id },
    );

    expect(state.visibleItems.map((item) => item.room.room_id)).toEqual([
      activeRoom.room_id,
      "!one:example.org",
      "!two:example.org",
    ]);
    expect(state.visibleItems[0]?.unread).toBe(0);
    expect(state.overflowUnread).toBe(1);
  });
});
