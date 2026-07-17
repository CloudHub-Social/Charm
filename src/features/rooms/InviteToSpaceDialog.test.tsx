import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InviteToSpaceDialog } from "./InviteToSpaceDialog";

const inviteMember = vi.fn();

vi.mock("@/lib/matrix", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  inviteMember: (...args: unknown[]) => inviteMember(...args),
}));

function renderDialog(spaceId: string | null = "!team:localhost") {
  const onOpenChange = vi.fn();
  render(<InviteToSpaceDialog spaceId={spaceId} spaceName="Team" onOpenChange={onOpenChange} />);
  return { onOpenChange };
}

describe("InviteToSpaceDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when spaceId is null", () => {
    renderDialog(null);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("rejects a malformed Matrix ID without calling inviteMember", () => {
    renderDialog();

    fireEvent.change(screen.getByLabelText("Matrix ID"), { target: { value: "not-an-id" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));

    expect(inviteMember).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid Matrix ID");
  });

  it("invites the user and closes on success", async () => {
    inviteMember.mockResolvedValueOnce(undefined);
    const { onOpenChange } = renderDialog();

    fireEvent.change(screen.getByLabelText("Matrix ID"), {
      target: { value: "@bob:example.org" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));

    expect(inviteMember).toHaveBeenCalledWith("!team:localhost", "@bob:example.org");
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("shows an error and keeps the dialog open on failure", async () => {
    inviteMember.mockRejectedValueOnce(new Error("already invited"));
    const { onOpenChange } = renderDialog();

    fireEvent.change(screen.getByLabelText("Matrix ID"), {
      target: { value: "@bob:example.org" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("already invited"));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("cancels without calling inviteMember and resets the field", () => {
    const { onOpenChange } = renderDialog();

    fireEvent.change(screen.getByLabelText("Matrix ID"), { target: { value: "@bob:example.org" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(inviteMember).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("clears a stale error and typed value when re-targeted at a different space without closing", () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <InviteToSpaceDialog
        spaceId="!team:localhost"
        spaceName="Team"
        onOpenChange={onOpenChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("Matrix ID"), { target: { value: "not-an-id" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid Matrix ID");

    rerender(
      <InviteToSpaceDialog
        spaceId="!other:localhost"
        spaceName="Other"
        onOpenChange={onOpenChange}
      />,
    );

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Matrix ID")).toHaveValue("");
  });
});
