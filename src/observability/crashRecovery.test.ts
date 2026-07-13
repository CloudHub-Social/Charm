import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkUncleanPreviousSession } from "./crashRecovery";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

vi.mock("@/lib/platform", () => ({
  isTauri: () => mocks.isTauri(),
}));

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.isTauri.mockReset().mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("checkUncleanPreviousSession", () => {
  it("is always false outside Tauri, without calling invoke", async () => {
    mocks.isTauri.mockReturnValue(false);

    await expect(checkUncleanPreviousSession()).resolves.toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("reflects the Rust command's true result", async () => {
    mocks.invoke.mockResolvedValue(true);

    await expect(checkUncleanPreviousSession()).resolves.toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("had_unclean_previous_session");
  });

  it("reflects the Rust command's false result", async () => {
    mocks.invoke.mockResolvedValue(false);

    await expect(checkUncleanPreviousSession()).resolves.toBe(false);
  });

  it("resolves false when the IPC call rejects", async () => {
    mocks.invoke.mockRejectedValue(new Error("no such command"));

    await expect(checkUncleanPreviousSession()).resolves.toBe(false);
  });

  it("resolves false instead of hanging forever when the IPC call never resolves (mirrors bootstrapSentryWithTimeout's blank-page fix)", async () => {
    vi.useFakeTimers();
    mocks.invoke.mockReturnValue(
      new Promise(() => {
        // Never resolves — simulates a stuck Tauri IPC round-trip.
      }),
    );

    const result = checkUncleanPreviousSession(3000);
    await vi.advanceTimersByTimeAsync(3000);

    await expect(result).resolves.toBe(false);
  });

  it("resolves true from a slow-but-eventually-successful call made before the timeout", async () => {
    vi.useFakeTimers();
    let resolveInvoke!: (value: boolean) => void;
    mocks.invoke.mockReturnValue(
      new Promise((resolve) => {
        resolveInvoke = resolve;
      }),
    );

    const result = checkUncleanPreviousSession(3000);
    resolveInvoke(true);
    await vi.advanceTimersByTimeAsync(0);

    await expect(result).resolves.toBe(true);
  });
});
