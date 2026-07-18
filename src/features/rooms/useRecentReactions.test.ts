import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useRecentReactions } from "./useRecentReactions";

beforeEach(() => {
  localStorage.clear();
});

describe("useRecentReactions", () => {
  it("starts with the default starter set when nothing is stored", () => {
    const { result } = renderHook(() => useRecentReactions());
    expect(result.current.recent).toEqual(["👍", "❤️", "😂", "🎉"]);
  });

  it("moves a recorded emoji to the front and persists it", () => {
    const { result } = renderHook(() => useRecentReactions());

    act(() => {
      result.current.recordReaction("🔥");
    });

    expect(result.current.recent[0]).toBe("🔥");
    expect(JSON.parse(localStorage.getItem("charm:recentReactions") ?? "[]")[0]).toBe("🔥");
  });

  it("deduplicates a re-recorded emoji instead of adding it twice", () => {
    const { result } = renderHook(() => useRecentReactions());

    act(() => {
      result.current.recordReaction("👍");
    });

    expect(result.current.recent.filter((e) => e === "👍")).toHaveLength(1);
    expect(result.current.recent[0]).toBe("👍");
  });

  it("caps the stored list at 8 entries", () => {
    const { result } = renderHook(() => useRecentReactions());

    act(() => {
      for (const emoji of ["a", "b", "c", "d", "e", "f", "g", "h", "i"]) {
        result.current.recordReaction(emoji);
      }
    });

    expect(result.current.recent).toHaveLength(8);
    expect(result.current.recent[0]).toBe("i");
  });
});
