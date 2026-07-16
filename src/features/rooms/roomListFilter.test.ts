import { beforeEach, describe, expect, it } from "vitest";
import {
  filterHierarchyToUnread,
  persistRoomListFilters,
  readRoomListFilters,
  ROOM_LIST_FILTER_STORAGE_KEY,
} from "./roomListFilter";
import { makeRoomSummary } from "./testFixtures";

beforeEach(() => {
  localStorage.clear();
});

describe("room-list filter persistence", () => {
  it("defaults every list mode to all when storage is absent or malformed", () => {
    expect(readRoomListFilters()).toEqual({ home: "all", dms: "all", space: "all" });

    localStorage.setItem(ROOM_LIST_FILTER_STORAGE_KEY, "{not json");
    expect(readRoomListFilters()).toEqual({ home: "all", dms: "all", space: "all" });
  });

  it("round-trips valid choices and drops malformed fields independently", () => {
    persistRoomListFilters({ home: "unread", dms: "all", space: "unread" });
    expect(readRoomListFilters()).toEqual({ home: "unread", dms: "all", space: "unread" });

    localStorage.setItem(
      ROOM_LIST_FILTER_STORAGE_KEY,
      JSON.stringify({ home: "unexpected", dms: "unread", space: true }),
    );
    expect(readRoomListFilters()).toEqual({ home: "all", dms: "unread", space: "all" });
  });
});

describe("filterHierarchyToUnread", () => {
  it("retains an unjoined space ancestor that leads to a joined unread room", () => {
    const unreadRoom = makeRoomSummary({
      room_id: "!unread:localhost",
      has_unread: true,
    });
    const hierarchy = [
      {
        child: {
          room_id: "!unjoined-space:localhost",
          name: "Public space",
          topic: null,
          num_joined_members: 2,
          join_rule: "public" as const,
          is_space: true,
        },
        children: [
          {
            child: {
              room_id: unreadRoom.room_id,
              name: "Unread room",
              topic: null,
              num_joined_members: 2,
              join_rule: "invite" as const,
              is_space: false,
            },
            children: [],
          },
        ],
      },
    ];

    expect(
      filterHierarchyToUnread(hierarchy, new Map([[unreadRoom.room_id, unreadRoom]]), null),
    ).toEqual(hierarchy);
  });
});
