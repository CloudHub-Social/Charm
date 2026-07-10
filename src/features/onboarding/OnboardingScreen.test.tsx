import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingScreen } from "./OnboardingScreen";
import { renderWithProviders } from "@/test/renderWithProviders";

const crossSigningStatus = vi.fn();
const getCrossSigningResetUrl = vi.fn();
const bootstrapCrossSigning = vi.fn();
const getOwnProfile = vi.fn();
const onSelfProfileUpdate = vi.fn();
const setDisplayName = vi.fn();
const listDevices = vi.fn();
const onSasUpdate = vi.fn();
const requestDeviceVerification = vi.fn();

vi.mock("@/lib/matrix", () => ({
  crossSigningStatus: (...args: unknown[]) => crossSigningStatus(...args),
  getCrossSigningResetUrl: (...args: unknown[]) => getCrossSigningResetUrl(...args),
  bootstrapCrossSigning: (...args: unknown[]) => bootstrapCrossSigning(...args),
  getOwnProfile: (...args: unknown[]) => getOwnProfile(...args),
  onSelfProfileUpdate: (...args: unknown[]) => {
    onSelfProfileUpdate(...args);
    return Promise.resolve(() => {});
  },
  setDisplayName: (...args: unknown[]) => setDisplayName(...args),
  listDevices: (...args: unknown[]) => listDevices(...args),
  onSasUpdate: (...args: unknown[]) => {
    onSasUpdate(...args);
    return Promise.resolve(() => {});
  },
  requestDeviceVerification: (...args: unknown[]) => requestDeviceVerification(...args),
}));

const VERIFIED_CURRENT_DEVICE = {
  device_id: "THIS_DEVICE",
  display_name: "This device",
  last_seen_ip: null,
  last_seen_ts: null,
  is_current: true,
  is_verified: true,
};

const UNVERIFIED_CURRENT_DEVICE = { ...VERIFIED_CURRENT_DEVICE, is_verified: false };

/**
 * The orientation pane's "Continue" is disabled until `crossSigningStatus`
 * resolves (see `OnboardingScreen`'s doc comment) — waiting for it to become
 * enabled here mirrors the real near-instant IPC round trip these tests fake
 * with an already-resolved mock.
 */
async function clickContinue() {
  const button = await screen.findByRole("button", { name: "Continue" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

const UNVERIFIED_STATUS = {
  has_identity: false,
  has_master_key: false,
  has_self_signing_key: false,
  has_user_signing_key: false,
};

const VERIFIED_STATUS = {
  has_identity: true,
  has_master_key: true,
  has_self_signing_key: true,
  has_user_signing_key: true,
};

beforeEach(() => {
  crossSigningStatus.mockReset().mockResolvedValue(UNVERIFIED_STATUS);
  getCrossSigningResetUrl.mockReset().mockResolvedValue(null);
  bootstrapCrossSigning.mockReset().mockResolvedValue(undefined);
  getOwnProfile.mockReset().mockResolvedValue({
    user_id: "@me:localhost",
    display_name: null,
    avatar_url: null,
    avatar_path: null,
    presence: "online",
  });
  setDisplayName.mockReset().mockResolvedValue(undefined);
  listDevices.mockReset().mockResolvedValue([VERIFIED_CURRENT_DEVICE]);
  onSasUpdate.mockReset();
  requestDeviceVerification.mockReset().mockResolvedValue("flow-id");
});

describe("OnboardingScreen", () => {
  it("starts on the orientation pane and advances through verify and profile on Continue", async () => {
    const onDone = vi.fn();
    renderWithProviders(<OnboardingScreen onDone={onDone} />);

    expect(await screen.findByText("Welcome to Charm")).toBeInTheDocument();

    await clickContinue();
    expect(await screen.findByRole("heading", { name: "Verify this device" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("disables Continue until cross-signing status resolves, so an already-verified user can't click through to a stale verify pane", async () => {
    let resolveStatus!: (value: typeof VERIFIED_STATUS) => void;
    crossSigningStatus.mockReset().mockReturnValue(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );
    const onDone = vi.fn();
    renderWithProviders(<OnboardingScreen onDone={onDone} />);

    const continueButton = await screen.findByRole("button", { name: "Continue" });
    expect(continueButton).toBeDisabled();

    resolveStatus(VERIFIED_STATUS);
    await waitFor(() => expect(continueButton).toBeEnabled());
  });

  it("omits the verify pane entirely when the account has cross-signing keys and this device is already trusted", async () => {
    crossSigningStatus.mockResolvedValue(VERIFIED_STATUS);
    const onDone = vi.fn();
    renderWithProviders(<OnboardingScreen onDone={onDone} />);

    expect(await screen.findByText("Welcome to Charm")).toBeInTheDocument();

    await clickContinue();

    expect(await screen.findByText("Say hello")).toBeInTheDocument();
    expect(screen.queryByText("Verify this device")).not.toBeInTheDocument();
  });

  it("still shows the verify pane when the account has cross-signing keys but this device isn't trusted yet", async () => {
    // A brand-new device on an account that already set up cross-signing
    // elsewhere: account-level keys exist, but *this* session hasn't been
    // verified — `crossSigningStatus` alone would wrongly say "verified".
    crossSigningStatus.mockResolvedValue(VERIFIED_STATUS);
    listDevices.mockResolvedValue([UNVERIFIED_CURRENT_DEVICE]);
    const onDone = vi.fn();
    renderWithProviders(<OnboardingScreen onDone={onDone} />);

    expect(await screen.findByText("Welcome to Charm")).toBeInTheDocument();

    await clickContinue();

    expect(await screen.findByRole("heading", { name: "Verify this device" })).toBeInTheDocument();
  });

  it("the top-level Skip control completes onboarding from any pane", async () => {
    const onDone = vi.fn();
    renderWithProviders(<OnboardingScreen onDone={onDone} />);

    await screen.findByText("Welcome to Charm");
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));

    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("saving a display name on the profile pane completes onboarding", async () => {
    crossSigningStatus.mockResolvedValue(VERIFIED_STATUS);
    const onDone = vi.fn();
    renderWithProviders(<OnboardingScreen onDone={onDone} />);

    await clickContinue();
    expect(await screen.findByText("Say hello")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save and finish" }));

    await waitFor(() => expect(setDisplayName).toHaveBeenCalled());
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it("a failed profile save does not block completing onboarding via Not now", async () => {
    crossSigningStatus.mockResolvedValue(VERIFIED_STATUS);
    setDisplayName.mockRejectedValue(new Error("network error"));
    const onDone = vi.fn();
    renderWithProviders(<OnboardingScreen onDone={onDone} />);

    await clickContinue();
    expect(await screen.findByText("Say hello")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save and finish" }));
    await waitFor(() => expect(setDisplayName).toHaveBeenCalled());
    expect(onDone).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
