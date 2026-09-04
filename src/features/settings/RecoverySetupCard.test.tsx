import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, wrapWithProviders } from "@/test/renderWithProviders";
import { RecoverySetupCard } from "./RecoverySetupCard";

const setupRecovery = vi.fn();
const getPendingRecoverySetup = vi.fn();
const acknowledgeRecoverySetup = vi.fn();

vi.mock("@/lib/matrix", () => ({
  setupRecovery: (...args: unknown[]) => setupRecovery(...args),
  getPendingRecoverySetup: (...args: unknown[]) => getPendingRecoverySetup(...args),
  acknowledgeRecoverySetup: (...args: unknown[]) => acknowledgeRecoverySetup(...args),
}));

beforeEach(() => {
  getPendingRecoverySetup.mockReset().mockResolvedValue(null);
  acknowledgeRecoverySetup.mockReset().mockResolvedValue(undefined);
  setupRecovery.mockReset().mockResolvedValue({
    recovery_key: "EsTx generated recovery key",
    room_keys_backed_up: true,
  });
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe("RecoverySetupCard", () => {
  it.each([
    [
      "Sign in again with durable encrypted storage before setting up recovery.",
      "Sign in again with durable encrypted storage before setting up recovery.",
    ],
    [
      "recovery setup is not enabled",
      "Recovery setup is not enabled for this app or server. Contact your administrator.",
    ],
    [
      "Could not atomically persist protected recovery.",
      "Protected recovery storage is unavailable. Check device access or ask your server administrator to configure durable encrypted storage before retrying.",
    ],
  ])("gives actionable guidance for %s", async (error, expected) => {
    setupRecovery.mockRejectedValue(new Error(error));
    renderWithProviders(<RecoverySetupCard enabled crossSigningReady recoveryDisabled />);
    fireEvent.click(screen.getByRole("button", { name: "Set up recovery" }));
    fireEvent.click(screen.getByRole("button", { name: "Create backup" }));
    expect(await screen.findByText(expected)).toBeInTheDocument();
  });

  it("reopens protected pending recovery after remount even with rollout disabled", async () => {
    const summary = { recovery_key: "protected pending key", room_keys_backed_up: true };
    setupRecovery.mockImplementation(async () => {
      getPendingRecoverySetup.mockResolvedValue(summary);
      return summary;
    });
    const first = renderWithProviders(
      <RecoverySetupCard enabled crossSigningReady recoveryDisabled />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Set up recovery" }));
    fireEvent.click(screen.getByRole("button", { name: "Create backup" }));
    await screen.findByText(summary.recovery_key);
    first.unmount();
    const second = renderWithProviders(
      <RecoverySetupCard enabled={false} crossSigningReady recoveryDisabled={false} />,
    );
    expect(await screen.findByText(summary.recovery_key)).toBeInTheDocument();
    expect(first.client.getMutationCache().getAll()).toEqual([]);
    expect(second.client.getMutationCache().getAll()).toEqual([]);
    expect(acknowledgeRecoverySetup).not.toHaveBeenCalled();
    acknowledgeRecoverySetup.mockImplementation(async () =>
      getPendingRecoverySetup.mockResolvedValue(null),
    );
    fireEvent.click(screen.getByLabelText("I saved this recovery key somewhere safe."));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByText(summary.recovery_key)).not.toBeInTheDocument());
    expect(acknowledgeRecoverySetup).toHaveBeenCalledWith(summary.recovery_key);
    second.unmount();
    renderWithProviders(
      <RecoverySetupCard enabled={false} crossSigningReady recoveryDisabled={false} />,
    );
    await act(async () => {});
    expect(screen.queryByText(summary.recovery_key)).not.toBeInTheDocument();
  });

  it("retains the key when protected acknowledgement fails", async () => {
    getPendingRecoverySetup.mockResolvedValue({
      recovery_key: "keep this key",
      room_keys_backed_up: true,
    });
    acknowledgeRecoverySetup.mockRejectedValue(new Error("storage unavailable"));
    renderWithProviders(
      <RecoverySetupCard enabled={false} crossSigningReady recoveryDisabled={false} />,
    );
    await screen.findByText("keep this key");
    fireEvent.click(screen.getByLabelText("I saved this recovery key somewhere safe."));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not acknowledge");
    expect(screen.getByText("keep this key")).toBeInTheDocument();
  });

  it("requires local cross-signing keys before setup", () => {
    renderWithProviders(<RecoverySetupCard enabled crossSigningReady={false} recoveryDisabled />);

    expect(screen.getByRole("button", { name: "Set up recovery" })).toBeDisabled();
    expect(screen.getByText(/Set up or restore cross-signing/)).toBeInTheDocument();
  });

  it("keeps the generated recovery key visible until the user confirms it is saved", async () => {
    const { client, unmount } = renderWithProviders(
      <RecoverySetupCard enabled crossSigningReady recoveryDisabled />,
    );

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
    expect(client.getMutationCache().getAll()).toEqual([]);
    const done = screen.getByRole("button", { name: "Done" });
    expect(done).toBeDisabled();

    fireEvent.click(screen.getByLabelText("I saved this recovery key somewhere safe."));
    fireEvent.click(done);
    await waitFor(() =>
      expect(screen.queryByText("EsTx generated recovery key")).not.toBeInTheDocument(),
    );
    expect(client.getMutationCache().getAll()).toEqual([]);
    unmount();
    expect(client.getMutationCache().getAll()).toEqual([]);
  });

  it("allows setup without an optional passphrase", async () => {
    renderWithProviders(<RecoverySetupCard enabled crossSigningReady recoveryDisabled />);

    fireEvent.click(screen.getByRole("button", { name: "Set up recovery" }));
    fireEvent.click(screen.getByRole("button", { name: "Create backup" }));

    await waitFor(() => expect(setupRecovery).toHaveBeenCalledWith(undefined));
  });

  it("counts Unicode scalars and enforces the backend UTF-8 byte limit", () => {
    renderWithProviders(<RecoverySetupCard enabled crossSigningReady recoveryDisabled />);
    fireEvent.click(screen.getByRole("button", { name: "Set up recovery" }));
    for (const value of ["😀".repeat(4), "😀".repeat(257)]) {
      fireEvent.change(screen.getByLabelText("Optional passphrase"), { target: { value } });
      fireEvent.change(screen.getByLabelText("Confirm passphrase"), { target: { value } });
      expect(screen.getByRole("button", { name: "Create backup" })).toBeDisabled();
    }
    const value = "😀".repeat(8);
    fireEvent.change(screen.getByLabelText("Optional passphrase"), { target: { value } });
    fireEvent.change(screen.getByLabelText("Confirm passphrase"), { target: { value } });
    expect(screen.getByRole("button", { name: "Create backup" })).toBeEnabled();
  });

  it.each(["pending", "issued"] as const)(
    "retains the recovery key when disabled while %s",
    async (phase) => {
      let complete!: (result: { recovery_key: string; room_keys_backed_up: boolean }) => void;
      setupRecovery.mockReturnValue(
        new Promise((resolve) => {
          complete = resolve;
        }),
      );
      const { rerender, client } = renderWithProviders(
        <RecoverySetupCard enabled crossSigningReady recoveryDisabled />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Set up recovery" }));
      fireEvent.click(screen.getByRole("button", { name: "Create backup" }));
      await waitFor(() => expect(setupRecovery).toHaveBeenCalledOnce());
      if (phase === "pending")
        rerender(
          wrapWithProviders(
            <RecoverySetupCard enabled={false} crossSigningReady recoveryDisabled />,
            client,
          ),
        );
      await act(async () =>
        complete({ recovery_key: "issued recovery credential", room_keys_backed_up: true }),
      );
      expect(await screen.findByText("issued recovery credential")).toBeInTheDocument();
      rerender(
        wrapWithProviders(
          <RecoverySetupCard enabled={false} crossSigningReady recoveryDisabled />,
          client,
        ),
      );
      expect(screen.getByText("issued recovery credential")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
      fireEvent.click(screen.getByLabelText("I saved this recovery key somewhere safe."));
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      await waitFor(() =>
        expect(screen.queryByText("issued recovery credential")).not.toBeInTheDocument(),
      );
      expect(screen.queryByRole("button", { name: "Set up recovery" })).not.toBeInTheDocument();
    },
  );

  it("prevents a new setup after the flag is disabled with the form open", () => {
    const { rerender, client } = renderWithProviders(
      <RecoverySetupCard enabled crossSigningReady recoveryDisabled />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Set up recovery" }));
    rerender(
      wrapWithProviders(
        <RecoverySetupCard enabled={false} crossSigningReady recoveryDisabled />,
        client,
      ),
    );
    expect(screen.getByRole("button", { name: "Create backup" })).toBeDisabled();
    expect(setupRecovery).not.toHaveBeenCalled();
  });
});
