import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "@/providers";
import { useOwnProfile } from "./useOwnProfile";

const getOwnProfile = vi.fn();
let selfProfileCallback:
  | ((update: { display_name: string | null; avatar_url: string | null }) => void)
  | undefined;

vi.mock("@/lib/matrix", () => ({
  getOwnProfile: () => getOwnProfile(),
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
