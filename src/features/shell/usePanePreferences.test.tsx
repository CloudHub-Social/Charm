import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PANE_PREFERENCES } from "./navigationState";
import { usePanePreferences } from "./usePanePreferences";

const STORAGE_KEY = "charm:pane-preferences:v1";

describe("usePanePreferences", () => {
  beforeEach(() => localStorage.clear());

  it("ignores malformed and unknown persisted versions", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, roomSidebarWidth: 320 }));
    const { result } = renderHook(() => usePanePreferences());
    expect(result.current.preferences).toEqual(DEFAULT_PANE_PREFERENCES);
  });

  it("clamps and persists the device-local room sidebar width", () => {
    const { result } = renderHook(() => usePanePreferences());

    act(() => result.current.setRoomSidebarWidth(900));

    expect(result.current.preferences).toEqual({ version: 1, roomSidebarWidth: 360 });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")).toEqual({
      version: 1,
      roomSidebarWidth: 360,
    });
  });
});
