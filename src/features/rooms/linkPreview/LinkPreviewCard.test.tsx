import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LinkPreviewCard, linkPreviewStaleTime } from "./LinkPreviewCard";

describe("linkPreviewStaleTime", () => {
  it("caches real preview data for a full hour", () => {
    expect(linkPreviewStaleTime({ title: "Example" })).toBe(60 * 60 * 1000);
  });

  it("only caches a null result (no data, or a swallowed transient failure) for 30s", () => {
    expect(linkPreviewStaleTime(null)).toBe(30 * 1000);
    expect(linkPreviewStaleTime(undefined)).toBe(30 * 1000);
  });
});

const getUrlPreview = vi.fn();
const resolveAvatar = vi.fn();

vi.mock("@/lib/matrix", () => ({
  getUrlPreview: (...args: unknown[]) => getUrlPreview(...args),
  resolveAvatar: (...args: unknown[]) => resolveAvatar(...args),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

beforeEach(() => {
  getUrlPreview.mockReset();
  resolveAvatar.mockReset();
});

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("LinkPreviewCard", () => {
  it("renders title, description, and a resolved thumbnail", async () => {
    getUrlPreview.mockResolvedValueOnce({
      title: "Example Domain",
      description: "An example site.",
      imageUrl: "mxc://example.org/abc123",
      imageWidth: 800,
      imageHeight: 600,
      siteName: "Example",
    });
    resolveAvatar.mockResolvedValueOnce("/cache/preview-thumb.png");

    render(<LinkPreviewCard roomId="!room:localhost" url="https://example.com" />, { wrapper });

    await waitFor(() => expect(screen.getByText("Example Domain")).toBeInTheDocument());
    expect(screen.getByText("An example site.")).toBeInTheDocument();
    expect(screen.getByText("Example")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("img")).toHaveAttribute(
        "src",
        "asset://localhost//cache/preview-thumb.png",
      ),
    );
  });

  it("renders title-only previews without a broken image or description", async () => {
    getUrlPreview.mockResolvedValueOnce({
      title: "Title Only",
      description: null,
      imageUrl: null,
      imageWidth: null,
      imageHeight: null,
      siteName: null,
    });

    render(<LinkPreviewCard roomId="!room:localhost" url="https://example.com/title-only" />, {
      wrapper,
    });

    await waitFor(() => expect(screen.getByText("Title Only")).toBeInTheDocument());
    expect(screen.queryByRole("img")).toBeNull();
    expect(resolveAvatar).not.toHaveBeenCalled();
  });

  it("ignores a non-mxc image URL rather than loading it directly", async () => {
    getUrlPreview.mockResolvedValueOnce({
      title: "Direct Image Host",
      description: null,
      imageUrl: "https://evil.example/tracker.png",
      imageWidth: null,
      imageHeight: null,
      siteName: null,
    });

    render(<LinkPreviewCard roomId="!room:localhost" url="https://example.com/direct-image" />, {
      wrapper,
    });

    await waitFor(() => expect(screen.getByText("Direct Image Host")).toBeInTheDocument());
    expect(screen.queryByRole("img")).toBeNull();
    expect(resolveAvatar).not.toHaveBeenCalled();
  });

  it("renders nothing when there is no preview data", async () => {
    getUrlPreview.mockResolvedValueOnce(null);

    const { container } = render(
      <LinkPreviewCard roomId="!room:localhost" url="https://example.com/missing" />,
      { wrapper },
    );

    await waitFor(() => expect(getUrlPreview).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("wraps the card in wrapperClassName only once real preview data has resolved", async () => {
    getUrlPreview.mockResolvedValueOnce({
      title: "Example Domain",
      description: null,
      imageUrl: null,
      imageWidth: null,
      imageHeight: null,
      siteName: null,
    });

    const { container } = render(
      <LinkPreviewCard
        roomId="!room:localhost"
        url="https://example.com"
        wrapperClassName="mt-0.5"
      />,
      { wrapper },
    );

    // While the fetch is still pending, no wrapper (and no card) exists.
    expect(container.querySelector(".mt-0\\.5")).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByText("Example Domain")).toBeInTheDocument());
    expect(container.querySelector(".mt-0\\.5")).toBeInTheDocument();
  });

  it("never adds wrapperClassName when the preview resolves to no data", async () => {
    getUrlPreview.mockResolvedValueOnce(null);

    const { container } = render(
      <LinkPreviewCard
        roomId="!room:localhost"
        url="https://example.com/missing"
        wrapperClassName="mt-0.5"
      />,
      { wrapper },
    );

    await waitFor(() => expect(getUrlPreview).toHaveBeenCalled());
    expect(container.querySelector(".mt-0\\.5")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });
});
