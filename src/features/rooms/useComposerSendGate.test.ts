import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useComposerSendGate } from "./useComposerSendGate";

describe("composer send ownership", () => {
  it("excludes competing starts synchronously before a React update", () => {
    const { result } = renderHook(() => useComposerSendGate("account:room", { current: false }));
    act(() => {
      expect(result.current.startVoice()).toBe(true);
      expect(result.current.canSubmit()).toBe(false);
      expect(result.current.startExternal()).toBeNull();
      expect(result.current.canSendVoice()).toBe(true);
    });
    act(() => result.current.updateVoice(false));
    let release!: () => void;
    act(() => {
      release = result.current.startExternal()!;
      expect(result.current.startVoice()).toBe(false);
      expect(result.current.startExternal()).toBeNull();
    });
    act(() => {
      release();
      release();
    });
    expect(result.current.canSubmit()).toBe(true);
  });
  it("rejects stale account/room callbacks and pending preflight completion", () => {
    const blocked = { current: false };
    const { result, rerender, unmount } = renderHook(
      ({ scope }) => useComposerSendGate(scope, blocked),
      {
        initialProps: { scope: "accountA:room" },
      },
    );
    const old = result.current;
    let release!: () => void;
    act(() => {
      release = old.startExternal()!;
    });
    rerender({ scope: "accountB:room" });
    expect(old.startVoice()).toBe(false);
    expect(old.startExternal()).toBeNull();
    act(() => {
      old.updateVoice(true);
      release();
    });
    expect(result.current.canSubmit()).toBe(true);
    const current = result.current;
    blocked.current = true;
    expect(current.startExternal()).toBeNull();
    expect(current.startVoice()).toBe(false);
    unmount();
    expect(current.canSendVoice()).toBe(false);
  });
});
