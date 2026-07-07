import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MembersDrawer } from "./MembersDrawer";
import { renderWithProviders, makeRoomDetails } from "./testUtils";

const getRoomDetails = vi.fn();
const getRoomMemberList = vi.fn().mockResolvedValue([]);

vi.mock("@/lib/matrix", () => ({
  getRoomDetails: (...args: unknown[]) => getRoomDetails(...args),
  getRoomMemberList: (...args: unknown[]) => getRoomMemberList(...args),
  onRoomDetailsUpdate: vi.fn().mockResolvedValue(() => {}),
  inviteMember: vi.fn().mockResolvedValue(undefined),
  kickMember: vi.fn().mockResolvedValue(undefined),
  banMember: vi.fn().mockResolvedValue(undefined),
  unbanMember: vi.fn().mockResolvedValue(undefined),
  setMemberPowerLevel: vi.fn().mockResolvedValue(undefined),
}));

describe("MembersDrawer", () => {
  it("renders the member list for the room and calls onClose", async () => {
    const details = makeRoomDetails({ member_count: 1 });
    getRoomDetails.mockResolvedValue(details);
    const onClose = vi.fn();

    renderWithProviders(
      <MembersDrawer roomId={details.room_id} currentUserId="@evie:localhost" onClose={onClose} />,
    );

    expect(await screen.findByText("1 member")).toBeInTheDocument();

    screen.getByRole("button", { name: "Close members" }).click();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
