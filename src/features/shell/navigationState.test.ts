import { describe, expect, it } from "vitest";
import {
  clampRoomSidebarWidth,
  MAX_ROOM_SIDEBAR_WIDTH,
  MIN_ROOM_SIDEBAR_WIDTH,
} from "./navigationState";

describe("clampRoomSidebarWidth", () => {
  it("keeps device-local pane sizing within usable bounds", () => {
    expect(clampRoomSidebarWidth(100)).toBe(MIN_ROOM_SIDEBAR_WIDTH);
    expect(clampRoomSidebarWidth(301.6)).toBe(302);
    expect(clampRoomSidebarWidth(900)).toBe(MAX_ROOM_SIDEBAR_WIDTH);
  });
});
