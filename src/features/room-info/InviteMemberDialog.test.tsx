import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InviteMemberDialog } from "./InviteMemberDialog";
import { renderWithProviders } from "@/test/renderWithProviders";

const inviteMember = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/matrix", () => ({
  inviteMember: (...args: unknown[]) => inviteMember(...args),
}));

describe("InviteMemberDialog", () => {
  it("shows an inline error and sends no request for a malformed MXID", async () => {
    renderWithProviders(<InviteMemberDialog roomId="!test:localhost" disabled={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    fireEvent.change(screen.getByLabelText("Matrix ID"), { target: { value: "not-an-mxid" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/valid matrix id/i);
    expect(inviteMember).not.toHaveBeenCalled();
  });

  it("invites a valid MXID", async () => {
    renderWithProviders(<InviteMemberDialog roomId="!test:localhost" disabled={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    fireEvent.change(screen.getByLabelText("Matrix ID"), {
      target: { value: "@bob:example.org" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));

    await waitFor(() => {
      expect(inviteMember).toHaveBeenCalledWith("!test:localhost", "@bob:example.org");
    });
  });

  it("renders a disabled trigger when the acting user cannot invite", () => {
    renderWithProviders(<InviteMemberDialog roomId="!test:localhost" disabled={true} />);

    expect(screen.getByRole("button", { name: "Invite" })).toBeDisabled();
  });
});
