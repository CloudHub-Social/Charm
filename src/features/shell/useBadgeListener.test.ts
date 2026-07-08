import { createElement, type PropsWithChildren } from "react";
import { renderHook } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { describe, expect, it, vi } from "vitest";
import { useBadgeListener } from "./useBadgeListener";
import { badgeAtom } from "./badgeAtom";
import type { BadgeState } from "@/lib/matrix";

let capturedCallback: ((badge: BadgeState) => void) | undefined;
const unlisten = vi.fn();

vi.mock("@/lib/matrix", () => ({
  onBadgeUpdate: (callback: (badge: BadgeState) => void) => {
    capturedCallback = callback;
    return Promise.resolve(unlisten);
  },
}));

function renderWithStore() {
  const store = createStore();
  const wrapper = ({ children }: PropsWithChildren) => createElement(Provider, { store }, children);
  return { store, ...renderHook(() => useBadgeListener(), { wrapper }) };
}

describe("useBadgeListener", () => {
  it("subscribes to badge:update on mount", () => {
    renderWithStore();
    expect(capturedCallback).toBeDefined();
  });

  it("applies an incoming badge:update to badgeAtom", () => {
    const { store } = renderWithStore();

    capturedCallback?.({ total_unread: 4, total_highlight: 2, spaces: {} });

    expect(store.get(badgeAtom)).toEqual({ total_unread: 4, total_highlight: 2, spaces: {} });
  });

  it("unlistens on unmount", async () => {
    const { unmount } = renderWithStore();
    unmount();
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalled();
  });
});
