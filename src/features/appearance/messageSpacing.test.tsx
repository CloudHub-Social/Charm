import { renderHook } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { messageSpacingAtom } from "./atoms";
import { MESSAGE_SPACING_LABELS, type MessageSpacing, useMessageSpacing } from "./messageSpacing";

const rollout = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/featureFlags", () => ({ useFlag: () => rollout.enabled }));

describe("message spacing", () => {
  it.each(Object.keys(MESSAGE_SPACING_LABELS) as MessageSpacing[])(
    "applies level %s only while enabled",
    (spacing) => {
      const store = createStore();
      store.set(messageSpacingAtom, spacing);
      rollout.enabled = true;
      const wrapper = ({ children }: { children: ReactNode }) => (
        <Provider store={store}>{children}</Provider>
      );
      const { result, rerender } = renderHook(() => useMessageSpacing(), { wrapper });
      expect(result.current).toEqual(
        spacing === "0" ? undefined : { marginBottom: `${spacing}px` },
      );
      rollout.enabled = false;
      rerender();
      expect(result.current).toBeUndefined();
      expect(store.get(messageSpacingAtom)).toBe(spacing);
    },
  );
});
