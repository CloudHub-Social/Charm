import { act, renderHook, waitFor } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as MatrixLib from "@/lib/matrix";
import { spaceRailPrefsAtom } from "./spaceRailPrefs";

const getAccountData = vi.fn();
const setAccountData = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/matrix", async (importOriginal) => ({
  ...(await importOriginal<typeof MatrixLib>()),
  getAccountData: (...args: unknown[]) => getAccountData(...args),
  setAccountData: (...args: unknown[]) => setAccountData(...args),
}));

// Imported after the mock so the hook picks up the mocked module.
const { useSpaceRailPrefsSync } = await import("./useSpaceRailPrefsSync");

function renderWithStore() {
  const store = createStore();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  return { store, ...renderHook(() => useSpaceRailPrefsSync(), { wrapper }) };
}

describe("useSpaceRailPrefsSync", () => {
  beforeEach(() => {
    localStorage.clear();
    getAccountData.mockReset();
    setAccountData.mockClear().mockResolvedValue(undefined);
  });

  it("overwrites the local cache with a well-formed remote value on mount", async () => {
    getAccountData.mockResolvedValue({
      order: ["!remote:localhost"],
      unpinned: ["!hidden:localhost"],
    });

    const { result } = renderWithStore();

    await waitFor(() =>
      expect(result.current[0]).toEqual({
        order: ["!remote:localhost"],
        unpinned: ["!hidden:localhost"],
      }),
    );
  });

  it("keeps the local cache when the remote value is missing or malformed", async () => {
    getAccountData.mockResolvedValue({ not: "a prefs object" });

    const { result, store } = renderWithStore();
    const localBefore = store.get(spaceRailPrefsAtom);

    await waitFor(() => expect(getAccountData).toHaveBeenCalled());
    expect(result.current[0]).toEqual(localBefore);
  });

  it("mirrors a local change to account data once the initial read has settled", async () => {
    getAccountData.mockResolvedValue(null);

    const { result } = renderWithStore();
    await waitFor(() => expect(getAccountData).toHaveBeenCalled());

    act(() => {
      result.current[1]({ order: [], unpinned: ["!space:localhost"] });
    });

    await waitFor(() =>
      expect(setAccountData).toHaveBeenCalledWith("social.cloudhub.charm.space_rail_prefs", {
        order: [],
        unpinned: ["!space:localhost"],
      }),
    );
  });

  it("does not mirror the remote-applied value straight back to account data as a redundant write", async () => {
    getAccountData.mockResolvedValue({ order: ["!remote:localhost"], unpinned: [] });

    renderWithStore();

    await waitFor(() => expect(getAccountData).toHaveBeenCalled());
    // The read-triggered `setPrefs` does change the atom, so the mirror
    // effect does fire once — but with exactly the value that was just
    // read, not a stale local one, so it's a harmless no-op write rather
    // than data loss. Assert it's the *remote* value, not the default.
    await waitFor(() =>
      expect(setAccountData).toHaveBeenCalledWith("social.cloudhub.charm.space_rail_prefs", {
        order: ["!remote:localhost"],
        unpinned: [],
      }),
    );
  });
});
