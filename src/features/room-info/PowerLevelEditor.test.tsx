import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemberPowerLevelDialog, PowerLevelThresholdsEditor } from "./PowerLevelEditor";
import { makeRoomDetails, renderWithProviders } from "./testUtils";

const setMemberPowerLevel = vi.fn().mockResolvedValue(undefined);
const setRoomPowerLevelThresholds = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/matrix", () => ({
  setMemberPowerLevel: (...args: unknown[]) => setMemberPowerLevel(...args),
  setRoomPowerLevelThresholds: (...args: unknown[]) => setRoomPowerLevelThresholds(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MemberPowerLevelDialog", () => {
  it("sets a preset role directly when it doesn't reach the acting user's own power level", async () => {
    renderWithProviders(
      <MemberPowerLevelDialog
        roomId="!test:localhost"
        userId="@alice:example.org"
        currentPowerLevel={0}
        myPowerLevel={100}
        open={true}
        onOpenChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Moderator" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(setMemberPowerLevel).toHaveBeenCalledWith("!test:localhost", "@alice:example.org", 50);
    });
  });

  it("requires confirmation before raising a target to/above the acting user's own power level", async () => {
    renderWithProviders(
      <MemberPowerLevelDialog
        roomId="!test:localhost"
        userId="@alice:example.org"
        currentPowerLevel={0}
        myPowerLevel={100}
        open={true}
        onOpenChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Admin" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(setMemberPowerLevel).not.toHaveBeenCalled();
    expect(screen.getByText(/at or above your own/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Set power level" }));
    await waitFor(() => {
      expect(setMemberPowerLevel).toHaveBeenCalledWith(
        "!test:localhost",
        "@alice:example.org",
        100,
      );
    });
  });
});

describe("PowerLevelThresholdsEditor", () => {
  it("disables every threshold input when can.set_power_levels is false", () => {
    const details = makeRoomDetails({
      can: { ...makeRoomDetails().can, set_power_levels: false },
    });
    renderWithProviders(<PowerLevelThresholdsEditor details={details} />);

    expect(screen.getByLabelText("Invite")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save thresholds" })).toBeDisabled();
  });

  it("saves edited thresholds when can.set_power_levels is true", async () => {
    const details = makeRoomDetails();
    renderWithProviders(<PowerLevelThresholdsEditor details={details} />);

    fireEvent.change(screen.getByLabelText("Kick"), { target: { value: "75" } });
    fireEvent.click(screen.getByRole("button", { name: "Save thresholds" }));

    await waitFor(() => {
      expect(setRoomPowerLevelThresholds).toHaveBeenCalledWith("!test:localhost", {
        ...details.power_levels,
        kick: 75,
      });
    });
  });
});
