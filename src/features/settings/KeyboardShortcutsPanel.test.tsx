import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KeyboardShortcutsPanel } from "./KeyboardShortcutsPanel";

describe("KeyboardShortcutsPanel", () => {
  it("documents the composer and media-viewer shortcuts", () => {
    render(<KeyboardShortcutsPanel />);
    expect(screen.getByText("Send message")).toBeInTheDocument();
    expect(screen.getByText("Enter")).toBeInTheDocument();
    expect(screen.getByText("Insert a newline")).toBeInTheDocument();
    expect(screen.getByText("Previous/next image in the lightbox")).toBeInTheDocument();
  });
});
