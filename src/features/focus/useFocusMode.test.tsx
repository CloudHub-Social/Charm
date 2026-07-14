import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFocusMode } from "./useFocusMode";

const getDndState = vi.fn();
const setDndState = vi.fn();
const onDndChanged = vi.fn();
let dndChangedListener: ((state: { enabled: boolean; until: number | null }) => void) | null = null;
let inTauri = true;

vi.mock("@/lib/matrix", () => ({
  getDndState: (...args: unknown[]) => getDndState(...args),
  setDndState: (...args: unknown[]) => setDndState(...args),
  onDndChanged: (callback: (state: { enabled: boolean; until: number | null }) => void) => {
    onDndChanged(callback);
    dndChangedListener = callback;
    return Promise.resolve(() => {});
  },
}));

vi.mock("@/lib/platform", () => ({
  isTauri: () => inTauri,
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  getDndState.mockReset().mockResolvedValue({ enabled: false, until: null });
  setDndState
    .mockReset()
    .mockImplementation((enabled: boolean, until: number | null) =>
      Promise.resolve({ enabled, until }),
    );
  onDndChanged.mockReset();
  dndChangedListener = null;
  inTauri = true;
});

describe("useFocusMode", () => {
  it("toggle on: enable() with no duration sets enabled true and until null", async () => {
    const { result } = renderHook(() => useFocusMode(), { wrapper });
    await waitFor(() => expect(result.current.enabled).toBe(false));

    act(() => result.current.enable());

    await waitFor(() => expect(setDndState).toHaveBeenCalledWith(true, null));
    await waitFor(() => expect(result.current.enabled).toBe(true));
  });

  it("toggle off: disable() sets enabled false and until null", async () => {
    getDndState.mockResolvedValue({ enabled: true, until: null });
    const { result } = renderHook(() => useFocusMode(), { wrapper });
    await waitFor(() => expect(result.current.enabled).toBe(true));

    act(() => result.current.disable());

    await waitFor(() => expect(setDndState).toHaveBeenCalledWith(false, null));
    await waitFor(() => expect(result.current.enabled).toBe(false));
  });

  it("enable(ms) computes an until timestamp in the future", async () => {
    const { result } = renderHook(() => useFocusMode(), { wrapper });
    await waitFor(() => expect(result.current.enabled).toBe(false));

    const before = Date.now();
    act(() => result.current.enable(30 * 60_000));

    await waitFor(() => expect(setDndState).toHaveBeenCalled());
    const [, until] = setDndState.mock.calls[0] as [boolean, number];
    expect(until).toBeGreaterThanOrEqual(before + 30 * 60_000);
  });

  it("a dnd:changed event (e.g. from the tray menu) updates the hook's state", async () => {
    const { result } = renderHook(() => useFocusMode(), { wrapper });
    await waitFor(() => expect(result.current.enabled).toBe(false));
    await waitFor(() => expect(dndChangedListener).not.toBeNull());

    act(() => dndChangedListener?.({ enabled: true, until: null }));

    await waitFor(() => expect(result.current.enabled).toBe(true));
  });

  it("re-queries state once a timed DND's `until` passes, without waiting for an unrelated refetch", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const until = Date.now() + 1000;
      getDndState.mockResolvedValueOnce({ enabled: true, until });
      const { result } = renderHook(() => useFocusMode(), { wrapper });
      await vi.waitFor(() => expect(result.current.enabled).toBe(true));

      // Once the timer fires, Rust's `effective()` is the actual source of
      // truth for whether the period really expired — simulate it having
      // auto-cleared server-side by the time the re-query lands.
      getDndState.mockResolvedValueOnce({ enabled: false, until: null });

      await vi.advanceTimersByTimeAsync(1100);

      await vi.waitFor(() => expect(result.current.enabled).toBe(false));
      expect(getDndState).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a stale setDndState confirmation that resolves after a newer request", async () => {
    const { result } = renderHook(() => useFocusMode(), { wrapper });
    await waitFor(() => expect(result.current.enabled).toBe(false));

    let resolveFirst!: (value: { enabled: boolean; until: number | null }) => void;
    let resolveSecond!: (value: { enabled: boolean; until: number | null }) => void;
    setDndState
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );

    // Enable a preset, then immediately disable it — two overlapping calls.
    act(() => result.current.enable(30 * 60_000));
    act(() => result.current.disable());

    await waitFor(() => expect(setDndState).toHaveBeenCalledTimes(2));

    // The *later* request (disable) resolves first, then the *earlier*
    // request (enable) resolves after it — its stale confirmation must not
    // clobber the newer disable's confirmed state.
    act(() => resolveSecond({ enabled: false, until: null }));
    await waitFor(() => expect(result.current.enabled).toBe(false));

    act(() => resolveFirst({ enabled: true, until: Date.now() + 30 * 60_000 }));

    // Give the stale resolution a tick to (incorrectly) apply if the bug
    // were still present, then assert it didn't.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current.enabled).toBe(false);
  });

  // Review fix: `invokeWeb` has no case for `get_dnd_state`/`set_dnd_state`
  // (falls to `unsupported(command)`, a rejected promise), so a caller that
  // renders on every platform — like `RoomList`'s chrome indicator, unlike
  // `FocusPanel` which `SettingsScreen` already excludes from web builds —
  // must not even attempt the query there. Same guard also covers any plain
  // browser context with no Tauri bridge at all (Storybook, web build).
  it("never calls getDndState or subscribes to dnd:changed outside Tauri", async () => {
    inTauri = false;
    const { result } = renderHook(() => useFocusMode(), { wrapper });

    await waitFor(() => expect(result.current.enabled).toBe(false));
    expect(getDndState).not.toHaveBeenCalled();
    expect(onDndChanged).not.toHaveBeenCalled();
  });
});
