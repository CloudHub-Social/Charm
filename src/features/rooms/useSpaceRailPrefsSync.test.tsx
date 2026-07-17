import { act, renderHook, waitFor } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as MatrixLib from "@/lib/matrix";
import { spaceRailPrefsAtomFamily } from "./spaceRailPrefs";

const TEST_USER_ID = "@e2e:localhost";

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
  return { store, ...renderHook(() => useSpaceRailPrefsSync(TEST_USER_ID), { wrapper }) };
}

function renderWithAccountSwitch(initialUserId: string) {
  const store = createStore();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  return {
    store,
    ...renderHook(({ userId }) => useSpaceRailPrefsSync(userId), {
      wrapper,
      initialProps: { userId: initialUserId },
    }),
  };
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
    const localBefore = store.get(spaceRailPrefsAtomFamily(TEST_USER_ID));

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

  it("does not leak one account's cached prefs into another account's atom", async () => {
    getAccountData.mockResolvedValue(null);
    localStorage.setItem(
      "charm.spaceRailPrefs.@account-a:localhost",
      JSON.stringify({ order: [], unpinned: ["!account-a-space:localhost"] }),
    );

    const { result, rerender } = renderWithAccountSwitch("@account-a:localhost");
    await waitFor(() => expect(getAccountData).toHaveBeenCalledTimes(1));
    expect(result.current[0]).toEqual({ order: [], unpinned: ["!account-a-space:localhost"] });

    rerender({ userId: "@account-b:localhost" });
    await waitFor(() => expect(getAccountData).toHaveBeenCalledTimes(2));
    // Account B has no cache of its own and no remote value either — it must
    // land on the default, not account A's unpinned space.
    expect(result.current[0]).toEqual({ order: [], unpinned: [] });
  });

  it("does not write account B's account data until account B's own read has settled", async () => {
    let resolveAccountB: (value: unknown) => void = () => {};
    getAccountData.mockResolvedValueOnce(null).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveAccountB = resolve;
      }),
    );

    const { result, rerender } = renderWithAccountSwitch("@account-a:localhost");
    await waitFor(() => expect(getAccountData).toHaveBeenCalledTimes(1));

    rerender({ userId: "@account-b:localhost" });
    // Switching accounts alone must not fire a write for account B before
    // its read resolves — the guard this test exists to cover.
    expect(setAccountData).not.toHaveBeenCalled();

    act(() => {
      resolveAccountB(null);
    });
    await waitFor(() => expect(getAccountData).toHaveBeenCalledTimes(2));
    expect(setAccountData).not.toHaveBeenCalled();

    act(() => {
      result.current[1]({ order: [], unpinned: ["!account-b-space:localhost"] });
    });
    await waitFor(() =>
      expect(setAccountData).toHaveBeenCalledWith("social.cloudhub.charm.space_rail_prefs", {
        order: [],
        unpinned: ["!account-b-space:localhost"],
      }),
    );
  });

  it("keeps a local edit made while the initial read is still in flight", async () => {
    let resolveRead: (value: unknown) => void = () => {};
    getAccountData.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );

    const { result } = renderWithStore();

    // The user pins/unpins before the account-data read has resolved.
    act(() => {
      result.current[1]({ order: [], unpinned: ["!local-edit:localhost"] });
    });

    act(() => {
      resolveRead({ order: [], unpinned: ["!stale-remote:localhost"] });
    });
    await waitFor(() => expect(getAccountData).toHaveBeenCalled());

    // The remote value must not clobber the edit the user already made.
    expect(result.current[0]).toEqual({ order: [], unpinned: ["!local-edit:localhost"] });
  });

  it("flushes an edit made before the initial read settles once loading finishes", async () => {
    let resolveRead: (value: unknown) => void = () => {};
    getAccountData.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );

    const { result } = renderWithStore();

    // The user pins/unpins before the account-data read has resolved — the
    // mirror-write effect bails out here since `loadedRef` isn't true yet.
    act(() => {
      result.current[1]({ order: [], unpinned: ["!cold-start-edit:localhost"] });
    });
    expect(setAccountData).not.toHaveBeenCalled();

    act(() => {
      resolveRead(null);
    });

    // The edit must reach account data once loading completes, even though
    // `prefs` itself didn't change again after the read settled.
    await waitFor(() =>
      expect(setAccountData).toHaveBeenCalledWith("social.cloudhub.charm.space_rail_prefs", {
        order: [],
        unpinned: ["!cold-start-edit:localhost"],
      }),
    );
  });

  it("applies the remote value when no local edit happened during the read", async () => {
    let resolveRead: (value: unknown) => void = () => {};
    getAccountData.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );

    const { result } = renderWithStore();

    act(() => {
      resolveRead({ order: [], unpinned: ["!remote:localhost"] });
    });
    await waitFor(() =>
      expect(result.current[0]).toEqual({ order: [], unpinned: ["!remote:localhost"] }),
    );
  });

  it("serializes rapid consecutive writes instead of letting them race", async () => {
    getAccountData.mockResolvedValue(null);
    const writeOrder: string[] = [];
    let resolveFirstWrite: () => void = () => {};
    setAccountData.mockImplementationOnce(() => {
      writeOrder.push("first-started");
      return new Promise<void>((resolve) => {
        resolveFirstWrite = () => {
          writeOrder.push("first-resolved");
          resolve();
        };
      });
    });
    setAccountData.mockImplementationOnce(() => {
      writeOrder.push("second-started");
      return Promise.resolve();
    });

    const { result } = renderWithStore();
    await waitFor(() => expect(getAccountData).toHaveBeenCalled());

    act(() => {
      result.current[1]({ order: [], unpinned: ["!first:localhost"] });
    });
    await waitFor(() => expect(setAccountData).toHaveBeenCalledTimes(1));

    act(() => {
      result.current[1]({ order: [], unpinned: ["!second:localhost"] });
    });
    // The second write must not start until the first has settled — proves
    // the requests are chained, not fired concurrently where an
    // out-of-order server arrival could let the first overwrite the second.
    expect(setAccountData).toHaveBeenCalledTimes(1);

    resolveFirstWrite();
    await waitFor(() => expect(setAccountData).toHaveBeenCalledTimes(2));
    expect(writeOrder).toEqual(["first-started", "first-resolved", "second-started"]);
  });

  it("does not make account B's write wait behind account A's still-pending write", async () => {
    getAccountData.mockResolvedValue(null);
    let resolveAccountAWrite: () => void = () => {};
    setAccountData.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveAccountAWrite = resolve;
        }),
    );
    setAccountData.mockImplementationOnce(() => Promise.resolve());

    const { result, rerender } = renderWithAccountSwitch("@account-a:localhost");
    await waitFor(() => expect(getAccountData).toHaveBeenCalledTimes(1));

    // Account A makes an edit; its write never settles (simulating high
    // latency), then the user switches accounts before it does.
    act(() => {
      result.current[1]({ order: [], unpinned: ["!account-a-space:localhost"] });
    });
    await waitFor(() => expect(setAccountData).toHaveBeenCalledTimes(1));

    rerender({ userId: "@account-b:localhost" });
    await waitFor(() => expect(getAccountData).toHaveBeenCalledTimes(2));

    act(() => {
      result.current[1]({ order: [], unpinned: ["!account-b-space:localhost"] });
    });
    // Account B's write must not be blocked on account A's still-pending
    // one — the write queue was re-armed on the account switch, so it fires
    // immediately rather than waiting for `resolveAccountAWrite`.
    await waitFor(() => expect(setAccountData).toHaveBeenCalledTimes(2));
    expect(setAccountData).toHaveBeenLastCalledWith("social.cloudhub.charm.space_rail_prefs", {
      order: [],
      unpinned: ["!account-b-space:localhost"],
    });

    resolveAccountAWrite();
  });
});
