import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DevicesPanel } from "./DevicesPanel";
import type { DeviceSummary } from "@/lib/matrix";

const listDevices = vi.fn();
const crossSigningStatus = vi.fn();
const getCrossSigningResetUrl = vi.fn();
const bootstrapCrossSigning = vi.fn();
const deleteDevice = vi.fn();
const requestDeviceVerification = vi.fn();
const onSasUpdate = vi.fn();

vi.mock("@/lib/matrix", () => ({
  listDevices: (...args: unknown[]) => listDevices(...args),
  crossSigningStatus: (...args: unknown[]) => crossSigningStatus(...args),
  getCrossSigningResetUrl: (...args: unknown[]) => getCrossSigningResetUrl(...args),
  bootstrapCrossSigning: (...args: unknown[]) => bootstrapCrossSigning(...args),
  deleteDevice: (...args: unknown[]) => deleteDevice(...args),
  requestDeviceVerification: (...args: unknown[]) => requestDeviceVerification(...args),
  onSasUpdate: (...args: unknown[]) => onSasUpdate(...args),
}));

const openUrl = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => openUrl(...args),
}));

function renderWithProviders(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

/** Radix's DropdownMenu opens on pointerdown, not click, in jsdom. */
function openActionsMenu(name: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name }), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

const DEVICES: DeviceSummary[] = [
  {
    device_id: "CURRENT",
    display_name: "This laptop",
    last_seen_ip: null,
    last_seen_ts: null,
    is_current: true,
    is_verified: true,
  },
  {
    device_id: "OTHER",
    display_name: "Phone",
    last_seen_ip: null,
    last_seen_ts: null,
    is_current: false,
    is_verified: false,
  },
];

beforeEach(() => {
  listDevices.mockReset().mockResolvedValue(DEVICES);
  crossSigningStatus.mockReset().mockResolvedValue({
    has_master_key: true,
    has_self_signing_key: true,
    has_user_signing_key: true,
  });
  getCrossSigningResetUrl.mockReset().mockResolvedValue(null);
  bootstrapCrossSigning.mockReset().mockResolvedValue(undefined);
  deleteDevice.mockReset().mockResolvedValue(undefined);
  requestDeviceVerification.mockReset().mockResolvedValue("flow-1");
  onSasUpdate.mockReset().mockResolvedValue(vi.fn());
  openUrl.mockReset();
});

describe("DevicesPanel", () => {
  it("groups devices into This device / Verified / Unverified", async () => {
    renderWithProviders(<DevicesPanel />);

    expect(await screen.findByText("This laptop")).toBeInTheDocument();
    expect(screen.getAllByText("This device").length).toBeGreaterThan(0);
    expect(screen.getByText("Phone")).toBeInTheDocument();
    expect(screen.getAllByText("Unverified").length).toBeGreaterThan(0);
  });

  it("offers Set up when cross-signing isn't bootstrapped", async () => {
    crossSigningStatus.mockResolvedValue({
      has_master_key: false,
      has_self_signing_key: false,
      has_user_signing_key: false,
    });
    renderWithProviders(<DevicesPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Set up" }));

    await waitFor(() => expect(bootstrapCrossSigning).toHaveBeenCalled());
  });

  it("shows a Reset link when the homeserver offers an account-management URL", async () => {
    getCrossSigningResetUrl.mockResolvedValue("https://example.org/account");
    renderWithProviders(<DevicesPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Reset" }));

    expect(openUrl).toHaveBeenCalledWith("https://example.org/account");
  });

  it("does not show a Reset link for a password/SSO session", async () => {
    renderWithProviders(<DevicesPanel />);
    await screen.findByText("This laptop");
    expect(screen.queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
  });

  it("revokes another device", async () => {
    renderWithProviders(<DevicesPanel />);
    await screen.findByText("Phone");

    openActionsMenu("Actions for Phone");
    fireEvent.click(await screen.findByText("Sign out"));
    await screen.findByText("Sign out this device?");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(deleteDevice).toHaveBeenCalledWith("OTHER", undefined));
  });
});
