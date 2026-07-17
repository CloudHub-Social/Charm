import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIdlePresence } from "./useIdlePresence";

const setPresence = vi.fn();

vi.mock("@/lib/matrix", () => ({
  setPresence: (...args: unknown[]) => setPresence(...args),
}));

beforeEach(() => {
  vi.useFakeTimers();
  setPresence.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useIdlePresence", () => {
  it("does nothing when idle_timeout_minutes is null", () => {
    renderHook(() =>
      useIdlePresence({
        hide_read_receipts: false,
        hide_typing: false,
        appear_offline: false,
        idle_timeout_minutes: null,
      }),
    );

    vi.advanceTimersByTime(60 * 60_000);
    expect(setPresence).not.toHaveBeenCalled();
  });

  it("does nothing when appear_offline is on, even with a timeout set", () => {
    renderHook(() =>
      useIdlePresence({
        hide_read_receipts: false,
        hide_typing: false,
        appear_offline: true,
        idle_timeout_minutes: 5,
      }),
    );

    vi.advanceTimersByTime(10 * 60_000);
    expect(setPresence).not.toHaveBeenCalled();
  });

  it("sets presence to unavailable after the configured idle timeout with no activity", () => {
    renderHook(() =>
      useIdlePresence({
        hide_read_receipts: false,
        hide_typing: false,
        appear_offline: false,
        idle_timeout_minutes: 5,
      }),
    );

    // Just under the 5-minute timeout — not idle yet.
    vi.advanceTimersByTime(4 * 60_000);
    expect(setPresence).not.toHaveBeenCalled();

    // Past the timeout, on the next 15s poll tick.
    vi.advanceTimersByTime(2 * 60_000);
    expect(setPresence).toHaveBeenCalledWith("unavailable");
  });

  it("resumes to online after activity following an idle transition", () => {
    const { rerender } = renderHook(({ settings }) => useIdlePresence(settings), {
      initialProps: {
        settings: {
          hide_read_receipts: false,
          hide_typing: false,
          appear_offline: false,
          idle_timeout_minutes: 5,
        },
      },
    });

    vi.advanceTimersByTime(6 * 60_000);
    expect(setPresence).toHaveBeenCalledWith("unavailable");
    setPresence.mockClear();

    window.dispatchEvent(new Event("mousemove"));
    rerender({
      settings: {
        hide_read_receipts: false,
        hide_typing: false,
        appear_offline: false,
        idle_timeout_minutes: 5,
      },
    });

    vi.advanceTimersByTime(15_000);
    expect(setPresence).toHaveBeenCalledWith("online");
  });
});
