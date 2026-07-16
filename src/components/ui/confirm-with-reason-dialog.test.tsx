import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmWithReasonDialog } from "./confirm-with-reason-dialog";

function renderDialog(onConfirm = vi.fn().mockResolvedValue(true), open = true) {
  const onOpenChange = vi.fn();
  const result = render(
    <ConfirmWithReasonDialog
      open={open}
      title="Delete message?"
      description="This cannot be undone."
      confirmLabel="Delete message"
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
    />,
  );
  return { ...result, onConfirm, onOpenChange };
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

  it("prevents closing while the destructive action is pending", async () => {
    let resolveConfirmation: ((value: boolean) => void) | undefined;
    const onConfirm = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConfirmation = resolve;
        }),
    );
    const { onOpenChange } = renderDialog(onConfirm);

    fireEvent.click(screen.getByRole("button", { name: "Delete message" }));

    expect(await screen.findByRole("button", { name: "Deleting…" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();

    resolveConfirmation?.(true);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("drops a late failure after the parent closes the dialog", async () => {
    let resolveConfirmation: ((value: boolean) => void) | undefined;
    const onConfirm = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConfirmation = resolve;
        }),
    );
    const { rerender, onOpenChange } = renderDialog(onConfirm);

    fireEvent.click(screen.getByRole("button", { name: "Delete message" }));
    rerender(
      <ConfirmWithReasonDialog
        open={false}
        title="Delete message?"
        description="This cannot be undone."
        confirmLabel="Delete message"
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />,
    );
    resolveConfirmation?.(false);
    rerender(
      <ConfirmWithReasonDialog
        open
        title="Delete message?"
        description="This cannot be undone."
        confirmLabel="Delete message"
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />,
    );

    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
