import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReactionBar } from "./ReactionBar";
import type { ReactionGroup } from "@/lib/matrix";

describe("ReactionBar", () => {
  it("renders a chip per reaction group with its count", () => {
    const reactions: ReactionGroup[] = [
      { key: "👍", count: 2, reacted_by_me: false },
      { key: "🎉", count: 1, reacted_by_me: true },
    ];
    render(<ReactionBar reactions={reactions} onToggle={vi.fn()} />);

    expect(screen.getByText("👍")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("🎉")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("marks own reactions as pressed", () => {
    const reactions: ReactionGroup[] = [{ key: "🎉", count: 1, reacted_by_me: true }];
    render(<ReactionBar reactions={reactions} onToggle={vi.fn()} />);

    expect(screen.getByRole("button", { name: /🎉/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("calls onToggle with the reaction key when a chip is clicked", () => {
    const onToggle = vi.fn();
    const reactions: ReactionGroup[] = [{ key: "👍", count: 1, reacted_by_me: false }];
    render(<ReactionBar reactions={reactions} onToggle={onToggle} />);

    fireEvent.click(screen.getByRole("button", { name: /👍/ }));

    expect(onToggle).toHaveBeenCalledWith("👍");
  });

  it("renders nothing when there are no reactions yet", () => {
    const { container } = render(<ReactionBar reactions={[]} onToggle={vi.fn()} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("disables chips and the add-reaction picker for a still-pending message", () => {
    const reactions: ReactionGroup[] = [{ key: "👍", count: 1, reacted_by_me: false }];
    render(<ReactionBar reactions={reactions} onToggle={vi.fn()} disabled />);

    expect(screen.getByRole("button", { name: /👍/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add reaction" })).toBeDisabled();
  });
});
