import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/renderWithProviders";
import { RecoverySetupCard } from "./RecoverySetupCard";

const setupRecovery = vi.fn();

vi.mock("@/lib/matrix", () => ({
  setupRecovery: (...args: unknown[]) => setupRecovery(...args),
}));

beforeEach(() => {
  setupRecovery.mockReset().mockResolvedValue({
    recovery_key: "EsTx generated recovery key",
    room_keys_backed_up: true,
  });
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe("RecoverySetupCard", () => {
  it("requires local cross-signing keys before setup", () => {
    renderWithProviders(<RecoverySetupCard crossSigningReady={false} recoveryDisabled />);

    expect(screen.getByRole("button", { name: "Set up recovery" })).toBeDisabled();
    expect(screen.getByText(/Set up or restore cross-signing/)).toBeInTheDocument();
  });

  it("keeps the generated recovery key visible until the user confirms it is saved", async () => {
    renderWithProviders(<RecoverySetupCard crossSigningReady recoveryDisabled />);

    fireEvent.click(screen.getByRole("button", { name: "Set up recovery" }));
    fireEvent.change(screen.getByLabelText("Optional passphrase"), {
      target: { value: "long-enough-passphrase" },
    });
    fireEvent.change(screen.getByLabelText("Confirm passphrase"), {
      target: { value: "long-enough-passphrase" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create backup" }));

    await waitFor(() => expect(setupRecovery).toHaveBeenCalledWith("long-enough-passphrase"));
    expect(await screen.findByText("EsTx generated recovery key")).toBeInTheDocument();
    const done = screen.getByRole("button", { name: "Done" });
    expect(done).toBeDisabled();

    fireEvent.click(screen.getByLabelText("I saved this recovery key somewhere safe."));
    fireEvent.click(done);
    await waitFor(() =>
      expect(screen.queryByText("EsTx generated recovery key")).not.toBeInTheDocument(),
    );
  });

  it("allows setup without an optional passphrase", async () => {
    renderWithProviders(<RecoverySetupCard crossSigningReady recoveryDisabled />);

    fireEvent.click(screen.getByRole("button", { name: "Set up recovery" }));
    fireEvent.click(screen.getByRole("button", { name: "Create backup" }));

    await waitFor(() => expect(setupRecovery).toHaveBeenCalledWith(undefined));
  });
});
