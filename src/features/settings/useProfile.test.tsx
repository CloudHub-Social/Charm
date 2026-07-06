import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useResolvedAvatarSrc } from "./useProfile";

const resolveAvatar = vi.fn();

beforeEach(() => {
  resolveAvatar.mockReset();
});

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

vi.mock("@/lib/matrix", () => ({
  resolveAvatar: (...args: unknown[]) => resolveAvatar(...args),
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useResolvedAvatarSrc", () => {
  it("resolves an mxc:// avatar url to a webview-loadable src — never the raw mxc uri", async () => {
    resolveAvatar.mockResolvedValueOnce("/cache/avatar-thumb.png");

    const { result } = renderHook(() => useResolvedAvatarSrc("mxc://example.org/abc123"), {
      wrapper,
    });

    await waitFor(() => expect(result.current).toBe("asset://localhost//cache/avatar-thumb.png"));
    expect(resolveAvatar).toHaveBeenCalledWith("mxc://example.org/abc123");
    expect(result.current).not.toContain("mxc://");
  });

  it("does not call resolveAvatar when there's no avatar url", () => {
    const { result } = renderHook(() => useResolvedAvatarSrc(null), { wrapper });
    expect(resolveAvatar).not.toHaveBeenCalled();
    expect(result.current).toBeUndefined();
  });

  it("returns undefined when resolution fails on the Rust side", async () => {
    resolveAvatar.mockResolvedValueOnce(null);

    const { result } = renderHook(() => useResolvedAvatarSrc("mxc://example.org/missing"), {
      wrapper,
    });

    await waitFor(() => expect(resolveAvatar).toHaveBeenCalled());
    expect(result.current).toBeUndefined();
  });
});
