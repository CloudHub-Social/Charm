import { fireEvent, render, screen, waitForElementToBeRemoved } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DeviceRow } from "./DeviceRow";
import type { DeviceSummary } from "@/lib/matrix";

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
    render(
      <DeviceRow device={makeDevice({ is_current: true })} onVerify={vi.fn()} onRevoke={vi.fn()} />,
    );
    expect(screen.getByText("This device")).toBeInTheDocument();
  });

  it("does not show a current-device marker for other sessions", () => {
    render(
      <DeviceRow
        device={makeDevice({ is_current: false })}
        onVerify={vi.fn()}
        onRevoke={vi.fn()}
      />,
    );
    expect(screen.queryByText("This device")).not.toBeInTheDocument();
  });

  it("shows a verified trust badge", () => {
    render(
      <DeviceRow
        device={makeDevice({ is_verified: true })}
        onVerify={vi.fn()}
        onRevoke={vi.fn()}
      />,
    );
    expect(screen.getByText("Verified")).toBeInTheDocument();
  });

  it("shows an unverified trust badge", () => {
    render(
      <DeviceRow
        device={makeDevice({ is_verified: false })}
        onVerify={vi.fn()}
        onRevoke={vi.fn()}
      />,
    );
    expect(screen.getByText("Unverified")).toBeInTheDocument();
  });

  it("calls onVerify when Verify is chosen from the actions menu", async () => {
    const onVerify = vi.fn();
    render(
      <DeviceRow
        device={makeDevice({ is_verified: false, is_current: false })}
        onVerify={onVerify}
        onRevoke={vi.fn()}
      />,
    );

    openActionsMenu();
    fireEvent.click(await screen.findByText("Verify"));

    expect(onVerify).toHaveBeenCalled();
  });

  it("does not offer Verify for the current device or an already-verified one", () => {
    render(
      <DeviceRow
        device={makeDevice({ is_current: true, is_verified: true })}
        onVerify={vi.fn()}
        onRevoke={vi.fn()}
      />,
    );
    openActionsMenu();
    expect(screen.queryByText("Verify")).not.toBeInTheDocument();
  });

  it("confirms before revoking, then calls onRevoke with no password on the first attempt", async () => {
    const onRevoke = vi.fn().mockResolvedValue(undefined);
    render(
      <DeviceRow
        device={makeDevice({ is_current: false })}
        onVerify={vi.fn()}
        onRevoke={onRevoke}
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
      .mockRejectedValueOnce(new Error("uia"))
      .mockResolvedValueOnce(undefined);
    render(
      <DeviceRow
        device={makeDevice({ is_current: false })}
        onVerify={vi.fn()}
        onRevoke={onRevoke}
      />,
    );

    openActionsMenu();
    fireEvent.click(await screen.findByText("Sign out"));
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(await screen.findByLabelText("Current password")).toBeInTheDocument();
  });
});
