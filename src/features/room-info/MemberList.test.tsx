import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemberList } from "./MemberList";
import { makeRoomDetails, openDropdownMenu, renderWithProviders } from "./testUtils";
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
    user_id: "@bob:example.org",
    display_name: "Bob",
    avatar_url: null,
    power_level: 0,
    membership: "invite",
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
  it("defaults to the Joined filter, hiding invited and banned members", async () => {
    getRoomMemberList.mockResolvedValue(MEMBERS);
    const details = makeRoomDetails({ member_count: 3 });

    renderWithProviders(<MemberList details={details} currentUserId="@evie:localhost" />);

    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.queryByText("Bob")).not.toBeInTheDocument();
    expect(screen.queryByText("Mallory")).not.toBeInTheDocument();
  });

  it("switches to the Invited filter and shows only invited members", async () => {
    getRoomMemberList.mockResolvedValue(MEMBERS);
    const details = makeRoomDetails({ member_count: 3 });

    renderWithProviders(<MemberList details={details} currentUserId="@evie:localhost" />);
    await screen.findByText("Alice");

    openDropdownMenu("Joined");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Invited" }));

    await waitFor(() => expect(screen.getByText("Bob")).toBeInTheDocument());
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
  });

  it("filters by search query within the active membership filter", async () => {
    getRoomMemberList.mockResolvedValue(MEMBERS);
    const details = makeRoomDetails({ member_count: 3 });

    renderWithProviders(<MemberList details={details} currentUserId="@evie:localhost" />);
    await screen.findByText("Alice");

    fireEvent.change(screen.getByLabelText("Search members"), { target: { value: "zzz" } });

    await waitFor(() => expect(screen.getByText("No members match.")).toBeInTheDocument());
  });

  it("disables the Invite trigger when can.invite is false", async () => {
    getRoomMemberList.mockResolvedValue([]);
    const details = makeRoomDetails({ can: { ...makeRoomDetails().can, invite: false } });

    renderWithProviders(<MemberList details={details} currentUserId="@evie:localhost" />);

    expect(screen.getByRole("button", { name: "Invite" })).toBeDisabled();
  });
});
