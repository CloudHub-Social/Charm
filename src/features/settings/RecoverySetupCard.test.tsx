import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, wrapWithProviders } from "@/test/renderWithProviders";
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
