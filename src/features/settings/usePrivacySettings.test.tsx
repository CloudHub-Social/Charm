import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useSetPrivacySettings,
  usePrivacySettings,
  resetPrivacySettingsWriteQueue,
} from "./usePrivacySettings";
import type { PrivacySettings } from "@/lib/matrix";

const setPrivacySettings = vi.fn();
const getPrivacySettings = vi.fn();

vi.mock("@/lib/matrix", () => ({
  setPrivacySettings: (...args: unknown[]) => setPrivacySettings(...args),
  getPrivacySettings: (...args: unknown[]) => getPrivacySettings(...args),
}));

vi.mock("@/lib/platform", () => ({
  isWebBuild: () => false,
}));

const PRIVACY_SETTINGS_QUERY_KEY = ["privacySettings"];

const DEFAULT_SETTINGS: PrivacySettings = {
  hide_read_receipts: false,
  hide_typing: false,
  appear_offline: false,
  idle_timeout_minutes: null,
};

beforeEach(() => {
  setPrivacySettings.mockReset();
  getPrivacySettings.mockReset();
  // The write queue/generation counter are module-level state (by design,
  // shared across every hook instance in the app) — reset between tests so
  // one test's queued/failed writes can't bleed into the next.
  resetPrivacySettingsWriteQueue();
});

function makeWrapper(client: QueryClient) {
  return function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("useSetPrivacySettings", () => {
  it("rolls back the optimistic cache write when the mutation fails (review fix)", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(PRIVACY_SETTINGS_QUERY_KEY, DEFAULT_SETTINGS);
    setPrivacySettings.mockRejectedValueOnce(new Error("disk full"));

    const { result } = renderHook(() => useSetPrivacySettings(), {
      wrapper: makeWrapper(client),
    });

    const optimistic: PrivacySettings = { ...DEFAULT_SETTINGS, hide_typing: true };
    result.current.mutate(optimistic);

    // Once the mutation fails, the cache must roll back to the pre-mutation
    // value — not keep showing the unsaved (and now Rust-enforcement-
    // mismatched) optimistic state.
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(client.getQueryData(PRIVACY_SETTINGS_QUERY_KEY)).toEqual(DEFAULT_SETTINGS);
  });

  it("serializes two quick mutations so the second IPC call never starts before the first settles (review fix)", async () => {
    // Review fix: a later mutation's actual setPrivacySettings call used to
    // fire immediately, in parallel with an earlier still-in-flight one —
    // if the earlier call happened to reach Rust's prefs lock *after* the
    // later one, its stale snapshot would be saved last and silently drop
    // whatever the later toggle added. Two independent hook instances
    // (mirroring two components/renders each calling mutate once) must
    // still serialize through the shared write queue.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(PRIVACY_SETTINGS_QUERY_KEY, DEFAULT_SETTINGS);

    const callOrder: string[] = [];
    let resolveFirst: (() => void) | undefined;
    setPrivacySettings.mockImplementation((settings: PrivacySettings) => {
      if (settings.hide_typing) {
        callOrder.push("start:first");
        return new Promise<void>((resolve) => {
          resolveFirst = () => {
            callOrder.push("end:first");
            resolve();
          };
        });
      }
      callOrder.push("start:second");
      return Promise.resolve();
    });

    const { result: first } = renderHook(() => useSetPrivacySettings(), {
      wrapper: makeWrapper(client),
    });
    const { result: second } = renderHook(() => useSetPrivacySettings(), {
      wrapper: makeWrapper(client),
    });

    first.current.mutate({ ...DEFAULT_SETTINGS, hide_typing: true });
    await waitFor(() => expect(callOrder).toContain("start:first"));

    second.current.mutate({ ...DEFAULT_SETTINGS, appear_offline: true });
    // The second call must not have started yet — it's queued behind the
    // first, which hasn't resolved.
    expect(callOrder).toEqual(["start:first"]);

    resolveFirst?.();
    await waitFor(() => expect(callOrder).toEqual(["start:first", "end:first", "start:second"]));
  });

  it("makes an already-queued write a no-op once the write queue is reset (review fix)", async () => {
    // Review fix: resetPrivacySettingsWriteQueue is called on logout so a
    // write that was still queued behind an earlier one (not yet actually
    // sent to Rust) doesn't execute against whatever account signs in
    // next in the same session.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(PRIVACY_SETTINGS_QUERY_KEY, DEFAULT_SETTINGS);

    let resolveFirst: (() => void) | undefined;
    setPrivacySettings.mockImplementation((settings: PrivacySettings) => {
      if (settings.hide_typing) {
        return new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve();
    });

    const { result: first } = renderHook(() => useSetPrivacySettings(), {
      wrapper: makeWrapper(client),
    });
    const { result: second } = renderHook(() => useSetPrivacySettings(), {
      wrapper: makeWrapper(client),
    });

    first.current.mutate({ ...DEFAULT_SETTINGS, hide_typing: true });
    await waitFor(() => expect(setPrivacySettings).toHaveBeenCalledTimes(1));

    // The second write is enqueued (behind the first) before logout
    // happens. Waits for it to actually reach "pending" — mutationFn
    // invocation (and so this queue's generation capture) happens on a
    // microtask relative to `.mutate()`, not synchronously with it, so
    // resetting immediately after the synchronous call below would
    // reset before the write had actually captured its generation, making
    // this test's ordering unrepresentative of the real logout scenario
    // (a genuinely later, unrelated event).
    second.current.mutate({ ...DEFAULT_SETTINGS, appear_offline: true });
    await waitFor(() => expect(second.current.isPending).toBe(true));
    resetPrivacySettingsWriteQueue();

    // Letting the first request settle should let the queue advance, but
    // the second (queued-before-reset) write must never actually call
    // setPrivacySettings.
    resolveFirst?.();
    await waitFor(() => expect(second.current.isSuccess || second.current.isError).toBe(true));
    expect(setPrivacySettings).toHaveBeenCalledTimes(1);
  });

  it("does not refetch on an older mutation's settlement once a newer one is queued (review fix)", async () => {
    // Review fix: writes are serialized, so the *older* of two queued
    // mutations settles first. Its `onSettled` used to unconditionally
    // invalidate/refetch — that refetch could pull back a first-only
    // persisted snapshot and overwrite the newer mutation's already-cached
    // optimistic (combined) snapshot before the newer write had even
    // reached Rust. Only the latest mutation's settlement should trigger
    // a refetch.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(PRIVACY_SETTINGS_QUERY_KEY, DEFAULT_SETTINGS);
    getPrivacySettings.mockResolvedValue(DEFAULT_SETTINGS);
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    let resolveFirst: (() => void) | undefined;
    let resolveSecond: (() => void) | undefined;
    setPrivacySettings.mockImplementation((settings: PrivacySettings) => {
      if (settings.hide_typing) {
        return new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return new Promise<void>((resolve) => {
        resolveSecond = resolve;
      });
    });

    const { result: first } = renderHook(() => useSetPrivacySettings(), {
      wrapper: makeWrapper(client),
    });
    const { result: second } = renderHook(() => useSetPrivacySettings(), {
      wrapper: makeWrapper(client),
    });

    first.current.mutate({ ...DEFAULT_SETTINGS, hide_typing: true });
    await waitFor(() => expect(setPrivacySettings).toHaveBeenCalledTimes(1));
    second.current.mutate({ ...DEFAULT_SETTINGS, appear_offline: true });
    await waitFor(() => expect(second.current.isPending).toBe(true));

    // The first (older, queued-behind) mutation settles first — its
    // onSettled must not refetch, since a newer mutation is already
    // in flight/cached.
    resolveFirst?.();
    await waitFor(() => expect(first.current.isSuccess).toBe(true));
    expect(invalidateSpy).not.toHaveBeenCalled();

    // The second (latest) mutation settling should trigger the refetch.
    resolveSecond?.();
    await waitFor(() => expect(second.current.isSuccess).toBe(true));
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledTimes(1));
  });

  it("keeps the optimistic value once the mutation succeeds", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(PRIVACY_SETTINGS_QUERY_KEY, DEFAULT_SETTINGS);
    setPrivacySettings.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useSetPrivacySettings(), {
      wrapper: makeWrapper(client),
    });

    const updated: PrivacySettings = { ...DEFAULT_SETTINGS, appear_offline: true };
    result.current.mutate(updated);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryData(PRIVACY_SETTINGS_QUERY_KEY)).toEqual(updated);
  });

  it("does not let an already-in-flight refetch overwrite a newer optimistic write (review fix)", async () => {
    // Review fix: a refetch already running when a mutation starts (e.g.
    // from an earlier invalidation, or a window-focus refetch) used to be
    // able to resolve *after* this mutation's optimistic write and
    // silently clobber it with the older persisted snapshot. onMutate now
    // cancels any in-flight fetch for this key before writing.
    //
    // Deliberately no mounted `usePrivacySettings()` observer here: with
    // one active, onSettled's own (later, legitimate) `invalidateQueries`
    // call would trigger a second real refetch that converges back to the
    // correct value regardless of whether the race in the middle was
    // actually guarded against — masking exactly the bug this test exists
    // to catch. `fetchQuery` still creates a real, cancellable in-flight
    // query without an observer, and `invalidateQueries`'s default
    // `refetchType: 'active'` skips a query with none.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(PRIVACY_SETTINGS_QUERY_KEY, DEFAULT_SETTINGS);

    let resolveStaleFetch: ((settings: PrivacySettings) => void) | undefined;
    getPrivacySettings.mockReturnValue(
      new Promise<PrivacySettings>((resolve) => {
        resolveStaleFetch = resolve;
      }),
    );
    const staleFetch = client.fetchQuery({
      queryKey: PRIVACY_SETTINGS_QUERY_KEY,
      queryFn: getPrivacySettings,
    });
    await waitFor(() =>
      expect(client.getQueryState(PRIVACY_SETTINGS_QUERY_KEY)?.fetchStatus).toBe("fetching"),
    );

    // The mutation's own IPC call deliberately never resolves within this
    // test — isolates the moment right after `onMutate` runs (optimistic
    // write + cancel) from `onSuccess`/`onSettled`'s own later writes,
    // which would otherwise unconditionally re-apply `updated` regardless
    // of whether the race in between was actually guarded against, masking
    // the bug this test exists to catch.
    setPrivacySettings.mockReturnValue(new Promise(() => {}));
    const { result: mutation } = renderHook(() => useSetPrivacySettings(), {
      wrapper: makeWrapper(client),
    });
    const updated: PrivacySettings = { ...DEFAULT_SETTINGS, hide_typing: true };
    mutation.current.mutate(updated);
    await waitFor(() => expect(mutation.current.isPending).toBe(true));
    expect(client.getQueryData(PRIVACY_SETTINGS_QUERY_KEY)).toEqual(updated);

    // The stale in-flight fetch finally resolves with the *old* snapshot —
    // must be discarded (a `CancelledError`) rather than clobbering the
    // optimistic write that's still the only thing in the cache right now.
    resolveStaleFetch?.(DEFAULT_SETTINGS);
    await staleFetch.catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect(client.getQueryData(PRIVACY_SETTINGS_QUERY_KEY)).toEqual(updated);
  });

  it("rolls back to the last confirmed snapshot, not an earlier unconfirmed optimistic write, when both queued mutations fail (review fix)", async () => {
    // Review fix (P2): with two toggles queued before either IPC write
    // settles, the second mutation's `onMutate` captures `previous` from
    // whatever's in the cache at that point — which is already the first
    // mutation's own optimistic (not yet confirmed) write. If both writes
    // then fail, rolling back to that snapshot left the UI showing an
    // unsaved value (e.g. `hide_typing: true`) as if it were real, even
    // though Rust never actually persisted anything beyond `DEFAULT_SETTINGS`.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getPrivacySettings.mockResolvedValue(DEFAULT_SETTINGS);
    // Confirms `DEFAULT_SETTINGS` as the last-known-good snapshot via a real
    // mount of `usePrivacySettings()`'s own query, the same way the app
    // actually populates `lastConfirmedPrivacySettings` — then unmounts it.
    // Deliberately not left mounted: with an active observer, `onSettled`'s
    // own (later, legitimate) `invalidateQueries` call would trigger a real
    // refetch that converges back to `DEFAULT_SETTINGS` regardless of
    // whether `onError`'s rollback target was actually fixed, masking
    // exactly the bug this test exists to catch (same reasoning as the
    // "does not let an already-in-flight refetch..." test above).
    const { result: query, unmount: unmountQuery } = renderHook(() => usePrivacySettings(), {
      wrapper: makeWrapper(client),
    });
    await waitFor(() => expect(query.current.isSuccess).toBe(true));
    unmountQuery();

    // Routed by call order (not by field content) — the second toggle's
    // full snapshot still carries `hide_typing: true` from the first, so
    // distinguishing by that field would misroute it back to "first".
    let rejectFirst: ((err: Error) => void) | undefined;
    let rejectSecond: ((err: Error) => void) | undefined;
    setPrivacySettings.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    setPrivacySettings.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSecond = reject;
        }),
    );

    const { result: first } = renderHook(() => useSetPrivacySettings(), {
      wrapper: makeWrapper(client),
    });
    const { result: second } = renderHook(() => useSetPrivacySettings(), {
      wrapper: makeWrapper(client),
    });

    first.current.mutate({ ...DEFAULT_SETTINGS, hide_typing: true });
    await waitFor(() => expect(setPrivacySettings).toHaveBeenCalledTimes(1));
    second.current.mutate({ ...DEFAULT_SETTINGS, hide_typing: true, appear_offline: true });
    await waitFor(() => expect(second.current.isPending).toBe(true));
    // The second mutation's optimistic write (combining both toggles) is
    // now in the cache — this is the value a naive rollback would restore.
    expect(client.getQueryData(PRIVACY_SETTINGS_QUERY_KEY)).toEqual({
      ...DEFAULT_SETTINGS,
      hide_typing: true,
      appear_offline: true,
    });

    rejectFirst?.(new Error("disk full"));
    await waitFor(() => expect(first.current.isError).toBe(true));
    rejectSecond?.(new Error("disk full"));
    await waitFor(() => expect(second.current.isError).toBe(true));

    expect(client.getQueryData(PRIVACY_SETTINGS_QUERY_KEY)).toEqual(DEFAULT_SETTINGS);
  });
});
