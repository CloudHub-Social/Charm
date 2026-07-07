import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingScreen } from "./OnboardingScreen";

const crossSigningStatus = vi.fn();
const getCrossSigningResetUrl = vi.fn();
const bootstrapCrossSigning = vi.fn();
const getOwnProfile = vi.fn();
const onSelfProfileUpdate = vi.fn();
const setDisplayName = vi.fn();

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
}));

function renderWithProviders(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

const UNVERIFIED_STATUS = {
  has_master_key: false,
  has_self_signing_key: false,
  has_user_signing_key: false,
};

const VERIFIED_STATUS = {
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
});

describe("OnboardingScreen", () => {
  it("starts on the orientation pane and advances through verify and profile on Continue", async () => {
    const onDone = vi.fn();
    renderWithProviders(<OnboardingScreen onDone={onDone} />);

    expect(await screen.findByText("Welcome to Charm")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Verify this device" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("omits the verify pane entirely when the session is already cross-signing-verified", async () => {
    crossSigningStatus.mockResolvedValue(VERIFIED_STATUS);
    const onDone = vi.fn();
    renderWithProviders(<OnboardingScreen onDone={onDone} />);

    expect(await screen.findByText("Welcome to Charm")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("Say hello")).toBeInTheDocument();
    expect(screen.queryByText("Verify this device")).not.toBeInTheDocument();
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

    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
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

    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Say hello")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save and finish" }));
    await waitFor(() => expect(setDisplayName).toHaveBeenCalled());
    expect(onDone).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
