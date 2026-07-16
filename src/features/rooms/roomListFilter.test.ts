import { beforeEach, describe, expect, it } from "vitest";
import {
  persistRoomListFilters,
  readRoomListFilters,
  ROOM_LIST_FILTER_STORAGE_KEY,
} from "./roomListFilter";

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
