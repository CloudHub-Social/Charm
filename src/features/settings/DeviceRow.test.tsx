import { fireEvent, screen, waitFor, waitForElementToBeRemoved } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DeviceRow } from "./DeviceRow";
import type { DeviceSummary } from "@/lib/matrix";
import { renderWithProviders } from "@/test/renderWithProviders";

const getDeviceDeleteUrl = vi.fn();

vi.mock("@/lib/matrix", async (importOriginal) => ({
  ...(await importOriginal()),
  getDeviceDeleteUrl: (...args: unknown[]) => getDeviceDeleteUrl(...args),
}));

const openUrl = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => openUrl(...args),
}));

function makeDevice(overrides: Partial<DeviceSummary> = {}): DeviceSummary {
  return {
    device_id: "DEVICE1",
    display_name: "My Phone",
    last_seen_ip: null,
    last_seen_ts: null,
    is_current: false,
    is_verified: false,
    ...overrides,
  };
}

/** Radix's DropdownMenu opens on pointerdown, not click, in jsdom. */
function openActionsMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: /Actions for/ }), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

describe("DeviceRow", () => {
  it("marks the current device", () => {
    renderWithProviders(
      <DeviceRow
        device={makeDevice({ is_current: true })}
        onVerify={vi.fn()}
        onRevoke={vi.fn()}
        usesOAuth={false}
      />,
    );
    expect(screen.getByText("This device")).toBeInTheDocument();
  });

  it("does not show a current-device marker for other sessions", () => {
    renderWithProviders(
      <DeviceRow
        device={makeDevice({ is_current: false })}
        onVerify={vi.fn()}
        onRevoke={vi.fn()}
        usesOAuth={false}
      />,
    );
    expect(screen.queryByText("This device")).not.toBeInTheDocument();
  });

  it("shows a verified trust badge", () => {
    renderWithProviders(
      <DeviceRow
        device={makeDevice({ is_verified: true })}
        onVerify={vi.fn()}
        onRevoke={vi.fn()}
        usesOAuth={false}
      />,
    );
    expect(screen.getByText("Verified")).toBeInTheDocument();
  });

  it("shows an unverified trust badge", () => {
    renderWithProviders(
      <DeviceRow
        device={makeDevice({ is_verified: false })}
        onVerify={vi.fn()}
        onRevoke={vi.fn()}
        usesOAuth={false}
      />,
    );
    expect(screen.getByText("Unverified")).toBeInTheDocument();
  });

  it("calls onVerify when Verify is chosen from the actions menu", async () => {
    const onVerify = vi.fn();
    renderWithProviders(
      <DeviceRow
        device={makeDevice({ is_verified: false, is_current: false })}
        onVerify={onVerify}
        onRevoke={vi.fn()}
        usesOAuth={false}
      />,
    );

    openActionsMenu();
    fireEvent.click(await screen.findByText("Verify"));

    expect(onVerify).toHaveBeenCalled();
  });

  it("hides the actions menu entirely for the current device", () => {
    renderWithProviders(
      <DeviceRow
        device={makeDevice({ is_current: true, is_verified: true })}
        onVerify={vi.fn()}
        onRevoke={vi.fn()}
        usesOAuth={false}
      />,
    );
    expect(screen.queryByRole("button", { name: /Actions for/ })).not.toBeInTheDocument();
  });

  it("does not offer Verify for an already-verified, non-current device", () => {
    renderWithProviders(
      <DeviceRow
        device={makeDevice({ is_current: false, is_verified: true })}
        onVerify={vi.fn()}
        onRevoke={vi.fn()}
        usesOAuth={false}
      />,
    );
    openActionsMenu();
    expect(screen.queryByText("Verify")).not.toBeInTheDocument();
  });

  it("confirms before revoking, then calls onRevoke with no password on the first attempt", async () => {
    const onRevoke = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <DeviceRow
        device={makeDevice({ is_current: false })}
        onVerify={vi.fn()}
        onRevoke={onRevoke}
        usesOAuth={false}
      />,
    );

    openActionsMenu();
    fireEvent.click(await screen.findByText("Sign out"));
    const dialogTitle = await screen.findByText("Sign out this device?");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(onRevoke).toHaveBeenCalledWith(undefined);
    await waitForElementToBeRemoved(dialogTitle);
  });

  it("prompts for a password when onRevoke rejects the first attempt", async () => {
    const onRevoke = vi
      .fn()
      .mockRejectedValueOnce({ kind: "UiaChallenge" })
      .mockResolvedValueOnce(undefined);
    renderWithProviders(
      <DeviceRow
        device={makeDevice({ is_current: false })}
        onVerify={vi.fn()}
        onRevoke={onRevoke}
        usesOAuth={false}
      />,
    );

    openActionsMenu();
    fireEvent.click(await screen.findByText("Sign out"));
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(await screen.findByLabelText("Current password")).toBeInTheDocument();
  });

  it("surfaces the actual revoke retry error instead of assuming it's always a wrong password", async () => {
    const onRevoke = vi
      .fn()
      .mockRejectedValueOnce({ kind: "UiaChallenge" })
      .mockRejectedValueOnce({ kind: "Other", message: "device already removed" });
    renderWithProviders(
      <DeviceRow
        device={makeDevice({ is_current: false })}
        onVerify={vi.fn()}
        onRevoke={onRevoke}
        usesOAuth={false}
      />,
    );

    openActionsMenu();
    fireEvent.click(await screen.findByText("Sign out"));
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    fireEvent.change(await screen.findByLabelText("Current password"), {
      target: { value: "current-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByText("device already removed")).toBeInTheDocument();
  });

  it("surfaces a non-UIA revoke error on the first attempt instead of prompting for a password", async () => {
    const onRevoke = vi.fn().mockRejectedValueOnce({ kind: "Other", message: "network error" });
    renderWithProviders(
      <DeviceRow
        device={makeDevice({ is_current: false })}
        onVerify={vi.fn()}
        onRevoke={onRevoke}
        usesOAuth={false}
      />,
    );

    openActionsMenu();
    fireEvent.click(await screen.findByText("Sign out"));
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(await screen.findByText("network error")).toBeInTheDocument();
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
  });

  it("resets the dialog's state when Cancel is clicked after a failed attempt", async () => {
    const onRevoke = vi.fn().mockRejectedValue({ kind: "UiaChallenge" });
    renderWithProviders(
      <DeviceRow
        device={makeDevice({ is_current: false })}
        onVerify={vi.fn()}
        onRevoke={onRevoke}
        usesOAuth={false}
      />,
    );

    openActionsMenu();
    fireEvent.click(await screen.findByText("Sign out"));
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await screen.findByLabelText("Current password");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByText("Sign out this device?")).not.toBeInTheDocument(),
    );

    openActionsMenu();
    fireEvent.click(await screen.findByText("Sign out"));

    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
    expect(await screen.findByText(/This immediately signs/)).toBeInTheDocument();
  });

  it("offers an account-management link instead of Sign out for an OAuth session's device", async () => {
    getDeviceDeleteUrl.mockResolvedValue("https://example.org/account/devices/DEVICE1");
    renderWithProviders(
      <DeviceRow
        device={makeDevice({ is_current: false })}
        onVerify={vi.fn()}
        onRevoke={vi.fn()}
        usesOAuth={true}
      />,
    );

    openActionsMenu();
    expect(screen.queryByText("Sign out")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByText("Manage in account settings"));

    expect(openUrl).toHaveBeenCalledWith("https://example.org/account/devices/DEVICE1");
  });

  it("hides both Sign out and the account-management link when no URL is advertised for an OAuth session", async () => {
    getDeviceDeleteUrl.mockResolvedValue(null);
    renderWithProviders(
      <DeviceRow
        device={makeDevice({ is_current: false })}
        onVerify={vi.fn()}
        onRevoke={vi.fn()}
        usesOAuth={true}
      />,
    );

    openActionsMenu();
    await waitFor(() => expect(getDeviceDeleteUrl).toHaveBeenCalled());
    expect(screen.queryByText("Sign out")).not.toBeInTheDocument();
    expect(screen.queryByText("Manage in account settings")).not.toBeInTheDocument();
  });
});
