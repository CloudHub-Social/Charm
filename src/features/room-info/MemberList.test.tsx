import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemberList } from "./MemberList";
import { makeRoomDetails, renderWithProviders } from "./testUtils";
import type { RoomMemberSummary } from "@/lib/matrix";

const getRoomMemberList = vi.fn();

vi.mock("@/lib/matrix", () => ({
  getRoomMemberList: (...args: unknown[]) => getRoomMemberList(...args),
  onRoomDetailsUpdate: vi.fn().mockResolvedValue(() => {}),
  inviteMember: vi.fn().mockResolvedValue(undefined),
  kickMember: vi.fn().mockResolvedValue(undefined),
  banMember: vi.fn().mockResolvedValue(undefined),
  unbanMember: vi.fn().mockResolvedValue(undefined),
  setMemberPowerLevel: vi.fn().mockResolvedValue(undefined),
}));

const MEMBERS: RoomMemberSummary[] = [
  {
    user_id: "@alice:example.org",
    display_name: "Alice",
    avatar_url: null,
    power_level: 50,
    membership: "join",
  },
  {
    user_id: "@mallory:example.org",
    display_name: "Mallory",
    avatar_url: null,
    power_level: 0,
    membership: "ban",
  },
];

describe("MemberList", () => {
  it("groups active members separately from a Banned section", async () => {
    getRoomMemberList.mockResolvedValue(MEMBERS);
    const details = makeRoomDetails({ member_count: 2 });

    renderWithProviders(<MemberList details={details} currentUserId="@evie:localhost" />);

    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Banned")).toBeInTheDocument();
    expect(screen.getByText("Mallory")).toBeInTheDocument();
    expect(screen.getByText("2 members")).toBeInTheDocument();
  });

  it("omits the Banned heading when no member is banned", async () => {
    getRoomMemberList.mockResolvedValue([MEMBERS[0]]);
    const details = makeRoomDetails({ member_count: 1 });

    renderWithProviders(<MemberList details={details} currentUserId="@evie:localhost" />);

    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    expect(screen.queryByText("Banned")).not.toBeInTheDocument();
    expect(screen.getByText("1 member")).toBeInTheDocument();
  });

  it("disables the Invite trigger when can.invite is false", async () => {
    getRoomMemberList.mockResolvedValue([]);
    const details = makeRoomDetails({ can: { ...makeRoomDetails().can, invite: false } });

    renderWithProviders(<MemberList details={details} currentUserId="@evie:localhost" />);

    expect(screen.getByRole("button", { name: "Invite" })).toBeDisabled();
  });
});
