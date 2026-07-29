import { beforeEach, describe, expect, it } from "vitest";
import {
  persistRoomListSorts,
  readRoomListSorts,
  ROOM_LIST_SORT_STORAGE_KEY,
  sortRoomsForDisplay,
} from "./roomListSort";
import { makeRoomSummary } from "./testFixtures";

beforeEach(() => {
  localStorage.clear();
});

describe("room-list sort persistence", () => {
  it("defaults every list mode to default when storage is absent or malformed", () => {
    expect(readRoomListSorts()).toEqual({ home: "default", dms: "default", space: "default" });

    localStorage.setItem(ROOM_LIST_SORT_STORAGE_KEY, "{not json");
    expect(readRoomListSorts()).toEqual({ home: "default", dms: "default", space: "default" });
  });

  it("round-trips valid choices and drops malformed fields independently", () => {
    persistRoomListSorts({ home: "az", dms: "default", space: "activity" });
    expect(readRoomListSorts()).toEqual({ home: "az", dms: "default", space: "activity" });

    localStorage.setItem(
      ROOM_LIST_SORT_STORAGE_KEY,
      JSON.stringify({ home: "unexpected", dms: "unread", space: true }),
    );
    expect(readRoomListSorts()).toEqual({ home: "default", dms: "unread", space: "default" });
  });
});

describe("sortRoomsForDisplay", () => {
  const roomA = makeRoomSummary({
    room_id: "!a:localhost",
    name: "Bravo",
    has_unread: false,
    last_activity_ts: 100,
  });
  const roomB = makeRoomSummary({
    room_id: "!b:localhost",
    name: "Alpha",
    has_unread: true,
    last_activity_ts: 300,
  });
  const roomC = makeRoomSummary({
    room_id: "!c:localhost",
    name: "Charlie",
    has_unread: false,
    last_activity_ts: null,
  });

  it("leaves the input order untouched for default", () => {
    const rooms = [roomA, roomB, roomC];
    expect(sortRoomsForDisplay(rooms, "default")).toEqual(rooms);
  });

  it("sorts alphabetically by display name for az", () => {
    expect(sortRoomsForDisplay([roomA, roomB, roomC], "az").map((r) => r.room_id)).toEqual([
      "!b:localhost", // Alpha
      "!a:localhost", // Bravo
      "!c:localhost", // Charlie
    ]);
  });

  it("moves unread rooms first while keeping relative order for unread", () => {
    expect(sortRoomsForDisplay([roomA, roomB, roomC], "unread").map((r) => r.room_id)).toEqual([
      "!b:localhost",
      "!a:localhost",
      "!c:localhost",
    ]);
  });

  it("sorts by most-recent activity first, with unknown timestamps last for activity", () => {
    expect(sortRoomsForDisplay([roomA, roomB, roomC], "activity").map((r) => r.room_id)).toEqual([
      "!b:localhost", // 300
      "!a:localhost", // 100
      "!c:localhost", // null
    ]);
  });

  it("does not mutate the input array", () => {
    const rooms = [roomA, roomB, roomC];
    sortRoomsForDisplay(rooms, "az");
    expect(rooms).toEqual([roomA, roomB, roomC]);
  });
});
