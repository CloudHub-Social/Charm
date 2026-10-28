import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAdaptiveLayout, useAdaptiveLayoutState } from "./useAdaptiveLayout";

type Listener = () => void;

function mockMedia(initialWidth: number) {
  let width = initialWidth;
  const capabilities = new Set<string>();
  const queries = new Map<string, { mql: MediaQueryList; listeners: Set<Listener> }>();
  vi.stubGlobal("matchMedia", (query: string) => {
    if (!queries.has(query)) {
      const listeners = new Set<Listener>();
      const mql = {
        get matches() {
          if (query === "(min-width: 768px)") return width >= 768;
          if (query === "(min-width: 1200px)") return width >= 1200;
          if (query === "(max-width: 767px)") return width < 768;
          return capabilities.has(query);
        },
        media: query,
        addEventListener: (_: string, listener: Listener) => listeners.add(listener),
        removeEventListener: (_: string, listener: Listener) => listeners.delete(listener),
      } as unknown as MediaQueryList;
      queries.set(query, { mql, listeners });
    }
    return queries.get(query)!.mql;
  });
  const notify = () =>
    queries.forEach(({ listeners }) => listeners.forEach((listener) => listener()));
  return {
    resize(next: number) {
      width = next;
      notify();
    },
    capabilities(...next: string[]) {
      capabilities.clear();
      next.forEach((query) => capabilities.add(query));
      notify();
    },
    listenerCount: () =>
      [...queries.values()].reduce((sum, entry) => sum + entry.listeners.size, 0),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("adaptive width and input capabilities", () => {
  it.each([
    [390, "compact", "mobile"],
    [767, "compact", "mobile"],
    [768, "medium", "desktop"],
    [834, "medium", "desktop"],
    [1024, "medium", "desktop"],
    [1199, "medium", "desktop"],
    [1200, "wide", "desktop"],
    [1440, "wide", "desktop"],
  ])("classifies %ipx while preserving legacy consumers", (width, adaptive, legacy) => {
    mockMedia(Number(width));
    const { result } = renderHook(() => ({
      adaptive: useAdaptiveLayoutState(),
      legacy: useAdaptiveLayout(),
    }));
    expect(result.current.adaptive.width).toBe(adaptive);
    expect(result.current.legacy).toBe(legacy);
  });

  it("handles resize and hybrid input changes independently and cleans up subscriptions", () => {
    const media = mockMedia(390);
    const { result, unmount } = renderHook(() => useAdaptiveLayoutState());
    act(() => media.capabilities("(pointer: fine)", "(hover: hover)", "(any-pointer: fine)"));
    expect(result.current).toMatchObject({ width: "compact", pointer: "fine", hover: true });
    act(() => media.resize(834));
    act(() =>
      media.capabilities("(pointer: coarse)", "(any-pointer: coarse)", "(any-pointer: fine)"),
    );
    expect(result.current).toEqual({
      width: "medium",
      pointer: "coarse",
      hover: false,
      anyCoarsePointer: true,
      anyFinePointer: true,
    });
    act(() => media.resize(1440));
    expect(result.current.width).toBe("wide");
    expect(result.current.pointer).toBe("coarse");
    act(() => media.resize(767));
    expect(result.current.width).toBe("compact");
    expect(media.listenerCount()).toBe(7);
    unmount();
    expect(media.listenerCount()).toBe(0);
  });

  it("uses a conservative width and no inferred input without matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    const { result } = renderHook(() => useAdaptiveLayoutState());
    expect(result.current).toEqual({
      width: "compact",
      pointer: "none",
      hover: false,
      anyCoarsePointer: false,
      anyFinePointer: false,
    });
  });
});
