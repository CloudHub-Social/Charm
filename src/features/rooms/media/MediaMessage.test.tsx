import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { MediaContent } from "@/lib/matrix";
import { MediaMessage } from "./MediaMessage";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

vi.mock("@/lib/matrix", () => ({
  resolveMedia: vi.fn().mockResolvedValue("/cache/resolved"),
}));

function renderWithClient(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("MediaMessage", () => {
  it("renders an image thumbnail button for an Image variant", () => {
    const content: MediaContent = {
      type: "Image",
      mime: "image/png",
      size: 1024,
      width: 800,
      height: 600,
      has_thumbnail: false,
      blurhash: null,
    };
    renderWithClient(
      <MediaMessage content={content} roomId="!room:localhost" eventId="$event" body="cat.png" />,
    );
    expect(screen.getByRole("button", { name: "Open image cat.png" })).toBeInTheDocument();
  });

  it("renders a play button for a Video variant", () => {
    const content: MediaContent = {
      type: "Video",
      mime: "video/mp4",
      size: 2048,
      width: 1920,
      height: 1080,
      duration_ms: 5000,
      has_thumbnail: false,
    };
    renderWithClient(
      <MediaMessage content={content} roomId="!room:localhost" eventId="$event" body="clip.mp4" />,
    );
    expect(screen.getByRole("button", { name: "Play video clip.mp4" })).toBeInTheDocument();
  });

  it("renders an audio element for an Audio variant", async () => {
    const content: MediaContent = {
      type: "Audio",
      mime: "audio/ogg",
      size: 512,
      duration_ms: 3000,
    };
    const { container } = renderWithClient(
      <MediaMessage content={content} roomId="!room:localhost" eventId="$event" body="voice.ogg" />,
    );
    await waitFor(() => expect(container.querySelector("audio")).toBeInTheDocument());
  });

  it("renders a download chip for a File variant", async () => {
    const content: MediaContent = {
      type: "File",
      filename: "report.pdf",
      mime: "application/pdf",
      size: 4096,
    };
    renderWithClient(
      <MediaMessage
        content={content}
        roomId="!room:localhost"
        eventId="$event"
        body="report.pdf"
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Download report.pdf" })).toBeInTheDocument(),
    );
  });
});
