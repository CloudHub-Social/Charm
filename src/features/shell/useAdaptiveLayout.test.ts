import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useAdaptiveLayout } from "./useAdaptiveLayout";

type Listener = (event: MediaQueryListEvent) => void;

function mockMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<Listener>();
  const mql = {
    get matches() {
      return matches;
    },
    media: "(max-width: 767px)",
    addEventListener: (_: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_: string, listener: Listener) => listeners.delete(listener),
  } as unknown as MediaQueryList;

  window.matchMedia = () => mql;

  return {
    setMatches(next: boolean) {
      matches = next;
      const event = { matches: next } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    },
  };
}

describe("useAdaptiveLayout", () => {
  afterEach(() => {
    // @ts-expect-error -- restoring jsdom's own stub after replacing it per-test
    delete window.matchMedia;
  });

  it("returns desktop when the mobile breakpoint query doesn't match", () => {
    mockMatchMedia(false);
    const { result } = renderHook(() => useAdaptiveLayout());
    expect(result.current).toBe("desktop");
  });

  it("returns mobile when the mobile breakpoint query matches", () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useAdaptiveLayout());
    expect(result.current).toBe("mobile");
  });

  it("switches live when the query's match state changes", () => {
    const media = mockMatchMedia(false);
    const { result } = renderHook(() => useAdaptiveLayout());
    expect(result.current).toBe("desktop");

    act(() => media.setMatches(true));
    expect(result.current).toBe("mobile");

    act(() => media.setMatches(false));
    expect(result.current).toBe("desktop");
  });
});
