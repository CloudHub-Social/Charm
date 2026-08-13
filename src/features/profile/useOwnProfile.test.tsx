import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "@/providers";
import { useOwnProfile } from "./useOwnProfile";
import { featureFlagTestHooks } from "@/featureFlags";

const getOwnProfile = vi.fn();
let selfProfileCallback:
  | ((update: { display_name: string | null; avatar_url: string | null }) => void)
  | undefined;

vi.mock("@/lib/matrix", () => ({
  getOwnProfile: (avatarPresenceVisualsEnabled?: boolean) =>
    getOwnProfile(avatarPresenceVisualsEnabled),
  onSelfProfileUpdate: (callback: typeof selfProfileCallback) => {
    selfProfileCallback = callback;
    return Promise.resolve(() => {
      selfProfileCallback = undefined;
    });
  },
}));

// `useOwnProfile` invalidates the app-wide `queryClient` singleton directly
// (see its doc comment) rather than one obtained via `useQueryClient()`, so
// the wrapper must render against that same instance for invalidation to
// have any effect — a fresh per-test `QueryClient` wouldn't be the one
// getting invalidated.
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  getOwnProfile.mockReset();
  featureFlagTestHooks.reset();
  queryClient.clear();
  selfProfileCallback = undefined;
});

describe("useOwnProfile", () => {
  it("fetches the signed-in user's own profile", async () => {
    getOwnProfile.mockResolvedValueOnce({
      user_id: "@me:localhost",
      display_name: "Me",
      avatar_url: null,
      avatar_path: null,
      presence: "online",
    });

    const { result } = renderHook(() => useOwnProfile(), { wrapper });

    await waitFor(() => expect(result.current.data?.display_name).toBe("Me"));
    expect(getOwnProfile).toHaveBeenCalledWith(false);
  });

  it("refetches with the current avatar-presence decision when the flag changes", async () => {
    getOwnProfile
      .mockResolvedValueOnce({
        user_id: "@me:localhost",
        display_name: "Me",
        avatar_url: null,
        avatar_path: null,
        presence: "offline",
      })
      .mockResolvedValueOnce({
        user_id: "@me:localhost",
        display_name: "Me",
        avatar_url: null,
        avatar_path: null,
        presence: "dnd",
      });
    const { result } = renderHook(() => useOwnProfile(), { wrapper });
    await waitFor(() => expect(result.current.data?.presence).toBe("offline"));

    act(() => featureFlagTestHooks.setCache({ avatar_presence_visuals: true }));

    await waitFor(() => expect(result.current.data?.presence).toBe("dnd"));
    expect(getOwnProfile).toHaveBeenLastCalledWith(true);
  });

  it("refetches when a profile:self event arrives", async () => {
    getOwnProfile
      .mockResolvedValueOnce({
        user_id: "@me:localhost",
        display_name: "Old Name",
        avatar_url: null,
        avatar_path: null,
        presence: "online",
      })
      .mockResolvedValueOnce({
        user_id: "@me:localhost",
        display_name: "New Name",
        avatar_url: null,
        avatar_path: null,
        presence: "online",
      });

    const { result } = renderHook(() => useOwnProfile(), { wrapper });

    await waitFor(() => expect(result.current.data?.display_name).toBe("Old Name"));

    selfProfileCallback?.({ display_name: "New Name", avatar_url: null });

    await waitFor(() => expect(result.current.data?.display_name).toBe("New Name"));
    expect(getOwnProfile).toHaveBeenCalledTimes(2);
  });
});
