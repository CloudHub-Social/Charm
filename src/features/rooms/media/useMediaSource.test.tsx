import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMediaSource } from "./useMediaSource";

const resolveMedia = vi.fn();

beforeEach(() => {
  resolveMedia.mockReset();
});

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

vi.mock("@/lib/matrix", () => ({
  resolveMedia: (...args: unknown[]) => resolveMedia(...args),
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useMediaSource", () => {
  it("resolves a handle to a webview-loadable URL", async () => {
    resolveMedia.mockResolvedValueOnce("/cache/abc123");

    const { result } = renderHook(() => useMediaSource("handle-1"), { wrapper });

    await waitFor(() => expect(result.current.data).toBe("asset://localhost//cache/abc123"));
    expect(resolveMedia).toHaveBeenCalledWith("handle-1", false);
  });

  it("does not call resolveMedia when the handle is nullish", () => {
    renderHook(() => useMediaSource(null), { wrapper });
    expect(resolveMedia).not.toHaveBeenCalled();
  });

  it("dedups calls for the same handle across renders (TanStack Query cache)", async () => {
    resolveMedia.mockClear();
    resolveMedia.mockResolvedValue("/cache/dedup");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const localWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const first = renderHook(() => useMediaSource("handle-dedup"), { wrapper: localWrapper });
    await waitFor(() => expect(first.result.current.data).toBeDefined());

    renderHook(() => useMediaSource("handle-dedup"), { wrapper: localWrapper });

    expect(resolveMedia).toHaveBeenCalledTimes(1);
  });

  it("passes thumbnail=true through when requested", async () => {
    resolveMedia.mockClear();
    resolveMedia.mockResolvedValueOnce("/cache/thumb");
    const { result } = renderHook(() => useMediaSource("handle-2", { thumbnail: true }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(resolveMedia).toHaveBeenCalledWith("handle-2", true);
  });
});
