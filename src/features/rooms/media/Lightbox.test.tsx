import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { Lightbox } from "./Lightbox";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

vi.mock("@/lib/matrix", () => ({
  resolveMedia: vi.fn().mockResolvedValue("/cache/lightbox.png"),
}));

function renderWithClient(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("Lightbox", () => {
  it("renders the image and title when open", async () => {
    renderWithClient(
      <Lightbox open onOpenChange={() => {}} source="handle-1" kind="image" alt="A cat photo" />,
    );

    await waitFor(() => expect(screen.getByAltText("A cat photo")).toBeInTheDocument());
    expect(screen.getByText("A cat photo")).toBeInTheDocument();
  });

  it("does not render dialog content when closed", () => {
    renderWithClient(
      <Lightbox
        open={false}
        onOpenChange={() => {}}
        source="handle-1"
        kind="image"
        alt="A cat photo"
      />,
    );
    expect(screen.queryByAltText("A cat photo")).not.toBeInTheDocument();
  });

  it("calls onOpenChange(false) on Escape", async () => {
    const onOpenChange = vi.fn();
    renderWithClient(
      <Lightbox
        open
        onOpenChange={onOpenChange}
        source="handle-1"
        kind="image"
        alt="A cat photo"
      />,
    );

    await waitFor(() => expect(screen.getByAltText("A cat photo")).toBeInTheDocument());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("calls onNext when ArrowRight is pressed", async () => {
    const onNext = vi.fn();
    renderWithClient(
      <Lightbox
        open
        onOpenChange={() => {}}
        source="handle-1"
        kind="image"
        alt="A cat photo"
        onNext={onNext}
      />,
    );

    await waitFor(() => expect(screen.getByAltText("A cat photo")).toBeInTheDocument());
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onNext).toHaveBeenCalledOnce();
  });
});
