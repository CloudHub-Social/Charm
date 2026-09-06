import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReauthenticationScreen } from "./ReauthenticationScreen";

const reauthenticatePassword = vi.fn();
const logout = vi.fn();
const session = { user_id: "@me:example.org", device_id: "CHARM-IPAD" };

vi.mock("@/lib/matrix", () => ({
  reauthenticatePassword: (...args: unknown[]) => reauthenticatePassword(...args),
  logout: (...args: unknown[]) => logout(...args),
}));

beforeEach(() => {
  reauthenticatePassword.mockReset();
  logout.mockReset();
});

describe("ReauthenticationScreen", () => {
  it("continues only when the homeserver retains the same Matrix device", async () => {
    reauthenticatePassword.mockResolvedValue(session);
    const onReauthenticated = vi.fn();

    render(
      <ReauthenticationScreen
        session={session}
        onReauthenticated={onReauthenticated}
        onUseAnotherAccount={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue on this device" }));

    await waitFor(() => expect(onReauthenticated).toHaveBeenCalledWith(session));
    expect(reauthenticatePassword).toHaveBeenCalledWith("correct horse");
  });

  it("rejects a replacement Matrix device", async () => {
    reauthenticatePassword.mockResolvedValue({ ...session, device_id: "OTHER" });
    const onReauthenticated = vi.fn();

    render(
      <ReauthenticationScreen
        session={session}
        onReauthenticated={onReauthenticated}
        onUseAnotherAccount={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue on this device" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("different Matrix device");
    expect(onReauthenticated).not.toHaveBeenCalled();
  });

  it("logs out before returning to the account chooser", async () => {
    logout.mockResolvedValue(undefined);
    const onUseAnotherAccount = vi.fn();

    render(
      <ReauthenticationScreen
        session={session}
        onReauthenticated={vi.fn()}
        onUseAnotherAccount={onUseAnotherAccount}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Use another account" }));

    await waitFor(() => expect(onUseAnotherAccount).toHaveBeenCalledOnce());
    expect(logout).toHaveBeenCalledOnce();
  });
});
