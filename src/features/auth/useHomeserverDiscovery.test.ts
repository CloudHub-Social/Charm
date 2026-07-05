import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as matrix from "@/lib/matrix";
import { useHomeserverDiscovery } from "./useHomeserverDiscovery";

describe("useHomeserverDiscovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts idle for empty input", () => {
    const { result } = renderHook(() => useHomeserverDiscovery(""));
    expect(result.current).toEqual({ state: "idle" });
  });

  it("resolves after the debounce delay", async () => {
    const discoverHomeserver = vi
      .spyOn(matrix, "discoverHomeserver")
      .mockResolvedValue({ homeserver_url: "https://matrix-client.matrix.org" });

    const { result } = renderHook(() => useHomeserverDiscovery("matrix.org"));
    expect(result.current).toEqual({ state: "resolving" });
    expect(discoverHomeserver).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(500));

    expect(result.current).toEqual({
      state: "resolved",
      homeserverUrl: "https://matrix-client.matrix.org",
    });
  });

  it("falls back to a failed state when discovery errors", async () => {
    vi.spyOn(matrix, "discoverHomeserver").mockRejectedValue(new Error("not found"));

    const { result } = renderHook(() => useHomeserverDiscovery("not-a-real-server"));
    await act(() => vi.advanceTimersByTimeAsync(500));

    expect(result.current).toEqual({ state: "failed" });
  });

  it("discards a stale in-flight request when the input changes", async () => {
    const discoverHomeserver = vi.spyOn(matrix, "discoverHomeserver");
    discoverHomeserver.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve({ homeserver_url: "stale" }), 1000)),
    );
    discoverHomeserver.mockResolvedValueOnce({ homeserver_url: "https://fresh.example.org" });

    const { result, rerender } = renderHook(({ input }) => useHomeserverDiscovery(input), {
      initialProps: { input: "first.org" },
    });
    await act(() => vi.advanceTimersByTimeAsync(500));

    rerender({ input: "second.org" });
    await act(() => vi.advanceTimersByTimeAsync(1500));

    expect(result.current).toEqual({
      state: "resolved",
      homeserverUrl: "https://fresh.example.org",
    });
  });
});
