import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VerifyDevicePane } from "./VerifyDevicePane";
import { renderWithProviders } from "@/test/renderWithProviders";

const getCrossSigningResetUrl = vi.fn();
const bootstrapCrossSigning = vi.fn();

vi.mock("@/lib/matrix", () => ({
  bootstrapCrossSigning: (...args: unknown[]) => bootstrapCrossSigning(...args),
}));

vi.mock("@/features/settings/useDevices", () => ({
  useCrossSigningResetUrl: () => ({ data: getCrossSigningResetUrl() }),
}));

beforeEach(() => {
  getCrossSigningResetUrl.mockReset().mockReturnValue(null);
  bootstrapCrossSigning.mockReset();
});

describe("VerifyDevicePane", () => {
  it("prompts for the account password on a UIA challenge, then succeeds", async () => {
    bootstrapCrossSigning
      .mockRejectedValueOnce({ kind: "UiaChallenge" })
      .mockResolvedValueOnce(undefined);
    renderWithProviders(<VerifyDevicePane onNext={vi.fn()} onSkip={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Verify this device" }));
    fireEvent.change(await screen.findByLabelText("Account password"), {
      target: { value: "current-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(await screen.findByText("This device is set up and trusted.")).toBeInTheDocument();
    expect(bootstrapCrossSigning).toHaveBeenLastCalledWith("current-password");
  });

  it("surfaces a non-UIA error on the first attempt instead of prompting for a password", async () => {
    bootstrapCrossSigning.mockRejectedValueOnce({ kind: "Other", message: "network error" });
    renderWithProviders(<VerifyDevicePane onNext={vi.fn()} onSkip={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Verify this device" }));

    expect(await screen.findByText("network error")).toBeInTheDocument();
    expect(screen.queryByLabelText("Account password")).not.toBeInTheDocument();
  });
});
