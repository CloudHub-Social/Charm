import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TypingUpdate } from "@bindings/TypingUpdate";
import { useRoomListTyping } from "./useRoomListTyping";
import { TYPING_AUTO_HIDE_MS } from "./useChatTyping";

let typingListener: ((update: TypingUpdate) => void) | undefined;
const onTypingUpdate = vi.fn((callback: (update: TypingUpdate) => void) => {
  typingListener = callback;
  return Promise.resolve(() => {});
});

vi.mock("@/lib/matrix", () => ({
  onTypingUpdate: (callback: (update: TypingUpdate) => void) => onTypingUpdate(callback),
}));

beforeEach(() => {
  vi.useFakeTimers();
  onTypingUpdate.mockClear();
  typingListener = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useRoomListTyping", () => {
  it("adds a room once someone other than the current user is typing", () => {
    const { result } = renderHook(() => useRoomListTyping("@me:localhost"));
    expect(result.current.has("!a:localhost")).toBe(false);

    act(() => {
      typingListener?.({ room_id: "!a:localhost", user_ids: ["@other:localhost"] });
    });

    expect(result.current.has("!a:localhost")).toBe(true);
  });

  it("excludes a room where only the current user is typing", () => {
    const { result } = renderHook(() => useRoomListTyping("@me:localhost"));

    act(() => {
      typingListener?.({ room_id: "!a:localhost", user_ids: ["@me:localhost"] });
    });

    expect(result.current.has("!a:localhost")).toBe(false);
  });

  it("removes a room once its typing set becomes empty", () => {
    const { result } = renderHook(() => useRoomListTyping("@me:localhost"));

    act(() => {
      typingListener?.({ room_id: "!a:localhost", user_ids: ["@other:localhost"] });
    });
    expect(result.current.has("!a:localhost")).toBe(true);

    act(() => {
      typingListener?.({ room_id: "!a:localhost", user_ids: [] });
    });
    expect(result.current.has("!a:localhost")).toBe(false);
  });

  it("auto-hides a stale typing notice after TYPING_AUTO_HIDE_MS with no follow-up", () => {
    const { result } = renderHook(() => useRoomListTyping("@me:localhost"));

    act(() => {
      typingListener?.({ room_id: "!a:localhost", user_ids: ["@other:localhost"] });
    });
    expect(result.current.has("!a:localhost")).toBe(true);

    act(() => {
      vi.advanceTimersByTime(TYPING_AUTO_HIDE_MS);
    });
    expect(result.current.has("!a:localhost")).toBe(false);
  });

  it("tracks multiple rooms independently", () => {
    const { result } = renderHook(() => useRoomListTyping("@me:localhost"));

    act(() => {
      typingListener?.({ room_id: "!a:localhost", user_ids: ["@other:localhost"] });
      typingListener?.({ room_id: "!b:localhost", user_ids: ["@other2:localhost"] });
    });

    expect(result.current.has("!a:localhost")).toBe(true);
    expect(result.current.has("!b:localhost")).toBe(true);
  });
});
