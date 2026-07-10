import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VerifyDevicePane } from "./VerifyDevicePane";
import { renderWithProviders } from "@/test/renderWithProviders";

const getCrossSigningResetUrl = vi.fn();
const bootstrapCrossSigning = vi.fn();
const verifyMutateAsync = vi.fn();
const invalidateDevices = vi.fn();
const invalidateCrossSigning = vi.fn();

const UNBOOTSTRAPPED_STATUS = {
  has_identity: false,
  has_master_key: false,
  has_self_signing_key: false,
  has_user_signing_key: false,
};

const BOOTSTRAPPED_STATUS = {
  has_identity: true,
  has_master_key: true,
  has_self_signing_key: true,
  has_user_signing_key: true,
};

let crossSigningStatus = UNBOOTSTRAPPED_STATUS;
let devices = [
  {
    device_id: "THIS_DEVICE",
    display_name: "This device",
    last_seen_ip: null,
    last_seen_ts: null,
    is_current: true,
    is_verified: false,
  },
];

vi.mock("@/lib/matrix", () => ({
  bootstrapCrossSigning: (...args: unknown[]) => bootstrapCrossSigning(...args),
}));

vi.mock("@/features/settings/useDevices", () => ({
  CROSS_SIGNING_STATUS_QUERY_KEY: ["crossSigningStatus"],
  useCrossSigningResetUrl: () => ({ data: getCrossSigningResetUrl() }),
  useCrossSigningStatus: () => ({ data: crossSigningStatus }),
  useDeviceActions: () => ({
    verify: { mutateAsync: verifyMutateAsync, isPending: false, isError: false, error: null },
    invalidateDevices,
    invalidateCrossSigning,
  }),
  useDevices: () => ({ data: devices }),
}));

beforeEach(() => {
  getCrossSigningResetUrl.mockReset().mockReturnValue(null);
  bootstrapCrossSigning.mockReset();
  verifyMutateAsync.mockReset().mockResolvedValue("flow-id");
  invalidateDevices.mockReset();
  invalidateCrossSigning.mockReset();
  crossSigningStatus = UNBOOTSTRAPPED_STATUS;
  devices = [
    {
      device_id: "THIS_DEVICE",
      display_name: "This device",
      last_seen_ip: null,
      last_seen_ts: null,
      is_current: true,
      is_verified: false,
    },
  ];
});

describe("VerifyDevicePane", () => {
  it("prompts for the account password on a UIA challenge, then succeeds", async () => {
    bootstrapCrossSigning
      .mockRejectedValueOnce({ kind: "UiaChallenge" })
      .mockResolvedValueOnce(undefined);
    renderWithProviders(<VerifyDevicePane onNext={vi.fn()} onSkip={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Verify this device" }));
    fireEvent.change(await screen.findByLabelText("Account password"), {
      target: { value: "current-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(await screen.findByText("This device is set up and trusted.")).toBeInTheDocument();
    expect(bootstrapCrossSigning).toHaveBeenLastCalledWith("current-password");
    expect(invalidateDevices).toHaveBeenCalledOnce();
    expect(invalidateCrossSigning).toHaveBeenCalledOnce();
  });

  it("surfaces a non-UIA error on the first attempt instead of prompting for a password", async () => {
    bootstrapCrossSigning.mockRejectedValueOnce({ kind: "Other", message: "network error" });
    renderWithProviders(<VerifyDevicePane onNext={vi.fn()} onSkip={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Verify this device" }));

    expect(await screen.findByText("network error")).toBeInTheDocument();
    expect(screen.queryByLabelText("Account password")).not.toBeInTheDocument();
  });

  it("can request verification from another device when this session is new", async () => {
    crossSigningStatus = BOOTSTRAPPED_STATUS;
    devices = [
      {
        device_id: "WEB_DEVICE",
        display_name: "This browser",
        last_seen_ip: null,
        last_seen_ts: null,
        is_current: true,
        is_verified: false,
      },
      {
        device_id: "DESKTOP_DEVICE",
        display_name: "Desktop",
        last_seen_ip: null,
        last_seen_ts: null,
        is_current: false,
        is_verified: true,
      },
    ];
    renderWithProviders(<VerifyDevicePane onNext={vi.fn()} onSkip={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Verify with Desktop" }));

    await waitFor(() => expect(verifyMutateAsync).toHaveBeenCalled());
    expect(verifyMutateAsync.mock.calls[0]?.[0]).toBe("DESKTOP_DEVICE");
    expect(bootstrapCrossSigning).not.toHaveBeenCalled();
  });

  it("offers trusted verifier devices when the account identity exists without local signing keys", async () => {
    crossSigningStatus = {
      has_identity: true,
      has_master_key: false,
      has_self_signing_key: false,
      has_user_signing_key: false,
    };
    devices = [
      {
        device_id: "WEB_DEVICE",
        display_name: "This browser",
        last_seen_ip: null,
        last_seen_ts: null,
        is_current: true,
        is_verified: false,
      },
      {
        device_id: "DESKTOP_DEVICE",
        display_name: "Desktop",
        last_seen_ip: null,
        last_seen_ts: null,
        is_current: false,
        is_verified: true,
      },
    ];
    renderWithProviders(<VerifyDevicePane onNext={vi.fn()} onSkip={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Verify with Desktop" }));

    await waitFor(() => expect(verifyMutateAsync).toHaveBeenCalled());
    expect(verifyMutateAsync.mock.calls[0]?.[0]).toBe("DESKTOP_DEVICE");
    expect(bootstrapCrossSigning).not.toHaveBeenCalled();
  });

  it("does not offer cross-device verification before cross-signing is bootstrapped", () => {
    crossSigningStatus = UNBOOTSTRAPPED_STATUS;
    devices = [
      {
        device_id: "WEB_DEVICE",
        display_name: "This browser",
        last_seen_ip: null,
        last_seen_ts: null,
        is_current: true,
        is_verified: false,
      },
      {
        device_id: "DESKTOP_DEVICE",
        display_name: "Desktop",
        last_seen_ip: null,
        last_seen_ts: null,
        is_current: false,
        is_verified: true,
      },
    ];

    renderWithProviders(<VerifyDevicePane onNext={vi.fn()} onSkip={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Verify with Desktop" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verify this device" })).toBeInTheDocument();
  });

  it("does not offer cross-signing setup when already bootstrapped without verifier devices", () => {
    crossSigningStatus = BOOTSTRAPPED_STATUS;
    devices = [
      {
        device_id: "WEB_DEVICE",
        display_name: "This browser",
        last_seen_ip: null,
        last_seen_ts: null,
        is_current: true,
        is_verified: false,
      },
    ];

    renderWithProviders(<VerifyDevicePane onNext={vi.fn()} onSkip={vi.fn()} />);

    expect(
      screen.getByText(
        "Open Charm on a trusted session, then come back here to start verification.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Verify this device" })).not.toBeInTheDocument();
    expect(bootstrapCrossSigning).not.toHaveBeenCalled();
  });

  it("does not offer untrusted sessions as verifier choices", () => {
    crossSigningStatus = BOOTSTRAPPED_STATUS;
    devices = [
      {
        device_id: "WEB_DEVICE",
        display_name: "This browser",
        last_seen_ip: null,
        last_seen_ts: null,
        is_current: true,
        is_verified: false,
      },
      {
        device_id: "UNTRUSTED_DEVICE",
        display_name: "Old browser",
        last_seen_ip: null,
        last_seen_ts: null,
        is_current: false,
        is_verified: false,
      },
    ];

    renderWithProviders(<VerifyDevicePane onNext={vi.fn()} onSkip={vi.fn()} />);

    expect(
      screen.queryByRole("button", { name: "Verify with Old browser" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Open Charm on a trusted session, then come back here to start verification.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
    expect(bootstrapCrossSigning).not.toHaveBeenCalled();
  });

  it("keeps outgoing SAS terminal-state watching centralized in device actions", async () => {
    crossSigningStatus = BOOTSTRAPPED_STATUS;
    devices = [
      {
        device_id: "WEB_DEVICE",
        display_name: "This browser",
        last_seen_ip: null,
        last_seen_ts: null,
        is_current: true,
        is_verified: false,
      },
      {
        device_id: "DESKTOP_DEVICE",
        display_name: "Desktop",
        last_seen_ip: null,
        last_seen_ts: null,
        is_current: false,
        is_verified: true,
      },
    ];
    renderWithProviders(<VerifyDevicePane onNext={vi.fn()} onSkip={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Verify with Desktop" }));
    await waitFor(() => expect(verifyMutateAsync).toHaveBeenCalled());
    expect(verifyMutateAsync.mock.calls[0]?.[0]).toBe("DESKTOP_DEVICE");

    expect(screen.queryByText("This device is set up and trusted.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
  });
});
