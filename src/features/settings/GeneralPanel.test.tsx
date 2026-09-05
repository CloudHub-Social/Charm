import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GeneralPanel } from "./GeneralPanel";
import { renderWithProviders } from "@/test/renderWithProviders";

const isNotificationPermissionGranted = vi.fn();
const requestNotificationPermission = vi.fn();

vi.mock("@/lib/matrix", () => ({
  isNotificationPermissionGranted: (...args: unknown[]) => isNotificationPermissionGranted(...args),
  requestNotificationPermission: (...args: unknown[]) => requestNotificationPermission(...args),
}));

beforeEach(() => {
  isNotificationPermissionGranted.mockReset().mockResolvedValue(false);
  requestNotificationPermission.mockReset().mockResolvedValue("granted");
});

describe("GeneralPanel", () => {
  it("shows an Enable button when notifications aren't granted", async () => {
    renderWithProviders(<GeneralPanel />);
    expect(await screen.findByRole("button", { name: "Enable" })).toBeInTheDocument();
  });

  it("clicking Enable requests notification permission", async () => {
    renderWithProviders(<GeneralPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Enable" }));

    await waitFor(() => expect(requestNotificationPermission).toHaveBeenCalled());
  });

  it("shows Enabled instead of a button once notifications are granted", async () => {
    isNotificationPermissionGranted.mockResolvedValue(true);
    renderWithProviders(<GeneralPanel />);

    expect(await screen.findByText("Enabled")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable" })).not.toBeInTheDocument();
  });
});
