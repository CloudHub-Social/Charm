import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFocusMode } from "./useFocusMode";

const getDndState = vi.fn();
const setDndState = vi.fn();
const onDndChanged = vi.fn();
let dndChangedListener: ((state: { enabled: boolean; until: number | null }) => void) | null = null;

vi.mock("@/lib/matrix", () => ({
  getDndState: (...args: unknown[]) => getDndState(...args),
  setDndState: (...args: unknown[]) => setDndState(...args),
  onDndChanged: (callback: (state: { enabled: boolean; until: number | null }) => void) => {
    onDndChanged(callback);
    dndChangedListener = callback;
    return Promise.resolve(() => {});
  },
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
});
