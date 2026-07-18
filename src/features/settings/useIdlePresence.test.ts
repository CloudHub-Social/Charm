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

  it("resumes to online after activity following an idle transition", async () => {
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
    // `isIdleRef` only flips once the `setPresence` promise settles (review
    // fix) — flush the microtask queue so that resolution is observed
    // before the next poll relies on it.
    await vi.waitFor(() => {});
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

  it("restores online when auto-idle is disabled while already idle (review fix)", async () => {
    const { rerender } = renderHook(({ settings }) => useIdlePresence(settings), {
      initialProps: {
        settings: {
          hide_read_receipts: false,
          hide_typing: false,
          appear_offline: false,
          idle_timeout_minutes: 5 as number | null,
        },
      },
    });

    vi.advanceTimersByTime(6 * 60_000);
    expect(setPresence).toHaveBeenCalledWith("unavailable");
    // See the equivalent flush above — this transition reads `isIdleRef`
    // synchronously (outside the interval poll), so it must observe the
    // post-settle value.
    await vi.waitFor(() => {});
    setPresence.mockClear();

    rerender({
      settings: {
        hide_read_receipts: false,
        hide_typing: false,
        appear_offline: false,
        idle_timeout_minutes: null,
      },
    });

    expect(setPresence).toHaveBeenCalledWith("online");
  });

  it("retries the online restore when disabling auto-idle while idle hits a transient failure (review fix)", async () => {
    // Review fix (P3): disabling auto-idle while already idle used to send
    // setPresence("online") once and unconditionally clear isIdleRef
    // regardless of success — since disabling auto-idle also tears down
    // the polling interval (the only other retry path), a single transient
    // failure here left sync_presence stuck at unavailable indefinitely,
    // with nothing left to notice and retry it.
    const { rerender } = renderHook(({ settings }) => useIdlePresence(settings), {
      initialProps: {
        settings: {
          hide_read_receipts: false,
          hide_typing: false,
          appear_offline: false,
          idle_timeout_minutes: 5 as number | null,
        },
      },
    });

    vi.advanceTimersByTime(6 * 60_000);
    expect(setPresence).toHaveBeenCalledWith("unavailable");
    await vi.waitFor(() => {});
    setPresence.mockClear();
    setPresence.mockRejectedValueOnce(new Error("transient failure"));

    rerender({
      settings: {
        hide_read_receipts: false,
        hide_typing: false,
        appear_offline: false,
        idle_timeout_minutes: null,
      },
    });

    // The first attempt fails; the retry (after RESTORE_ONLINE_RETRY_DELAY_MS)
    // must still happen even though the polling interval is already gone.
    expect(setPresence).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(setPresence).toHaveBeenCalledTimes(2);
    expect(setPresence).toHaveBeenLastCalledWith("online");
  });

  it("does not restore online when appear_offline turns on while already idle (review fix)", () => {
    // Review fix: an earlier version of this hook shared its "disable"
    // branch between "auto-idle turned off" and "appear_offline turned on",
    // so enabling Appear offline while idle incorrectly sent
    // `setPresence("online")` — racing (and sometimes beating) the Rust
    // `set_privacy_settings` command's own `offline` push. `appearOffline`
    // must be a true no-op here regardless of prior idle state.
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

    rerender({
      settings: {
        hide_read_receipts: false,
        hide_typing: false,
        appear_offline: true,
        idle_timeout_minutes: 5,
      },
    });

    expect(setPresence).not.toHaveBeenCalled();
  });

  it("does not immediately go idle when auto-idle is enabled after a period of inactivity (review fix)", () => {
    // Review fix: `lastActivityRef` is only ever touched while auto-idle
    // is enabled (the activity listeners aren't registered otherwise) —
    // so it can hold a stale mount-time value from well before the user
    // actually enabled the setting. Mount with auto-idle off, let a long
    // stretch of "inactivity" pass, then enable it — this must not
    // immediately treat the user as already idle for the whole timeout.
    const { rerender } = renderHook(({ settings }) => useIdlePresence(settings), {
      initialProps: {
        settings: {
          hide_read_receipts: false,
          hide_typing: false,
          appear_offline: false,
          idle_timeout_minutes: null as number | null,
        },
      },
    });

    vi.advanceTimersByTime(20 * 60_000);
    expect(setPresence).not.toHaveBeenCalled();

    rerender({
      settings: {
        hide_read_receipts: false,
        hide_typing: false,
        appear_offline: false,
        idle_timeout_minutes: 5,
      },
    });

    // Just under the timeout since auto-idle was actually enabled — should
    // not have gone idle yet.
    vi.advanceTimersByTime(4 * 60_000);
    expect(setPresence).not.toHaveBeenCalled();
  });

  it("retries the idle transition on the next poll after a transient setPresence failure (review fix)", async () => {
    // Review fix regression test: `isIdleRef` used to flip to `true`
    // *before* `setPresence` resolved. If that call transiently failed,
    // the ref already reflected "idle" even though the Rust side never
    // actually got the update, so the next poll saw
    // `shouldBeIdle === isIdleRef.current` and silently gave up retrying
    // until the user crossed the idle/active boundary again.
    setPresence.mockRejectedValueOnce(new Error("transient failure"));
    renderHook(() =>
      useIdlePresence({
        hide_read_receipts: false,
        hide_typing: false,
        appear_offline: false,
        idle_timeout_minutes: 5,
      }),
    );

    // Land exactly on the poll that first crosses the timeout, so only a
    // single (rejected) attempt happens before the assertions below —
    // advancing further would let the hook's own next poll retry on its
    // own and mask the bug this test targets.
    vi.advanceTimersByTime(5 * 60_000);
    expect(setPresence).toHaveBeenCalledOnce();
    expect(setPresence).toHaveBeenCalledWith("unavailable");
    // Let the rejection settle without flipping `isIdleRef`.
    await Promise.resolve();
    await Promise.resolve();
    setPresence.mockClear().mockResolvedValue(undefined);

    // The very next poll should retry rather than assuming the transition
    // already succeeded.
    vi.advanceTimersByTime(15_000);
    expect(setPresence).toHaveBeenCalledWith("unavailable");
  });
});
