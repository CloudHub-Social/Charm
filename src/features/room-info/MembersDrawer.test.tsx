import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MembersDrawer } from "./MembersDrawer";
import { renderWithProviders, makeRoomDetails } from "./testUtils";
import type { RoomMemberSummary } from "@/lib/matrix";

const getRoomDetails = vi.fn();
const getRoomMemberList = vi.fn();

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

const MEMBER: RoomMemberSummary = {
  user_id: "@alice:example.org",
  display_name: "Alice",
  avatar_url: null,
  power_level: 0,
  membership: "join",
};

describe("MembersDrawer", () => {
  it("renders the member list for the room and calls onClose", async () => {
    const details = makeRoomDetails({ member_count: 1 });
    getRoomDetails.mockResolvedValue(details);
    getRoomMemberList.mockResolvedValue([MEMBER]);
    const onClose = vi.fn();

    renderWithProviders(
      <MembersDrawer roomId={details.room_id} currentUserId="@evie:localhost" onClose={onClose} />,
    );

    expect(await screen.findByText("1 joined")).toBeInTheDocument();

    screen.getByRole("button", { name: "Close members" }).click();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows an error message when the details fetch fails, without a blank body", async () => {
    getRoomDetails.mockRejectedValue(new Error("network error"));

    renderWithProviders(
      <MembersDrawer
        roomId="!fails:localhost"
        currentUserId="@evie:localhost"
        onClose={() => {}}
      />,
    );

    expect(await screen.findByText("Couldn't load members.")).toBeInTheDocument();
    // The close button remains reachable regardless of fetch outcome — it's
    // rendered unconditionally in the header, not gated on `details`.
    expect(screen.getByRole("button", { name: "Close members" })).toBeInTheDocument();
  });
});
