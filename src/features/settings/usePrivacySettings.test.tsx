import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSetPrivacySettings } from "./usePrivacySettings";
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
});
