import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRecentReactions } from "./useRecentReactions";

beforeEach(() => {
  localStorage.clear();
});

describe("useRecentReactions", () => {
  it("starts with the default starter set when nothing is stored", () => {
    const { result } = renderHook(() => useRecentReactions("@alice:example.org"));
    expect(result.current.recent).toEqual(["👍", "❤️", "😂", "🎉"]);
  });

  it.each(["not-json", "[]", "{}", "[1,2]"])(
    "falls back safely when stored reactions are unusable: %s",
    (stored) => {
      localStorage.setItem("charm:recentReactions:%40alice%3Aexample.org", stored);

      const { result } = renderHook(() => useRecentReactions("@alice:example.org"));

      expect(result.current.recent).toEqual(["👍", "❤️", "😂", "🎉"]);
    },
  );

  it("filters non-string entries from an otherwise valid stored list", () => {
    localStorage.setItem(
      "charm:recentReactions:%40alice%3Aexample.org",
      JSON.stringify(["🔥", 1, null, "🎉"]),
    );

    const { result } = renderHook(() => useRecentReactions("@alice:example.org"));

    expect(result.current.recent).toEqual(["🔥", "🎉"]);
  });

  it("moves a recorded emoji to the front and persists it", () => {
    const { result } = renderHook(() => useRecentReactions("@alice:example.org"));

    act(() => {
      result.current.recordReaction("🔥");
    });

    expect(result.current.recent[0]).toBe("🔥");
    expect(
      JSON.parse(localStorage.getItem("charm:recentReactions:%40alice%3Aexample.org") ?? "[]")[0],
    ).toBe("🔥");
  });

  it("deduplicates a re-recorded emoji instead of adding it twice", () => {
    const { result } = renderHook(() => useRecentReactions("@alice:example.org"));

    act(() => {
      result.current.recordReaction("👍");
    });

    expect(result.current.recent.filter((e) => e === "👍")).toHaveLength(1);
    expect(result.current.recent[0]).toBe("👍");
  });

  it("updates other mounted hook instances for the same account", () => {
    const first = renderHook(() => useRecentReactions("@alice:example.org"));
    const second = renderHook(() => useRecentReactions("@alice:example.org"));

    act(() => {
      first.result.current.recordReaction("🔥");
    });

    expect(first.result.current.recent[0]).toBe("🔥");
    expect(second.result.current.recent[0]).toBe("🔥");
  });

  it("does not publish recent reactions to a different account", () => {
    const alice = renderHook(() => useRecentReactions("@alice:example.org"));
    const bob = renderHook(() => useRecentReactions("@bob:example.org"));

    act(() => {
      alice.result.current.recordReaction("🔥");
    });

    expect(alice.result.current.recent[0]).toBe("🔥");
    expect(bob.result.current.recent).toEqual(["👍", "❤️", "😂", "🎉"]);
  });

  it("caps the stored list at 8 entries", () => {
    const { result } = renderHook(() => useRecentReactions("@alice:example.org"));

    act(() => {
      for (const emoji of ["a", "b", "c", "d", "e", "f", "g", "h", "i"]) {
        result.current.recordReaction(emoji);
      }
    });

    expect(result.current.recent).toHaveLength(8);
    expect(result.current.recent[0]).toBe("i");
  });

  it("switches accounts without exposing the previous account's recent reactions", () => {
    const { result, rerender } = renderHook(({ accountId }) => useRecentReactions(accountId), {
      initialProps: { accountId: "@alice:example.org" },
    });

    act(() => {
      result.current.recordReaction("🔥");
    });
    expect(result.current.recent[0]).toBe("🔥");

    rerender({ accountId: "@bob:example.org" });

    expect(result.current.recent).toEqual(["👍", "❤️", "😂", "🎉"]);
  });

  it("records against the new account immediately after an account switch", () => {
    const { result, rerender } = renderHook(({ accountId }) => useRecentReactions(accountId), {
      initialProps: { accountId: "@alice:example.org" },
    });
    act(() => result.current.recordReaction("🔥"));

    rerender({ accountId: "@bob:example.org" });
    act(() => result.current.recordReaction("🚀"));

    expect(result.current.recent[0]).toBe("🚀");
    expect(
      JSON.parse(localStorage.getItem("charm:recentReactions:%40bob%3Aexample.org") ?? "[]"),
    ).toEqual(["🚀", "👍", "❤️", "😂", "🎉"]);
  });

  it("keeps the in-memory ordering when localStorage is unavailable", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    const { result } = renderHook(() => useRecentReactions("@alice:example.org"));

    act(() => result.current.recordReaction("🔥"));

    expect(result.current.recent[0]).toBe("🔥");
    setItem.mockRestore();
  });

  it("still updates same-account instances when localStorage is unavailable", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    const first = renderHook(() => useRecentReactions("@alice:example.org"));
    const second = renderHook(() => useRecentReactions("@alice:example.org"));

    act(() => first.result.current.recordReaction("🔥"));

    expect(second.result.current.recent[0]).toBe("🔥");
    setItem.mockRestore();
  });
});
