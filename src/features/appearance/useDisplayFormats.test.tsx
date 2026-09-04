import { renderHook } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { clockFormatAtom, dateFormatAtom } from "./atoms";
import { useDisplayFormats } from "./useDisplayFormats";

const rollout = vi.hoisted(() => ({ enabled: false }));
vi.mock("@/featureFlags", () => ({ useFlag: () => rollout.enabled }));

describe("useDisplayFormats", () => {
  it("applies saved formats only while enabled, without erasing preferences", () => {
    const store = createStore();
    store.set(clockFormatAtom, "24h");
    store.set(dateFormatAtom, "year-first");
    rollout.enabled = false;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <Provider store={store}>{children}</Provider>
    );
    const { result, rerender } = renderHook(() => useDisplayFormats(), { wrapper });
    expect(result.current).toEqual({ clockFormat: "locale", dateFormat: "locale" });
    rollout.enabled = true;
    rerender();
    expect(result.current).toEqual({ clockFormat: "24h", dateFormat: "year-first" });
    rollout.enabled = false;
    rerender();
    expect(result.current).toEqual({ clockFormat: "locale", dateFormat: "locale" });
    expect(store.get(clockFormatAtom)).toBe("24h");
    expect(store.get(dateFormatAtom)).toBe("year-first");
  });
});
