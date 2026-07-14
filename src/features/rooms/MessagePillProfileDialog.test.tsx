import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessagePillProfileDialog } from "./MessagePillProfileDialog";

describe("MessagePillProfileDialog", () => {
  it("shows the pill identity and closes through the dialog control", () => {
    const onClose = vi.fn();
    render(
      <MessagePillProfileDialog
        profile={{ userId: "@alice:example.org", label: "Alice" }}
        onClose={onClose}
      />,
    );

    expect(screen.getByRole("heading", { name: "Alice" })).toBeInTheDocument();
    expect(screen.getByText("@alice:example.org")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
