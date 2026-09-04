import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useApnsRefresh } from "./useApnsRefresh";

const refresh = vi.fn();
const subscribe = vi.fn();
const unregister = vi.fn();
const platform = vi.fn();
let tokenEvent: (payload: { token: string }) => void;
vi.mock("@/lib/matrix", () => ({
  refreshPushRegistration: (...args: unknown[]) => refresh(...args),
}));
vi.mock("@/lib/platform", () => ({ platformTag: () => platform() }));
vi.mock("@tauri-apps/api/core", () => ({
  addPluginListener: (...args: unknown[]) => subscribe(...args),
}));

beforeEach(() => {
  refresh.mockReset().mockResolvedValue(undefined);
  unregister.mockReset().mockResolvedValue(undefined);
  platform.mockReset().mockReturnValue("ios");
  subscribe.mockReset().mockImplementation((_plugin, _event, callback) => {
    tokenEvent = callback;
    return Promise.resolve({ unregister });
  });
});

it("refreshes the restored session after subscribing and ignores duplicate tokens", async () => {
  renderHook(() => useApnsRefresh("@alice:example.org", "DEVICE"));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(subscribe).toHaveBeenCalledWith("notifications", "push-token", expect.any(Function));
  await act(async () => tokenEvent({ token: "first-os-token" }));
  expect(refresh).toHaveBeenCalledTimes(2);
  await act(async () => tokenEvent({ token: "first-os-token" }));
  expect(refresh).toHaveBeenCalledTimes(2);
  await act(async () => tokenEvent({ token: "rotated-os-token" }));
  expect(refresh).toHaveBeenCalledTimes(3);
  for (const call of refresh.mock.calls) expect(call).toEqual(["@alice:example.org", "DEVICE"]);
});

it("stops late callbacks after logout and unsubscribes", async () => {
  const { unmount } = renderHook(() => useApnsRefresh("@alice:example.org", "DEVICE"));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  unmount();
  await act(async () => tokenEvent({ token: "late-token" }));
  expect(refresh).toHaveBeenCalledOnce();
  expect(unregister).toHaveBeenCalledOnce();
});

it("coalesces callbacks while a refresh is in flight", async () => {
  let complete!: () => void;
  refresh.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  renderHook(() => useApnsRefresh("@alice:example.org", "DEVICE"));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  act(() => {
    tokenEvent({ token: "first" });
    tokenEvent({ token: "second" });
  });
  expect(refresh).toHaveBeenCalledOnce();
  await act(async () => complete());
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
});

it("does not subscribe outside iOS or without an authenticated session", async () => {
  platform.mockReturnValue("web");
  const { rerender } = renderHook(({ user }: { user?: string }) => useApnsRefresh(user, "DEVICE"), {
    initialProps: { user: "@alice:example.org" },
  });
  platform.mockReturnValue("ios");
  rerender({ user: undefined });
  await act(async () => {});
  expect(subscribe).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
});
