import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemberRow } from "./MemberRow";
import { openDropdownMenu, renderWithProviders } from "./testUtils";
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
      <MemberRow roomId="!test:localhost" member={MEMBER} can={ALL_ALLOWED} myPowerLevel={100} />,
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
      />,
    );

    expect(screen.queryByRole("button", { name: "Actions for Alice" })).not.toBeInTheDocument();
  });
});
