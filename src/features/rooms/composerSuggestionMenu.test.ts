import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSuggestionMenu } from "./composerSuggestionMenu";

const ITEMS = [
  { key: "a", label: "Alice" },
  { key: "b", label: "Bob" },
];

describe("useSuggestionMenu", () => {
  it("starts closed", () => {
    const { result } = renderHook(() => useSuggestionMenu());
    expect(result.current.state.open).toBe(false);
  });

  it("opens with items, a position, and activeIndex reset to 0", () => {
    const { result } = renderHook(() => useSuggestionMenu());
    act(() => {
      result.current.open(ITEMS, { top: 10, left: 20 }, vi.fn());
    });
    expect(result.current.state).toMatchObject({
      open: true,
      items: ITEMS,
      activeIndex: 0,
      position: { top: 10, left: 20 },
    });
  });

  it("moveActive wraps around in both directions", () => {
    const { result } = renderHook(() => useSuggestionMenu());
    act(() => result.current.open(ITEMS, { top: 0, left: 0 }, vi.fn()));

    act(() => result.current.moveActive(1));
    expect(result.current.state.activeIndex).toBe(1);

    act(() => result.current.moveActive(1));
    expect(result.current.state.activeIndex).toBe(0);

    act(() => result.current.moveActive(-1));
    expect(result.current.state.activeIndex).toBe(1);
  });

  it("close resets to the empty/closed state", () => {
    const { result } = renderHook(() => useSuggestionMenu());
    act(() => result.current.open(ITEMS, { top: 0, left: 0 }, vi.fn()));
    act(() => result.current.close());
    expect(result.current.state.open).toBe(false);
    expect(result.current.state.items).toEqual([]);
  });

  it("selectActive invokes the onSelect callback with the current activeIndex", () => {
    const onSelect = vi.fn();
    const { result } = renderHook(() => useSuggestionMenu());
    act(() => result.current.open(ITEMS, { top: 0, left: 0 }, onSelect));
    act(() => result.current.moveActive(1));
    act(() => result.current.selectActive());
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("selectIndex invokes onSelect with an explicit index regardless of activeIndex", () => {
    const onSelect = vi.fn();
    const { result } = renderHook(() => useSuggestionMenu());
    act(() => result.current.open(ITEMS, { top: 0, left: 0 }, onSelect));
    act(() => result.current.selectIndex(1));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("update replaces items/position and re-clamps activeIndex", () => {
    const { result } = renderHook(() => useSuggestionMenu());
    act(() => result.current.open(ITEMS, { top: 0, left: 0 }, vi.fn()));
    act(() => result.current.moveActive(1));

    act(() => result.current.update([ITEMS[0]], { top: 5, left: 5 }, vi.fn()));
    expect(result.current.state.items).toHaveLength(1);
    expect(result.current.state.activeIndex).toBe(0);
    expect(result.current.state.position).toEqual({ top: 5, left: 5 });
  });

  it("update opens the menu even when it was never opened (e.g. onStart raced ahead of async data)", () => {
    // Regression: a provider whose first `onStart` call has zero items
    // (still-loading room members, say) bails without calling `open()`. A
    // later `onUpdate` with real items must still make the menu visible —
    // `update()` alone used to only spread `prev.open`, which stayed
    // `false` forever in this sequence.
    const { result } = renderHook(() => useSuggestionMenu());
    expect(result.current.state.open).toBe(false);

    act(() => result.current.update(ITEMS, { top: 0, left: 0 }, vi.fn()));
    expect(result.current.state.open).toBe(true);
    expect(result.current.state.items).toEqual(ITEMS);
  });
});
