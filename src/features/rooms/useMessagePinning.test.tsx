import type { PropsWithChildren } from "react";
import { act, renderHook } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pinnedMessagesDrawerOpenAtomFamily } from "@/features/room-info/roomInfoAtoms";
import { makeRoomSummary } from "./testFixtures";
import { useMessagePinning } from "./useMessagePinning";

const mockUseFlag = vi.fn();
const mockIsWebBuild = vi.fn();
const mockUseRoomDetails = vi.fn();

vi.mock("@/featureFlags", () => ({
  useFlag: (...args: unknown[]) => mockUseFlag(...args),
}));

vi.mock("@/lib/platform", () => ({
  isWebBuild: () => mockIsWebBuild(),
}));

vi.mock("@/features/room-info/useRoomDetails", () => ({
  useRoomDetails: (...args: unknown[]) => mockUseRoomDetails(...args),
}));

describe("useMessagePinning", () => {
  beforeEach(() => {
    mockUseFlag.mockReset().mockReturnValue(true);
    mockIsWebBuild.mockReset().mockReturnValue(false);
    mockUseRoomDetails.mockReset().mockReturnValue({
      data: {
        pinned_event_ids: ["$one", "$two"],
        can: { set_pinned_events: true },
      },
    });
  });

  it("projects enabled pinning state and the room-scoped drawer atom", () => {
    const room = makeRoomSummary();
    const store = createStore();
    const wrapper = ({ children }: PropsWithChildren) => (
      <JotaiProvider store={store}>{children}</JotaiProvider>
    );
    const { result } = renderHook(() => useMessagePinning(room), { wrapper });

    expect(mockUseFlag).toHaveBeenCalledWith("message_pinning");
    expect(mockUseRoomDetails).toHaveBeenCalledWith(room.room_id);
    expect(result.current.pinnedEventIds).toEqual(["$one", "$two"]);
    expect(result.current.canPinMessages).toBe(true);

    act(() => result.current.setDrawerOpen(true));
    expect(result.current.drawerOpen).toBe(true);
    expect(store.get(pinnedMessagesDrawerOpenAtomFamily(room.room_id))).toBe(true);
  });

  it.each([
    { flagEnabled: false, webBuild: false },
    { flagEnabled: true, webBuild: true },
  ])(
    "keeps ids and permissions dark when flag=$flagEnabled and web=$webBuild",
    ({ flagEnabled, webBuild }) => {
      mockUseFlag.mockReturnValue(flagEnabled);
      mockIsWebBuild.mockReturnValue(webBuild);

      const { result } = renderHook(() => useMessagePinning(makeRoomSummary()));

      expect(result.current.enabled).toBe(false);
      expect(result.current.pinnedEventIds).toEqual([]);
      expect(result.current.canPinMessages).toBe(false);
    },
  );

  it("does not request room details when no room is selected", () => {
    renderHook(() => useMessagePinning(null));

    expect(mockUseRoomDetails).toHaveBeenCalledWith(null);
  });
});
