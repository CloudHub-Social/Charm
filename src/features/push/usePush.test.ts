import { createElement, type PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePush } from "./usePush";
import type { PushStatus } from "@/lib/matrix";

let capturedCallback: ((status: PushStatus) => void) | undefined;
const unlisten = vi.fn();
const getPushStatus = vi.fn();
const registerPush = vi.fn();
const unregisterPush = vi.fn();

vi.mock("@/lib/matrix", () => ({
  getPushStatus: (...args: unknown[]) => getPushStatus(...args),
  onPushStatus: (callback: (status: PushStatus) => void) => {
    capturedCallback = callback;
    return Promise.resolve(unlisten);
  },
  registerPush: (...args: unknown[]) => registerPush(...args),
  unregisterPush: (...args: unknown[]) => unregisterPush(...args),
}));

function noneStatus(overrides: Partial<PushStatus> = {}): PushStatus {
  return {
    transport: "none",
    registered: false,
    endpoint_present: false,
    last_error: null,
    available: false,
    ...overrides,
  };
}

function renderWithProviders() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client }, children);
  return renderHook(() => usePush(), { wrapper });
}

describe("usePush", () => {
  beforeEach(() => {
    capturedCallback = undefined;
    unlisten.mockReset();
    getPushStatus.mockReset();
    registerPush.mockReset();
    unregisterPush.mockReset();
  });

  it("fetches status on mount", async () => {
    getPushStatus.mockResolvedValue(noneStatus());
    const { result } = renderWithProviders();

    await waitFor(() => expect(result.current.status?.transport).toBe("none"));
  });

  it("subscribes to push:status and reflects a live update", async () => {
    getPushStatus.mockResolvedValue(noneStatus());
    const { result } = renderWithProviders();
    await waitFor(() => expect(result.current.status).toBeDefined());

    act(() => {
      capturedCallback?.(
        noneStatus({ transport: "unified_push", registered: true, endpoint_present: true }),
      );
    });

    await waitFor(() => expect(result.current.status?.registered).toBe(true));
    expect(result.current.status?.transport).toBe("unified_push");
  });

  it("unlistens on unmount", async () => {
    getPushStatus.mockResolvedValue(noneStatus());
    const { unmount } = renderWithProviders();
    await Promise.resolve();
    unmount();
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalled();
  });

  it("register mutation calls registerPush and refreshes status", async () => {
    getPushStatus.mockResolvedValue(noneStatus());
    registerPush.mockResolvedValue({
      transport: "unified_push",
      registered: true,
      endpoint_present: true,
    });
    const { result } = renderWithProviders();
    await waitFor(() => expect(result.current.status).toBeDefined());

    await act(async () => {
      await result.current.register.mutateAsync();
    });

    expect(registerPush).toHaveBeenCalled();
  });

  it("unregister mutation calls unregisterPush", async () => {
    getPushStatus.mockResolvedValue(noneStatus({ transport: "apns", registered: true }));
    unregisterPush.mockResolvedValue(undefined);
    const { result } = renderWithProviders();
    await waitFor(() => expect(result.current.status).toBeDefined());

    await act(async () => {
      await result.current.unregister.mutateAsync();
    });

    expect(unregisterPush).toHaveBeenCalled();
  });
});
