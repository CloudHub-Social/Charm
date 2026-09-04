import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import type { LoginResponse } from "@/lib/matrix";
import App from "./App";
import { queryClient } from "./providers";

const tryRestoreSession = vi.fn();
const listRooms = vi.fn();
const getAccountData = vi.fn();
const getLocalOnboardingFlag = vi.fn();
const resetRoomSendQueueBarrier = vi.fn();
const roomSessionMounted = vi.fn();
const roomSessionDisposed = vi.fn();
const onSessionInvalidated = vi.fn();
let sessionInvalidatedCallback: (() => void) | undefined;
let latestLogoutCallback: (() => void) | undefined;
let latestLoginCallback: ((session: { user_id: string; device_id: string }) => void) | undefined;

vi.mock("@/lib/matrix", () => ({
  tryRestoreSession: (...args: unknown[]) => tryRestoreSession(...args),
  listRooms: (...args: unknown[]) => listRooms(...args),
  getAccountData: (...args: unknown[]) => getAccountData(...args),
  setAccountData: () => Promise.resolve(),
  getLocalOnboardingFlag: (...args: unknown[]) => getLocalOnboardingFlag(...args),
  setLocalOnboardingFlag: () => Promise.resolve(),
  onVerificationRequest: () => Promise.resolve(() => {}),
  onSasUpdate: () => Promise.resolve(() => {}),
  onSessionInvalidated: (callback: () => void) => onSessionInvalidated(callback),
}));

vi.mock("@/lib/deepLink", () => ({
  watchDeepLinks: () => Promise.resolve(() => Promise.resolve()),
}));

vi.mock("@/features/auth/LoginScreen", () => ({
  LoginScreen: ({ onSignedIn }: { onSignedIn: (session: LoginResponse) => void }) => {
    latestLoginCallback = onSignedIn;
    return (
      <div>
        login screen
        <button onClick={() => onSignedIn({ user_id: "@me:localhost", device_id: "DEVICE2" })}>
          sign in again
        </button>
      </div>
    );
  },
}));

vi.mock("@/features/rooms/RoomsScreen", () => ({
  RoomsScreen: function RoomSession({ onLoggedOut }: { onLoggedOut: () => void }) {
    latestLogoutCallback = onLoggedOut;
    useEffect(() => {
      roomSessionMounted();
      return () => roomSessionDisposed();
    }, []);
    return <button onClick={onLoggedOut}>trigger logout</button>;
  },
}));

vi.mock("@/features/rooms/useRoomSendQueueBarrier", () => ({
  resetRoomSendQueueBarrier: () => resetRoomSendQueueBarrier(),
}));

vi.mock("@/features/verification/VerificationOverlay", () => ({
  VerificationOverlay: () => null,
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
  listRooms.mockReset().mockResolvedValue([{ room_id: "!seeded:localhost", membership: "join" }]);
  getAccountData.mockReset().mockResolvedValue(null);
  getLocalOnboardingFlag.mockReset().mockResolvedValue(false);
  resetRoomSendQueueBarrier.mockReset();
  roomSessionMounted.mockReset();
  roomSessionDisposed.mockReset();
  sessionInvalidatedCallback = undefined;
  latestLogoutCallback = undefined;
  latestLoginCallback = undefined;
  onSessionInvalidated.mockReset().mockImplementation((callback: () => void) => {
    sessionInvalidatedCallback = callback;
    return Promise.resolve(() => {});
  });
});

describe("App", () => {
  it("disposes room-owned resources before a same-account login on a new device", async () => {
    tryRestoreSession.mockResolvedValue({ user_id: "@me:localhost", device_id: "DEVICE1" });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "trigger logout" }));
    expect(roomSessionDisposed).toHaveBeenCalledOnce();
    expect(resetRoomSendQueueBarrier).toHaveBeenCalledOnce();

    fireEvent.click(await screen.findByRole("button", { name: "sign in again" }));
    await screen.findByRole("button", { name: "trigger logout" });
    expect(roomSessionMounted).toHaveBeenCalledTimes(2);
    expect(roomSessionDisposed).toHaveBeenCalledOnce();
  });

  it("ignores an old settings completion after invalidation and replacement login", async () => {
    const original = { user_id: "@me:localhost", device_id: "DEVICE1" };
    tryRestoreSession.mockResolvedValue(original);
    const reset = vi.fn();
    render(<App onLoggedOut={reset} />);
    await screen.findByRole("button", { name: "trigger logout" });
    const oldCompletion = latestLogoutCallback;
    act(() => sessionInvalidatedCallback?.());
    await screen.findByText("login screen");
    act(() => latestLoginCallback?.({ ...original }));
    await screen.findByRole("button", { name: "trigger logout" });
    queryClient.setQueryData(["replacement-session-sentinel"], "retained");
    act(() => oldCompletion?.());
    expect(screen.getByRole("button", { name: "trigger logout" })).toBeInTheDocument();
    expect(queryClient.getQueryData(["replacement-session-sentinel"])).toBe("retained");
    expect(reset).toHaveBeenCalledOnce();
    queryClient.removeQueries({ queryKey: ["replacement-session-sentinel"] });
  });
  it("waits for the invalidation listener before restoring the session", async () => {
    let markListenerReady: (() => void) | undefined;
    onSessionInvalidated.mockImplementation((callback: () => void) => {
      sessionInvalidatedCallback = callback;
      return new Promise<() => void>((resolve) => {
        markListenerReady = () => resolve(() => {});
      });
    });
    tryRestoreSession.mockResolvedValue({ user_id: "@me:localhost", device_id: "DEVICE1" });

    render(<App />);
    expect(tryRestoreSession).not.toHaveBeenCalled();
    markListenerReady?.();

    await waitFor(() => expect(tryRestoreSession).toHaveBeenCalledOnce());
  });

  it("shows a retryable startup error when the invalidation listener cannot be installed", async () => {
    onSessionInvalidated.mockRejectedValue(new Error("listener unavailable"));
    render(<App />);

    expect(await screen.findByText("Couldn’t restore your session")).toBeInTheDocument();
    expect(tryRestoreSession).not.toHaveBeenCalled();

    onSessionInvalidated.mockImplementation((callback: () => void) => {
      sessionInvalidatedCallback = callback;
      return Promise.resolve(() => {});
    });
    tryRestoreSession.mockResolvedValue(null);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("login screen")).toBeInTheDocument();
  });

  it("ignores a late restore rejection after session invalidation", async () => {
    let rejectRestore!: (error: Error) => void;
    tryRestoreSession.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectRestore = reject;
        }),
    );
    render(<App />);
    await waitFor(() => expect(tryRestoreSession).toHaveBeenCalledOnce());
    sessionInvalidatedCallback?.();
    rejectRestore(new Error("401"));
    expect(await screen.findByText("login screen")).toBeInTheDocument();
    expect(screen.queryByText("Couldn’t restore your session")).not.toBeInTheDocument();
  });

  it("returns to login and clears account state when the backend invalidates the session", async () => {
    tryRestoreSession.mockResolvedValue({ user_id: "@me:localhost", device_id: "DEVICE1" });
    const clearSpy = vi.spyOn(queryClient, "clear");

    render(<App />);
    await screen.findByRole("button", { name: "trigger logout" });
    sessionInvalidatedCallback?.();

    expect(clearSpy).toHaveBeenCalled();
    expect(await screen.findByText("login screen")).toBeInTheDocument();
    clearSpy.mockRestore();
  });

  it("clears the shared query cache and returns to the login screen on logout", async () => {
    tryRestoreSession.mockResolvedValue({ user_id: "@me:localhost", device_id: "DEVICE1" });
    const clearSpy = vi.spyOn(queryClient, "clear");

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "trigger logout" }));

    expect(clearSpy).toHaveBeenCalled();
    expect(resetRoomSendQueueBarrier).toHaveBeenCalledOnce();
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

  it("uses the latest outer reset callback without restarting session restore", async () => {
    tryRestoreSession.mockResolvedValue({ user_id: "@me:localhost", device_id: "DEVICE1" });
    const firstReset = vi.fn();
    const latestReset = vi.fn();

    const { rerender } = render(<App onLoggedOut={firstReset} />);
    await screen.findByRole("button", { name: "trigger logout" });
    rerender(<App onLoggedOut={latestReset} />);
    fireEvent.click(screen.getByRole("button", { name: "trigger logout" }));

    expect(latestReset).toHaveBeenCalledOnce();
    expect(firstReset).not.toHaveBeenCalled();
    expect(tryRestoreSession).toHaveBeenCalledOnce();
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
    listRooms.mockResolvedValue([{ room_id: "!existing:localhost", membership: "join" }]);

    render(<App />);

    expect(await screen.findByRole("button", { name: "trigger logout" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "onboarding screen" })).not.toBeInTheDocument();
  });

  it("keeps an invite-only account in onboarding", async () => {
    tryRestoreSession.mockResolvedValue({ user_id: "@invited:localhost", device_id: "DEVICE1" });
    listRooms.mockResolvedValue([{ room_id: "!invite:localhost", membership: "invite" }]);

    render(<App />);

    expect(await screen.findByRole("button", { name: "onboarding screen" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "trigger logout" })).not.toBeInTheDocument();
  });
});
