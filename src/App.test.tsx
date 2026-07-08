import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { queryClient } from "./providers";

const tryRestoreSession = vi.fn();
const listRooms = vi.fn();
const getAccountData = vi.fn();
const getLocalOnboardingFlag = vi.fn();

vi.mock("@/lib/matrix", () => ({
  tryRestoreSession: (...args: unknown[]) => tryRestoreSession(...args),
  listRooms: (...args: unknown[]) => listRooms(...args),
  getAccountData: (...args: unknown[]) => getAccountData(...args),
  setAccountData: () => Promise.resolve(),
  getLocalOnboardingFlag: (...args: unknown[]) => getLocalOnboardingFlag(...args),
  setLocalOnboardingFlag: () => Promise.resolve(),
}));

vi.mock("@/lib/deepLink", () => ({
  watchDeepLinks: () => Promise.resolve(() => Promise.resolve()),
}));

vi.mock("@/features/auth/LoginScreen", () => ({
  LoginScreen: () => <div>login screen</div>,
}));

vi.mock("@/features/rooms/RoomsScreen", () => ({
  RoomsScreen: ({ onLoggedOut }: { onLoggedOut: () => void }) => (
    <button onClick={onLoggedOut}>trigger logout</button>
  ),
}));

// `OnboardingScreen`'s own pane navigation/skip behavior is covered by
// OnboardingScreen.test.tsx; these App-level tests only assert on *whether*
// it mounts, so a stub avoids also having to mock `crossSigningStatus` and
// every other IPC call its panes pull in.
vi.mock("@/features/onboarding/OnboardingScreen", () => ({
  OnboardingScreen: ({ onDone }: { onDone: () => void }) => (
    <button onClick={onDone}>onboarding screen</button>
  ),
}));

beforeEach(() => {
  tryRestoreSession.mockReset();
  // Non-empty room list short-circuits the onboarding gate straight to
  // "done" — the default for tests that only care about the
  // restore/login/logout branches and never want `OnboardingScreen` to
  // mount; overridden per-test below for the onboarding-routing cases.
  listRooms.mockReset().mockResolvedValue([{ room_id: "!seeded:localhost" }]);
  getAccountData.mockReset().mockResolvedValue(null);
  getLocalOnboardingFlag.mockReset().mockResolvedValue(false);
});

describe("App", () => {
  it("clears the shared query cache and returns to the login screen on logout", async () => {
    tryRestoreSession.mockResolvedValue({ user_id: "@me:localhost", device_id: "DEVICE1" });
    const clearSpy = vi.spyOn(queryClient, "clear");

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "trigger logout" }));

    expect(clearSpy).toHaveBeenCalled();
    expect(await screen.findByText("login screen")).toBeInTheDocument();

    clearSpy.mockRestore();
  });

  it("clears a lingering #/settings/<section> hash on logout, so signing back in doesn't reopen it", async () => {
    tryRestoreSession.mockResolvedValue({ user_id: "@me:localhost", device_id: "DEVICE1" });
    window.location.hash = "#/settings/devices";

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "trigger logout" }));

    await screen.findByText("login screen");
    expect(window.location.hash).toBe("");
  });

  it("calls the onLoggedOut prop so a caller can reset state App doesn't own (e.g. main.tsx's Jotai store)", async () => {
    tryRestoreSession.mockResolvedValue({ user_id: "@me:localhost", device_id: "DEVICE1" });
    const onLoggedOut = vi.fn();

    render(<App onLoggedOut={onLoggedOut} />);
    fireEvent.click(await screen.findByRole("button", { name: "trigger logout" }));

    expect(onLoggedOut).toHaveBeenCalled();
  });

  it("routes an account with zero rooms and no onboarding flags to OnboardingScreen instead of RoomsScreen", async () => {
    tryRestoreSession.mockResolvedValue({ user_id: "@new:localhost", device_id: "DEVICE1" });
    listRooms.mockResolvedValue([]);

    render(<App />);

    expect(await screen.findByRole("button", { name: "onboarding screen" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "trigger logout" })).not.toBeInTheDocument();
  });

  it("routes an account with at least one joined room straight to RoomsScreen, never mounting OnboardingScreen", async () => {
    tryRestoreSession.mockResolvedValue({ user_id: "@returning:localhost", device_id: "DEVICE1" });
    listRooms.mockResolvedValue([{ room_id: "!existing:localhost" }]);

    render(<App />);

    expect(await screen.findByRole("button", { name: "trigger logout" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "onboarding screen" })).not.toBeInTheDocument();
  });
});
