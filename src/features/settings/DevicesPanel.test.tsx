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
const getDeviceDeleteUrl = vi.fn();
const requestDeviceVerification = vi.fn();
const onSasUpdate = vi.fn();
const getProfile = vi.fn();

vi.mock("@/lib/matrix", () => ({
  listDevices: (...args: unknown[]) => listDevices(...args),
  crossSigningStatus: (...args: unknown[]) => crossSigningStatus(...args),
  getCrossSigningResetUrl: (...args: unknown[]) => getCrossSigningResetUrl(...args),
  bootstrapCrossSigning: (...args: unknown[]) => bootstrapCrossSigning(...args),
  deleteDevice: (...args: unknown[]) => deleteDevice(...args),
  getDeviceDeleteUrl: (...args: unknown[]) => getDeviceDeleteUrl(...args),
  requestDeviceVerification: (...args: unknown[]) => requestDeviceVerification(...args),
  onSasUpdate: (...args: unknown[]) => onSasUpdate(...args),
  getProfile: (...args: unknown[]) => getProfile(...args),
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
  getDeviceDeleteUrl.mockReset().mockResolvedValue(null);
  requestDeviceVerification.mockReset().mockResolvedValue("flow-1");
  onSasUpdate.mockReset().mockResolvedValue(vi.fn());
  openUrl.mockReset();
  getProfile.mockReset().mockResolvedValue({
    user_id: "@me:localhost",
    display_name: "Me",
    avatar_url: null,
    uses_oauth: false,
  });
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

  it("still offers Set up when only some cross-signing keys are present", async () => {
    crossSigningStatus.mockResolvedValue({
      has_master_key: true,
      has_self_signing_key: false,
      has_user_signing_key: false,
    });
    renderWithProviders(<DevicesPanel />);

    expect(await screen.findByRole("button", { name: "Set up" })).toBeInTheDocument();
  });

  it("prompts for the account password on a UIA challenge, then succeeds and refreshes the status", async () => {
    crossSigningStatus.mockResolvedValueOnce({
      has_master_key: false,
      has_self_signing_key: false,
      has_user_signing_key: false,
    });
    bootstrapCrossSigning.mockRejectedValueOnce(new Error("uia")).mockResolvedValueOnce(undefined);
    renderWithProviders(<DevicesPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Set up" }));

    const passwordInput = await screen.findByLabelText("Account password");
    fireEvent.change(passwordInput, { target: { value: "current-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(bootstrapCrossSigning).toHaveBeenLastCalledWith("current-password"));
    // Cross-signing status must be refetched so `isBootstrapped` picks up
    // the change instead of continuing to show "Set up".
    await waitFor(() => expect(crossSigningStatus).toHaveBeenCalledTimes(2));
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

  it("routes an un-bootstrapped OAuth account to account management instead of the in-app password flow", async () => {
    crossSigningStatus.mockResolvedValue({
      has_master_key: false,
      has_self_signing_key: false,
      has_user_signing_key: false,
    });
    getCrossSigningResetUrl.mockResolvedValue("https://example.org/account");
    renderWithProviders(<DevicesPanel />);

    // Wait for the OAuth-specific copy (only rendered once both queries have
    // settled) before clicking, so this doesn't race the in-app "Set up"
    // button's brief presence while `resetUrl` is still pending.
    await screen.findByText(/identity provider/);
    fireEvent.click(screen.getByRole("button", { name: "Set up" }));

    expect(openUrl).toHaveBeenCalledWith("https://example.org/account");
    expect(bootstrapCrossSigning).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Account password")).not.toBeInTheDocument();
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

  it("does not offer bulk-select for an OAuth account, whose devices can only be revoked via account management", async () => {
    getProfile.mockResolvedValue({
      user_id: "@me:localhost",
      display_name: "Me",
      avatar_url: null,
      uses_oauth: true,
    });
    renderWithProviders(<DevicesPanel />);
    await screen.findByText("Phone");

    expect(screen.queryByRole("checkbox", { name: "Select Phone" })).not.toBeInTheDocument();
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
  });

  it("lets a second device start verification while the first is still in flight", async () => {
    const devices: DeviceSummary[] = [
      ...DEVICES,
      {
        device_id: "TABLET",
        display_name: "Tablet",
        last_seen_ip: null,
        last_seen_ts: null,
        is_current: false,
        is_verified: false,
      },
    ];
    listDevices.mockResolvedValue(devices);
    let resolveFirst!: (flowId: string) => void;
    requestDeviceVerification.mockImplementation((deviceId: string) => {
      if (deviceId === "OTHER") {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve("flow-tablet");
    });
    renderWithProviders(<DevicesPanel />);
    await screen.findByText("Tablet");

    openActionsMenu("Actions for Phone");
    fireEvent.click(await screen.findByText("Verify"));
    await waitFor(() => expect(requestDeviceVerification).toHaveBeenCalledWith("OTHER"));

    // The Phone row's own "Verify" request is still pending (unresolved), but
    // that must not disable the Tablet row's — each row tracks its own
    // in-flight state rather than sharing one mutation's `isPending`.
    openActionsMenu("Actions for Tablet");
    const tabletVerify = await screen.findByText("Verify");
    expect(tabletVerify.closest('[role="menuitem"]')).not.toHaveAttribute("data-disabled", "true");
    fireEvent.click(tabletVerify);
    await waitFor(() => expect(requestDeviceVerification).toHaveBeenCalledWith("TABLET"));

    resolveFirst("flow-other");
  });

  it("bulk-signs-out selected devices via the sticky action bar", async () => {
    const devices: DeviceSummary[] = [
      ...DEVICES,
      {
        device_id: "TABLET",
        display_name: "Tablet",
        last_seen_ip: null,
        last_seen_ts: null,
        is_current: false,
        is_verified: false,
      },
    ];
    listDevices.mockResolvedValue(devices);
    renderWithProviders(<DevicesPanel />);
    await screen.findByText("Tablet");

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Phone" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Tablet" }));
    // The current device never gets a selection checkbox — it can't be
    // bulk-revoked.
    expect(screen.queryByRole("checkbox", { name: "Select This laptop" })).not.toBeInTheDocument();

    expect(screen.getByText("2 devices selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign out selected" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(deleteDevice).toHaveBeenCalledWith("OTHER", undefined));
    await waitFor(() => expect(deleteDevice).toHaveBeenCalledWith("TABLET", undefined));
  });

  it("prompts once for a password if bulk sign-out hits a UIA challenge, then retries the remaining devices", async () => {
    const devices: DeviceSummary[] = [
      ...DEVICES,
      {
        device_id: "TABLET",
        display_name: "Tablet",
        last_seen_ip: null,
        last_seen_ts: null,
        is_current: false,
        is_verified: false,
      },
    ];
    listDevices.mockResolvedValue(devices);
    deleteDevice.mockRejectedValueOnce(new Error("uia")).mockResolvedValue(undefined);
    renderWithProviders(<DevicesPanel />);
    await screen.findByText("Tablet");

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Phone" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out selected" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    const passwordInput = await screen.findByLabelText("Current password");
    fireEvent.change(passwordInput, { target: { value: "current-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(deleteDevice).toHaveBeenLastCalledWith("OTHER", "current-password"));
  });
});
