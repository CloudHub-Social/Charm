import { createStore } from "jotai";
import { describe, expect, it } from "vitest";
import { badgeAtom, badgeUpdateValue } from "./badgeAtom";
import type { BadgeState } from "@/lib/matrix";

describe("badgeAtom", () => {
  it("starts as null before any badge:update has arrived", () => {
    const store = createStore();
    expect(store.get(badgeAtom)).toBeNull();
  });

  it("holds the last badge:update payload applied via badgeUpdateValue", () => {
    const store = createStore();
    const update: BadgeState = { total_unread: 3, total_highlight: 1 };

    const next = badgeUpdateValue(update);
    store.set(badgeAtom, next);

    expect(store.get(badgeAtom)).toEqual(update);
    expect(next).not.toBe(update);
  });

  it("replaces the previous value on a subsequent update", () => {
    const store = createStore();
    store.set(badgeAtom, badgeUpdateValue({ total_unread: 3, total_highlight: 1 }));
    store.set(badgeAtom, badgeUpdateValue({ total_unread: 0, total_highlight: 0 }));

    expect(store.get(badgeAtom)).toEqual({ total_unread: 0, total_highlight: 0 });
  });
});
