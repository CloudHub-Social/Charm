import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemberRow } from "./MemberRow";
import { openDropdownMenu } from "./testUtils";
import { renderWithProviders } from "@/test/renderWithProviders";
import type { RoomMemberSummary, RoomPermissions } from "@/lib/matrix";

const kickMember = vi.fn().mockResolvedValue(undefined);
const banMember = vi.fn().mockResolvedValue(undefined);
const unbanMember = vi.fn().mockResolvedValue(undefined);
const setMemberPowerLevel = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/matrix", () => ({
  kickMember: (...args: unknown[]) => kickMember(...args),
  banMember: (...args: unknown[]) => banMember(...args),
  unbanMember: (...args: unknown[]) => unbanMember(...args),
  setMemberPowerLevel: (...args: unknown[]) => setMemberPowerLevel(...args),
}));

const MEMBER: RoomMemberSummary = {
  user_id: "@alice:example.org",
  display_name: "Alice",
  avatar_url: null,
  power_level: 50,
  membership: "join",
};

const BANNED_MEMBER: RoomMemberSummary = { ...MEMBER, membership: "ban" };

const ALL_ALLOWED: RoomPermissions = {
  set_name: true,
  set_topic: true,
  set_avatar: true,
  set_join_rules: true,
  set_history_visibility: true,
  set_encryption: true,
  set_power_levels: true,
  invite: true,
  kick: true,
  ban: true,
};

describe("MemberRow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invokes kick_member when can.kick is true", async () => {
    renderWithProviders(
      <MemberRow
        roomId="!test:localhost"
        member={MEMBER}
        can={ALL_ALLOWED}
        myPowerLevel={100}
        currentUserId="@evie:localhost"
      />,
    );

    openDropdownMenu("Actions for Alice");
    fireEvent.click(await screen.findByText("Kick"));

    await waitFor(() => {
      expect(kickMember).toHaveBeenCalledWith("!test:localhost", "@alice:example.org", undefined);
    });
  });

  it("disables Kick and does not call kick_member when can.kick is false", async () => {
    renderWithProviders(
      <MemberRow
        roomId="!test:localhost"
        member={MEMBER}
        can={{ ...ALL_ALLOWED, kick: false }}
        myPowerLevel={100}
        currentUserId="@evie:localhost"
      />,
    );

    openDropdownMenu("Actions for Alice");
    const kickItem = await screen.findByText("Kick");
    expect(kickItem.closest('[role="menuitem"]')).toHaveAttribute("data-disabled");

    fireEvent.click(kickItem);
    expect(kickMember).not.toHaveBeenCalled();
  });

  it("hides the actions menu entirely when no action is permitted", () => {
    renderWithProviders(
      <MemberRow
        roomId="!test:localhost"
        member={MEMBER}
        can={{ ...ALL_ALLOWED, kick: false, ban: false, set_power_levels: false }}
        myPowerLevel={0}
        currentUserId="@evie:localhost"
      />,
    );

    expect(screen.queryByRole("button", { name: "Actions for Alice" })).not.toBeInTheDocument();
  });

  it("disables Kick/Ban against a peer at or above the acting user's own power level, even when can.kick/can.ban are true", async () => {
    renderWithProviders(
      <MemberRow
        roomId="!test:localhost"
        member={{ ...MEMBER, power_level: 100 }}
        can={ALL_ALLOWED}
        myPowerLevel={100}
        currentUserId="@evie:localhost"
      />,
    );

    openDropdownMenu("Actions for Alice");
    const kickItem = await screen.findByText("Kick");
    expect(kickItem.closest('[role="menuitem"]')).toHaveAttribute("data-disabled");

    fireEvent.click(kickItem);
    expect(kickMember).not.toHaveBeenCalled();
  });

  it("hides the actions menu for a banned member when can.ban is false", () => {
    renderWithProviders(
      <MemberRow
        roomId="!test:localhost"
        member={BANNED_MEMBER}
        can={{ ...ALL_ALLOWED, ban: false }}
        myPowerLevel={100}
        currentUserId="@evie:localhost"
      />,
    );

    expect(screen.queryByRole("button", { name: "Actions for Alice" })).not.toBeInTheDocument();
  });

  it("hides Unban when can.ban is true but can.kick is false (unban needs both)", () => {
    renderWithProviders(
      <MemberRow
        roomId="!test:localhost"
        member={BANNED_MEMBER}
        can={{ ...ALL_ALLOWED, kick: false }}
        myPowerLevel={100}
        currentUserId="@evie:localhost"
      />,
    );

    expect(screen.queryByRole("button", { name: "Actions for Alice" })).not.toBeInTheDocument();
  });

  it("invokes unban_member for a banned member when both can.ban and can.kick are true", async () => {
    renderWithProviders(
      <MemberRow
        roomId="!test:localhost"
        member={BANNED_MEMBER}
        can={ALL_ALLOWED}
        myPowerLevel={100}
        currentUserId="@evie:localhost"
      />,
    );

    openDropdownMenu("Actions for Alice");
    fireEvent.click(await screen.findByText("Unban"));

    await waitFor(() => {
      expect(unbanMember).toHaveBeenCalledWith("!test:localhost", "@alice:example.org", undefined);
    });
  });
});
