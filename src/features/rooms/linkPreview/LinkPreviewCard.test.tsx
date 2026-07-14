import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LinkPreviewCard } from "./LinkPreviewCard";
import { clearUrlPreviewCache } from "./previewCache";

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
  clearUrlPreviewCache();
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
});
