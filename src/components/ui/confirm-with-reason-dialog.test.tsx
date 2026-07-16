import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmWithReasonDialog } from "./confirm-with-reason-dialog";

function renderDialog(onConfirm = vi.fn().mockResolvedValue(true)) {
  const onOpenChange = vi.fn();
  render(
    <ConfirmWithReasonDialog
      open
      title="Delete message?"
      description="This cannot be undone."
      confirmLabel="Delete message"
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
    />,
  );
  return { onConfirm, onOpenChange };
}

describe("ConfirmWithReasonDialog", () => {
  it("trims and submits an optional reason before closing", async () => {
    const { onConfirm, onOpenChange } = renderDialog();

    fireEvent.change(screen.getByLabelText("Reason (optional)"), {
      target: { value: "  duplicate message  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete message" }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith("duplicate message"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the dialog open and shows an error when the action fails", async () => {
    const onConfirm = vi.fn().mockResolvedValue(false);
    const { onOpenChange } = renderDialog(onConfirm);

    fireEvent.click(screen.getByRole("button", { name: "Delete message" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("could not be completed");
    expect(onConfirm).toHaveBeenCalledWith(null);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
