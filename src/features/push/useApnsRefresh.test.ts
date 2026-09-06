import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useApnsRefresh } from "./useApnsRefresh";

const refresh = vi.fn();
const platform = vi.fn();
let persistedFlagVersion = 0;
vi.mock("@/lib/matrix", () => ({
  refreshPushRegistration: (...args: unknown[]) => refresh(...args),
}));
vi.mock("@/lib/platform", () => ({ preloadPlatformTag: () => Promise.resolve(platform()) }));
vi.mock("@/featureFlags", () => ({
  useFeatureFlagPersistenceVersion: () => persistedFlagVersion,
}));

beforeEach(() => {
  refresh.mockReset().mockResolvedValue(undefined);
  platform.mockReset().mockReturnValue("ios");
  persistedFlagVersion = 0;
});

it("reconciles APNs after a remote flag value is persisted", async () => {
  const view = renderHook(() => useApnsRefresh("@alice:example.org", "DEVICE"));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());

  persistedFlagVersion = 1;
  view.rerender();

  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
});

it("refreshes the restored session and on each foreground transition", async () => {
  renderHook(() => useApnsRefresh("@alice:example.org", "DEVICE"));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(refresh).toHaveBeenCalledTimes(2);
  for (const call of refresh.mock.calls) expect(call).toEqual(["@alice:example.org", "DEVICE"]);
});

it("stops foreground refreshes after logout", async () => {
  const { unmount } = renderHook(() => useApnsRefresh("@alice:example.org", "DEVICE"));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  unmount();
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(refresh).toHaveBeenCalledOnce();
});

it("coalesces foreground callbacks while a refresh is in flight", async () => {
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
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(refresh).toHaveBeenCalledOnce();
  await act(async () => complete());
  expect(refresh).toHaveBeenCalledOnce();
});

it("does not subscribe outside iOS or without an authenticated session", async () => {
  platform.mockReturnValue("web");
  const { rerender } = renderHook(({ user }: { user?: string }) => useApnsRefresh(user, "DEVICE"), {
    initialProps: { user: "@alice:example.org" as string | undefined },
  });
  platform.mockReturnValue("ios");
  rerender({ user: undefined });
  await act(async () => {});
  expect(refresh).not.toHaveBeenCalled();
});
