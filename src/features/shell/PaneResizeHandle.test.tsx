import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PaneResizeHandle } from "./PaneResizeHandle";

describe("PaneResizeHandle", () => {
  it("keeps a 44px resize hit target behind the narrow divider", () => {
    render(<PaneResizeHandle width={280} onWidthChange={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Resize room sidebar" })).toHaveClass(
      "min-h-11",
      "w-11",
    );
  });

  it("supports precise keyboard resizing", () => {
    const onWidthChange = vi.fn();
    render(<PaneResizeHandle width={280} onWidthChange={onWidthChange} />);
    const handle = screen.getByRole("button", { name: "Resize room sidebar" });

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });

    expect(onWidthChange).toHaveBeenNthCalledWith(1, 288);
    expect(onWidthChange).toHaveBeenNthCalledWith(2, 272);
  });
});
