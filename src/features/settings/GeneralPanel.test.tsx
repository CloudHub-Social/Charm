import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GeneralPanel } from "./GeneralPanel";
import { renderWithProviders } from "@/test/renderWithProviders";

const isPermissionGranted = vi.fn();
const requestPermission = vi.fn();

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: (...args: unknown[]) => isPermissionGranted(...args),
  requestPermission: (...args: unknown[]) => requestPermission(...args),
}));

beforeEach(() => {
  isPermissionGranted.mockReset().mockResolvedValue(false);
  requestPermission.mockReset().mockResolvedValue("granted");
});

describe("GeneralPanel", () => {
  it("shows an Enable button when notifications aren't granted", async () => {
    renderWithProviders(<GeneralPanel />);
    expect(await screen.findByRole("button", { name: "Enable" })).toBeInTheDocument();
  });

  it("clicking Enable requests notification permission", async () => {
    renderWithProviders(<GeneralPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Enable" }));

    await waitFor(() => expect(requestPermission).toHaveBeenCalled());
  });

  it("shows Enabled instead of a button once notifications are granted", async () => {
    isPermissionGranted.mockResolvedValue(true);
    renderWithProviders(<GeneralPanel />);

    expect(await screen.findByText("Enabled")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable" })).not.toBeInTheDocument();
  });
});
