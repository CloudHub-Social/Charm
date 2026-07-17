import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LeaveSpaceDialog } from "./LeaveSpaceDialog";

const leaveRoom = vi.fn();

vi.mock("@/lib/matrix", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  leaveRoom: (...args: unknown[]) => leaveRoom(...args),
}));

function renderDialog(spaceId: string | null = "!team:localhost") {
  const onOpenChange = vi.fn();
  render(<LeaveSpaceDialog spaceId={spaceId} spaceName="Team" onOpenChange={onOpenChange} />);
  return { onOpenChange };
}

describe("LeaveSpaceDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when spaceId is null", () => {
    renderDialog(null);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("cancels without calling leaveRoom", () => {
    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(leaveRoom).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("leaves the space and closes on success", async () => {
    leaveRoom.mockResolvedValueOnce(undefined);
    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Leave" }));

    expect(leaveRoom).toHaveBeenCalledWith("!team:localhost");
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("shows an error and disables Leave while pending, without closing", async () => {
    let resolveLeave: () => void = () => {};
    leaveRoom.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveLeave = resolve;
      }),
    );
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    expect(screen.getByRole("button", { name: "Leave" })).toBeDisabled();
    resolveLeave();
    await waitFor(() => expect(screen.getByRole("button", { name: "Leave" })).toBeEnabled());
  });

  it("blocks Cancel and disables it while a leave request is in flight", async () => {
    let resolveLeave: () => void = () => {};
    leaveRoom.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveLeave = resolve;
      }),
    );
    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    expect(cancelButton).toBeDisabled();

    fireEvent.click(cancelButton);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    resolveLeave();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("shows an error message and keeps the dialog open on failure", async () => {
    leaveRoom.mockRejectedValueOnce(new Error("cannot leave"));
    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Leave" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("cannot leave"));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("clears a stale error when re-targeted at a different space without closing", async () => {
    leaveRoom.mockRejectedValueOnce(new Error("cannot leave"));
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <LeaveSpaceDialog spaceId="!team:localhost" spaceName="Team" onOpenChange={onOpenChange} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("cannot leave"));

    rerender(
      <LeaveSpaceDialog spaceId="!other:localhost" spaceName="Other" onOpenChange={onOpenChange} />,
    );

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
