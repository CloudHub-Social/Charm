import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RoomInfoPanel } from "./RoomInfoPanel";
import { renderWithProviders, makeRoomDetails } from "./testUtils";
import type { RoomDetails } from "@/lib/matrix";

const getRoomDetails = vi.fn();
const getRoomMemberList = vi.fn().mockResolvedValue([]);
let roomDetailsUpdateCallback: ((details: RoomDetails) => void) | undefined;

vi.mock("@/lib/matrix", () => ({
  getRoomDetails: (...args: unknown[]) => getRoomDetails(...args),
  getRoomMemberList: (...args: unknown[]) => getRoomMemberList(...args),
  onRoomDetailsUpdate: vi.fn((callback: (details: RoomDetails) => void) => {
    roomDetailsUpdateCallback = callback;
    return Promise.resolve(() => {});
  }),
  setRoomName: vi.fn().mockResolvedValue(undefined),
  setRoomTopic: vi.fn().mockResolvedValue(undefined),
  setRoomAvatar: vi.fn().mockResolvedValue(undefined),
  removeRoomAvatar: vi.fn().mockResolvedValue(undefined),
  setRoomJoinRule: vi.fn().mockResolvedValue(undefined),
  setRoomHistoryVisibility: vi.fn().mockResolvedValue(undefined),
  enableRoomEncryption: vi.fn().mockResolvedValue(undefined),
  setMemberPowerLevel: vi.fn().mockResolvedValue(undefined),
  setRoomPowerLevelThresholds: vi.fn().mockResolvedValue(undefined),
  inviteMember: vi.fn().mockResolvedValue(undefined),
  kickMember: vi.fn().mockResolvedValue(undefined),
  banMember: vi.fn().mockResolvedValue(undefined),
  unbanMember: vi.fn().mockResolvedValue(undefined),
}));

describe("RoomInfoPanel", () => {
  it("re-renders with fresh data on a mocked room_details:update", async () => {
    const original = makeRoomDetails({ name: "Original Name" });
    getRoomDetails.mockResolvedValue(original);

    renderWithProviders(<RoomInfoPanel roomId={original.room_id} onClose={() => {}} />);

    expect(await screen.findByDisplayValue("Original Name")).toBeInTheDocument();

    const updated = { ...original, name: "Renamed Room" };
    act(() => {
      roomDetailsUpdateCallback?.(updated);
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue("Renamed Room")).toBeInTheDocument();
    });
  });

  it("ignores room_details:update events for a different room", async () => {
    const original = makeRoomDetails({ name: "Original Name" });
    getRoomDetails.mockResolvedValue(original);

    renderWithProviders(<RoomInfoPanel roomId={original.room_id} onClose={() => {}} />);
    expect(await screen.findByDisplayValue("Original Name")).toBeInTheDocument();

    act(() => {
      roomDetailsUpdateCallback?.({
        ...original,
        room_id: "!other:localhost",
        name: "Should not appear",
      });
    });

    expect(screen.queryByDisplayValue("Should not appear")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("Original Name")).toBeInTheDocument();
  });
});
