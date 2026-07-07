import { act, renderHook } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppearance } from "./useAppearance";

const storeSet = vi.fn();
const load = vi.fn();

vi.mock("@tauri-apps/plugin-store", () => ({
  load: (...args: unknown[]) => load(...args),
}));

beforeEach(() => {
  localStorage.clear();
  storeSet.mockReset();
  load.mockReset().mockResolvedValue({ get: vi.fn(), set: storeSet });
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-density");
  document.documentElement.removeAttribute("data-font-size");
  document.documentElement.removeAttribute("data-reduced-motion");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function wrapper({ children }: { children: ReactNode }) {
  const store = createStore();
  return <Provider store={store}>{children}</Provider>;
}

describe("useAppearance", () => {
  it("setTheme mutates document.documentElement.dataset.theme", async () => {
    const { result } = renderHook(() => useAppearance(), { wrapper });
    act(() => {
      result.current.setTheme("midnight");
    });
    expect(result.current.theme).toBe("midnight");
    expect(document.documentElement.dataset.theme).toBe("midnight");
  });

  it("setFontSize mutates data-font-size and persists", async () => {
    const { result } = renderHook(() => useAppearance(), { wrapper });
    act(() => {
      result.current.setFontSize("xl");
    });
    expect(document.documentElement.dataset.fontSize).toBe("xl");
    await vi.waitFor(() =>
      expect(storeSet).toHaveBeenCalledWith(
        "appearance",
        expect.objectContaining({
          state: expect.objectContaining({ fontSize: "xl" }),
          updatedAt: expect.any(Number),
        }),
      ),
    );
  });

  it("setDensity mutates data-density", () => {
    const { result } = renderHook(() => useAppearance(), { wrapper });
    act(() => {
      result.current.setDensity("compact");
    });
    expect(document.documentElement.dataset.density).toBe("compact");
  });

  it("setReducedMotion mutates data-reduced-motion", () => {
    const { result } = renderHook(() => useAppearance(), { wrapper });
    act(() => {
      result.current.setReducedMotion("on");
    });
    expect(document.documentElement.dataset.reducedMotion).toBe("on");
  });

  it("write-throughs to the localStorage mirror", () => {
    const { result } = renderHook(() => useAppearance(), { wrapper });
    act(() => {
      result.current.setTheme("light");
    });
    const mirrored = JSON.parse(localStorage.getItem("charm:appearance")!);
    expect(mirrored.state.theme).toBe("light");
    expect(mirrored.updatedAt).toEqual(expect.any(Number));
  });
});
