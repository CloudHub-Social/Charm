import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePresenceIdle } from "./usePresenceIdle";
import { setPrivacySettings } from "./privacySettings";

const setPresence = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/matrix", () => ({
  setPresence: (...args: unknown[]) => setPresence(...args),
}));

vi.mock("@/lib/platform", () => ({
  isTauri: () => false,
}));

describe("usePresenceIdle (Spec 40, items 3-4)", () => {
  beforeEach(async () => {
    setPresence.mockClear();
    vi.useFakeTimers();
    await setPrivacySettings({ appearOffline: false, autoIdleEnabled: false, idleTimeoutMins: 1 });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await setPrivacySettings({ appearOffline: false, autoIdleEnabled: false, idleTimeoutMins: 10 });
  });

  it("does nothing while the feature flag is off, regardless of settings", async () => {
    await setPrivacySettings({ appearOffline: true });
    renderHook(() => usePresenceIdle(false));
    expect(setPresence).not.toHaveBeenCalled();
  });

  it("forces offline presence when appearOffline is on", async () => {
    await setPrivacySettings({ appearOffline: true });
    renderHook(() => usePresenceIdle(true));
    expect(setPresence).toHaveBeenCalledWith("offline");
  });

  it("does nothing when neither appearOffline nor autoIdleEnabled is set", () => {
    renderHook(() => usePresenceIdle(true));
    expect(setPresence).not.toHaveBeenCalled();
  });

  it("sets presence to unavailable after the configured idle timeout", async () => {
    await setPrivacySettings({ autoIdleEnabled: true, idleTimeoutMins: 1 });
    renderHook(() => usePresenceIdle(true));

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    expect(setPresence).toHaveBeenCalledWith("unavailable");
  });
});
