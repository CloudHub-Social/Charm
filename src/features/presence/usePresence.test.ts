import { createElement, type PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { describe, expect, it, vi } from "vitest";
import { usePresence } from "./usePresence";
import { presenceAtomFamily } from "./presenceAtoms";
import type { PresenceUpdate } from "@/lib/matrix";

const getPresence = vi.fn();

vi.mock("@/lib/matrix", () => ({
  getPresence: (...args: unknown[]) => getPresence(...args),
}));

function renderWithStore(userId: string | null) {
  const store = createStore();
  const wrapper = ({ children }: PropsWithChildren) => createElement(Provider, { store }, children);
  return { store, ...renderHook(() => usePresence(userId), { wrapper }) };
}

function presenceUpdate(overrides: Partial<PresenceUpdate>): PresenceUpdate {
  return {
    user_id: "@alice:localhost",
    presence: "online",
    status_msg: null,
    last_active_ago_ms: null,
    ...overrides,
  };
}

describe("usePresence", () => {
  it("returns null before anything is known", () => {
    getPresence.mockReturnValue(new Promise(() => {}));
    const { result } = renderWithStore("@alice:localhost");
    expect(result.current).toBeNull();
  });

  it("applies the one-shot fetch result when nothing else has arrived", async () => {
    getPresence.mockResolvedValue(presenceUpdate({ presence: "online" }));
    const { result } = renderWithStore("@alice:localhost");

    await waitFor(() => expect(result.current?.presence).toBe("online"));
  });

  it("does not let a stale in-flight fetch clobber a presence push that arrived first", async () => {
    // Simulates the real race: `usePresence` kicks off `getPresence` because
    // nothing is known yet, but a real-time `presence:update` push (applied
    // directly to the same atom by `usePresenceListener`, independent of
    // this hook) lands before that fetch resolves. The fetch's own result is
    // a snapshot from when it was issued, so it must not win.
    let resolveFetch: (update: PresenceUpdate) => void;
    getPresence.mockReturnValue(
      new Promise<PresenceUpdate>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const { store, result } = renderWithStore("@alice:localhost");

    act(() => {
      store.set(presenceAtomFamily("@alice:localhost"), presenceUpdate({ presence: "offline" }));
    });
    expect(result.current?.presence).toBe("offline");

    act(() => {
      resolveFetch(presenceUpdate({ presence: "online" }));
    });

    // Give the fetch's `.then` a turn to run, then assert it didn't clobber
    // the push — `waitFor` alone can't prove a negative, so this checks the
    // value stays put across a real microtask/macrotask flush.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current?.presence).toBe("offline");
  });
});
