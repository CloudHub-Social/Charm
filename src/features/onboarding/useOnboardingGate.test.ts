import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deriveOnboardingStatus, useOnboardingGate } from "./useOnboardingGate";

const listRooms = vi.fn();
const getAccountData = vi.fn();
const setAccountData = vi.fn();
const getLocalOnboardingFlag = vi.fn();
const setLocalOnboardingFlag = vi.fn();

vi.mock("@/lib/matrix", () => ({
  listRooms: (...args: unknown[]) => listRooms(...args),
  getAccountData: (...args: unknown[]) => getAccountData(...args),
  setAccountData: (...args: unknown[]) => setAccountData(...args),
  getLocalOnboardingFlag: (...args: unknown[]) => getLocalOnboardingFlag(...args),
  setLocalOnboardingFlag: (...args: unknown[]) => setLocalOnboardingFlag(...args),
}));

beforeEach(() => {
  listRooms.mockReset();
  getAccountData.mockReset();
  setAccountData.mockReset().mockResolvedValue(undefined);
  getLocalOnboardingFlag.mockReset();
  setLocalOnboardingFlag.mockReset().mockResolvedValue(undefined);
});

describe("deriveOnboardingStatus (pure precedence rule)", () => {
  it.each([
    { roomCount: 0, localFlag: false, accountDataPresent: false, expected: "pending" },
    { roomCount: 0, localFlag: true, accountDataPresent: false, expected: "done" },
    { roomCount: 0, localFlag: false, accountDataPresent: true, expected: "done" },
    { roomCount: 0, localFlag: true, accountDataPresent: true, expected: "done" },
    { roomCount: 1, localFlag: false, accountDataPresent: false, expected: "done" },
    { roomCount: 1, localFlag: true, accountDataPresent: false, expected: "done" },
    { roomCount: 1, localFlag: false, accountDataPresent: true, expected: "done" },
    { roomCount: 1, localFlag: true, accountDataPresent: true, expected: "done" },
  ] as const)(
    "rooms=$roomCount local=$localFlag accountData=$accountDataPresent -> $expected",
    ({ roomCount, localFlag, accountDataPresent, expected }) => {
      expect(deriveOnboardingStatus({ roomCount, localFlag, accountDataPresent })).toBe(expected);
    },
  );
});

describe("useOnboardingGate", () => {
  it("is pending for a brand-new account: zero rooms, no local flag, no account-data flag", async () => {
    listRooms.mockResolvedValue([]);
    getLocalOnboardingFlag.mockResolvedValue(false);
    getAccountData.mockResolvedValue(null);

    const { result } = renderHook(() => useOnboardingGate("@new:localhost"));

    await waitFor(() => expect(result.current.status).toBe("pending"));
  });

  it("is done when only the local flag is set", async () => {
    listRooms.mockResolvedValue([]);
    getLocalOnboardingFlag.mockResolvedValue(true);
    getAccountData.mockResolvedValue(null);

    const { result } = renderHook(() => useOnboardingGate("@local-only:localhost"));

    await waitFor(() => expect(result.current.status).toBe("done"));
  });

  it("is done when only the account-data flag is set", async () => {
    listRooms.mockResolvedValue([]);
    getLocalOnboardingFlag.mockResolvedValue(false);
    getAccountData.mockResolvedValue({ completed_at: 1, version: 1 });

    const { result } = renderHook(() => useOnboardingGate("@account-data-only:localhost"));

    await waitFor(() => expect(result.current.status).toBe("done"));
  });

  it("is done when both flags are set", async () => {
    listRooms.mockResolvedValue([]);
    getLocalOnboardingFlag.mockResolvedValue(true);
    getAccountData.mockResolvedValue({ completed_at: 1, version: 1 });

    const { result } = renderHook(() => useOnboardingGate("@both:localhost"));

    await waitFor(() => expect(result.current.status).toBe("done"));
  });

  it("is done immediately for an account with joined rooms, without waiting on either flag", async () => {
    listRooms.mockResolvedValue([{ room_id: "!existing:localhost" }]);
    getLocalOnboardingFlag.mockResolvedValue(false);
    getAccountData.mockResolvedValue(null);

    const { result } = renderHook(() => useOnboardingGate("@returning:localhost"));

    await waitFor(() => expect(result.current.status).toBe("done"));
    // Opportunistic write-back so future launches short-circuit on the flag
    // alone (Spec 12's gating logic, point 1).
    await waitFor(() => expect(setLocalOnboardingFlag).toHaveBeenCalled());
  });

  it("stays loading until a session (user id) is available", () => {
    const { result } = renderHook(() => useOnboardingGate(null));
    expect(result.current.status).toBe("loading");
    expect(listRooms).not.toHaveBeenCalled();
  });

  it("defaults to done if evaluating the gate throws (e.g. offline first launch)", async () => {
    listRooms.mockRejectedValue(new Error("network error"));

    const { result } = renderHook(() => useOnboardingGate("@offline:localhost"));

    await waitFor(() => expect(result.current.status).toBe("done"));
  });

  it("complete() writes both persistence layers and flips status to done", async () => {
    listRooms.mockResolvedValue([]);
    getLocalOnboardingFlag.mockResolvedValue(false);
    getAccountData.mockResolvedValue(null);

    const { result } = renderHook(() => useOnboardingGate("@completing:localhost"));
    await waitFor(() => expect(result.current.status).toBe("pending"));

    await act(async () => {
      await result.current.complete();
    });

    expect(setAccountData).toHaveBeenCalledWith(
      "social.cloudhub.charm.onboarding",
      expect.objectContaining({ version: 1 }),
    );
    expect(setLocalOnboardingFlag).toHaveBeenCalled();
    expect(result.current.status).toBe("done");
  });

  it("a stale complete() call from a since-switched-away account doesn't write or flip status", async () => {
    listRooms.mockResolvedValue([]);
    getLocalOnboardingFlag.mockResolvedValue(false);
    getAccountData.mockResolvedValue(null);

    const { result, rerender } = renderHook(
      ({ userId }: { userId: string }) => useOnboardingGate(userId),
      { initialProps: { userId: "@user-a:localhost" } },
    );
    await waitFor(() => expect(result.current.status).toBe("pending"));
    const staleComplete = result.current.complete;

    // Switch the signed-in account before the stale `complete` (captured
    // above, for @user-a) resolves — e.g. the user logged out and back in
    // as someone else while an onboarding-completion write was in flight.
    rerender({ userId: "@user-b:localhost" });
    await waitFor(() => expect(listRooms).toHaveBeenCalledTimes(2));

    setAccountData.mockClear();
    setLocalOnboardingFlag.mockClear();

    await act(async () => {
      await staleComplete();
    });

    expect(setAccountData).not.toHaveBeenCalled();
    expect(setLocalOnboardingFlag).not.toHaveBeenCalled();
  });
});
