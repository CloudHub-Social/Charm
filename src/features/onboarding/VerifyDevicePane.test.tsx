import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VerifyDevicePane } from "./VerifyDevicePane";

const getCrossSigningResetUrl = vi.fn();
const bootstrapCrossSigning = vi.fn();
let sasUpdateCallbacks: Map<string, (update: { state: "done" | "cancelled" }) => void>;
const verifyMutateAsync = vi.fn();

const UNBOOTSTRAPPED_STATUS = {
  has_master_key: false,
  has_self_signing_key: false,
  has_user_signing_key: false,
};

const BOOTSTRAPPED_STATUS = {
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
  onSasUpdate: vi.fn(
    (flowId: string, callback: (update: { state: "done" | "cancelled" }) => void) => {
      sasUpdateCallbacks.set(flowId, callback);
      return Promise.resolve(() => {
        sasUpdateCallbacks.delete(flowId);
      });
    },
  ),
}));

vi.mock("@/features/settings/useDevices", () => ({
  CROSS_SIGNING_STATUS_QUERY_KEY: ["crossSigningStatus"],
  useCrossSigningResetUrl: () => ({ data: getCrossSigningResetUrl() }),
  useCrossSigningStatus: () => ({ data: crossSigningStatus }),
  useDeviceActions: () => ({
    verify: { mutateAsync: verifyMutateAsync, isPending: false, isError: false, error: null },
    invalidateDevices: vi.fn(),
    invalidateCrossSigning: vi.fn(),
  }),
  useDevices: () => ({ data: devices }),
}));

function renderWithProviders(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

beforeEach(() => {
  getCrossSigningResetUrl.mockReset().mockReturnValue(null);
  bootstrapCrossSigning.mockReset();
  sasUpdateCallbacks = new Map();
  verifyMutateAsync.mockReset().mockResolvedValue("flow-id");
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
        is_verified: false,
      },
    ];
    renderWithProviders(<VerifyDevicePane onNext={vi.fn()} onSkip={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Verify with Desktop" }));

    expect(verifyMutateAsync).toHaveBeenCalledWith("DESKTOP_DEVICE");
    expect(bootstrapCrossSigning).not.toHaveBeenCalled();
  });

  it("lets onboarding continue after the outgoing SAS flow completes", async () => {
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
    await screen.findByRole("button", { name: "Verify with Desktop" });
    sasUpdateCallbacks.get("flow-id")?.({ state: "done" });

    expect(await screen.findByText("This device is set up and trusted.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
  });
});
