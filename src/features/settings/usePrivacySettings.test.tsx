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
