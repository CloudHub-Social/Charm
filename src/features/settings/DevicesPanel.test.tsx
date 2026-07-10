import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DevicesPanel } from "./DevicesPanel";
import type { DeviceSummary } from "@/lib/matrix";
import { renderWithProviders } from "@/test/renderWithProviders";

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
    has_identity: true,
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
      has_identity: false,
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
      has_identity: false,
      has_master_key: true,
      has_self_signing_key: false,
      has_user_signing_key: false,
    });
    renderWithProviders(<DevicesPanel />);

    expect(await screen.findByRole("button", { name: "Set up" })).toBeInTheDocument();
  });

  it("prompts for the account password on a UIA challenge, then succeeds and refreshes the status", async () => {
    crossSigningStatus.mockResolvedValueOnce({
      has_identity: false,
      has_master_key: false,
      has_self_signing_key: false,
      has_user_signing_key: false,
    });
    bootstrapCrossSigning
      .mockRejectedValueOnce({ kind: "UiaChallenge" })
      .mockResolvedValueOnce(undefined);
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

  it("surfaces a non-UIA bootstrap error on the first attempt instead of prompting for a password", async () => {
    crossSigningStatus.mockResolvedValueOnce({
      has_identity: false,
      has_master_key: false,
      has_self_signing_key: false,
      has_user_signing_key: false,
    });
    bootstrapCrossSigning.mockRejectedValueOnce({ kind: "Other", message: "network error" });
    renderWithProviders(<DevicesPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Set up" }));

    expect(await screen.findByText("network error")).toBeInTheDocument();
    expect(screen.queryByLabelText("Account password")).not.toBeInTheDocument();
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
      has_identity: false,
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

  it("prunes a selected device from the bulk-select state once it's revoked from its own row menu", async () => {
    renderWithProviders(<DevicesPanel />);
    await screen.findByText("Phone");

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Phone" }));
    expect(screen.getByText("1 device selected")).toBeInTheDocument();

    // Revoking has nothing to do with the bulk-select checkbox — it's the
    // row's own "Sign out" action — but it still removes the device from
    // `listDevices`'s next result, which must prune it out of `selectedIds`
    // too, not leave the action bar showing a device that's already gone.
    listDevices.mockResolvedValue([DEVICES[0]]);
    openActionsMenu("Actions for Phone");
    fireEvent.click(await screen.findByText("Sign out"));
    await screen.findByText("Sign out this device?");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(deleteDevice).toHaveBeenCalledWith("OTHER", undefined));
    await waitFor(() => expect(screen.queryByText("Phone")).not.toBeInTheDocument());
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
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

  it("offers no bulk-select checkboxes until the profile query resolves, even for a non-OAuth account", async () => {
    // Devices can arrive before the profile does — without treating
    // "profile still loading" as non-selectable, a deep-linked Devices
    // panel could briefly offer checkboxes for what turns out to be an
    // OAuth account.
    let resolveProfile!: (profile: {
      user_id: string;
      display_name: string | null;
      avatar_url: string | null;
      uses_oauth: boolean;
    }) => void;
    getProfile.mockReturnValue(
      new Promise((resolve) => {
        resolveProfile = resolve;
      }),
    );
    renderWithProviders(<DevicesPanel />);
    await screen.findByText("Phone");

    expect(screen.queryByRole("checkbox", { name: "Select Phone" })).not.toBeInTheDocument();

    resolveProfile({
      user_id: "@me:localhost",
      display_name: "Me",
      avatar_url: null,
      uses_oauth: false,
    });

    expect(await screen.findByRole("checkbox", { name: "Select Phone" })).toBeInTheDocument();
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
    expect(screen.getByRole("dialog", { name: "Sign out 2 devices?" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(deleteDevice).toHaveBeenCalledWith("OTHER", undefined));
    await waitFor(() => expect(deleteDevice).toHaveBeenCalledWith("TABLET", undefined));
  });

  it("uses singular device wording in the bulk sign-out dialog for one selection", async () => {
    renderWithProviders(<DevicesPanel />);
    await screen.findByText("Phone");

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Phone" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out selected" }));

    expect(screen.getByRole("dialog", { name: "Sign out 1 device?" })).toBeInTheDocument();
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
    deleteDevice.mockRejectedValueOnce({ kind: "UiaChallenge" }).mockResolvedValue(undefined);
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

  it("drops a device from the selection once it's actually revoked, even if a later device in the same batch fails", async () => {
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
    // First pass (no password): both hit the UIA challenge.
    // Second pass (with password): OTHER succeeds, TABLET hits a real error.
    deleteDevice.mockImplementation((deviceId: string, password?: string) => {
      if (!password) return Promise.reject({ kind: "UiaChallenge" });
      if (deviceId === "OTHER") return Promise.resolve(undefined);
      return Promise.reject({ kind: "Other", message: "server is temporarily unavailable" });
    });
    renderWithProviders(<DevicesPanel />);
    await screen.findByText("Tablet");

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Phone" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Tablet" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out selected" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    fireEvent.change(await screen.findByLabelText("Current password"), {
      target: { value: "current-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await screen.findByText("server is temporarily unavailable");
    // Close the dialog to inspect the panel underneath — Radix's Dialog
    // aria-hides everything outside its own portal while open, so the
    // panel's checkboxes aren't queryable by role until it's closed.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // OTHER was actually revoked before TABLET failed — it must drop out of
    // the selection instead of staying stuck as "still selected", which
    // would both misreport the count and re-attempt revoking it on retry.
    expect(screen.getByText("1 device selected")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select Phone" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select Tablet" })).toBeChecked();
  });

  it("clears the password-prompt state after a successful bulk sign-out, so the next one starts fresh", async () => {
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
    deleteDevice.mockRejectedValueOnce({ kind: "UiaChallenge" }).mockResolvedValue(undefined);
    renderWithProviders(<DevicesPanel />);
    await screen.findByText("Tablet");

    // First bulk sign-out: hits a UIA challenge, then succeeds with a
    // password — this closes the dialog programmatically (not via the
    // Dialog's own onOpenChange), which must still reset the "needs
    // password" state for next time.
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Phone" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out selected" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    fireEvent.change(await screen.findByLabelText("Current password"), {
      target: { value: "current-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(deleteDevice).toHaveBeenLastCalledWith("OTHER", "current-password"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /Sign out/ })).not.toBeInTheDocument(),
    );

    // Second bulk sign-out, on a fresh selection: must start from the
    // password-less state, not reopen straight into the stale prompt.
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Tablet" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out selected" }));
    await screen.findByRole("dialog", { name: /Sign out/ });
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
  });
});
