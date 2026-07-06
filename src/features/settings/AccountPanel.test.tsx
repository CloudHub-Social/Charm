import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountPanel } from "./AccountPanel";

const getProfile = vi.fn();
const logout = vi.fn();
const setDisplayName = vi.fn();
const setAvatar = vi.fn();
const removeAvatar = vi.fn();
const changePassword = vi.fn();
const deactivateAccount = vi.fn();

vi.mock("@/lib/matrix", () => ({
  getProfile: (...args: unknown[]) => getProfile(...args),
  logout: (...args: unknown[]) => logout(...args),
  setDisplayName: (...args: unknown[]) => setDisplayName(...args),
  setAvatar: (...args: unknown[]) => setAvatar(...args),
  removeAvatar: (...args: unknown[]) => removeAvatar(...args),
  changePassword: (...args: unknown[]) => changePassword(...args),
  deactivateAccount: (...args: unknown[]) => deactivateAccount(...args),
}));

const openFileDialog = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openFileDialog(...args),
}));

function renderWithProviders(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

beforeEach(() => {
  getProfile.mockReset().mockResolvedValue({
    user_id: "@me:localhost",
    display_name: "Me",
    avatar_url: null,
  });
  logout.mockReset();
});

describe("AccountPanel", () => {
  it("logout confirm dialog invokes logout and the App reset callback", async () => {
    logout.mockResolvedValue(undefined);
    const onLoggedOut = vi.fn();
    renderWithProviders(<AccountPanel onLoggedOut={onLoggedOut} />);

    const [openButton] = screen.getAllByRole("button", { name: "Log out" });
    fireEvent.click(openButton);

    const dialogButtons = await screen.findAllByRole("button", { name: "Log out" });
    fireEvent.click(dialogButtons[dialogButtons.length - 1]);

    await waitFor(() => expect(logout).toHaveBeenCalled());
    await waitFor(() => expect(onLoggedOut).toHaveBeenCalled());
  });

  it("shows an error and does not reset the app when logout fails", async () => {
    logout.mockRejectedValue(new Error("network error"));
    const onLoggedOut = vi.fn();
    renderWithProviders(<AccountPanel onLoggedOut={onLoggedOut} />);

    const [openButton] = screen.getAllByRole("button", { name: "Log out" });
    fireEvent.click(openButton);
    const dialogButtons = await screen.findAllByRole("button", { name: "Log out" });
    fireEvent.click(dialogButtons[dialogButtons.length - 1]);

    expect(await screen.findByText("Error: network error")).toBeInTheDocument();
    expect(onLoggedOut).not.toHaveBeenCalled();
  });

  it("deactivate account requires typing DEACTIVATE before it can be confirmed", async () => {
    renderWithProviders(<AccountPanel onLoggedOut={vi.fn()} />);

    const [openButton] = screen.getAllByRole("button", { name: "Deactivate account" });
    fireEvent.click(openButton);
    fireEvent.click(await screen.findByRole("button", { name: "I understand, continue" }));

    const confirmButtons = await screen.findAllByRole("button", { name: "Deactivate account" });
    const confirmButton = confirmButtons[confirmButtons.length - 1];
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Type DEACTIVATE to confirm"), {
      target: { value: "DEACTIVATE" },
    });
    expect(confirmButton).not.toBeDisabled();
  });

  it("saves an edited display name", async () => {
    setDisplayName.mockResolvedValue(undefined);
    renderWithProviders(<AccountPanel onLoggedOut={vi.fn()} />);

    const input = await screen.findByLabelText("Display name");
    fireEvent.change(input, { target: { value: "New Name" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(setDisplayName).toHaveBeenCalledWith("New Name"));
  });

  it("uploads a picked avatar file", async () => {
    openFileDialog.mockResolvedValue("/tmp/avatar.png");
    setAvatar.mockResolvedValue(undefined);
    renderWithProviders(<AccountPanel onLoggedOut={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Change avatar" }));

    await waitFor(() => expect(setAvatar).toHaveBeenCalledWith("/tmp/avatar.png"));
  });

  it("change password prompts for the account password on the first UIA challenge, then succeeds", async () => {
    changePassword.mockRejectedValueOnce(new Error("uia")).mockResolvedValueOnce(undefined);
    renderWithProviders(<AccountPanel onLoggedOut={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Change password" }));
    fireEvent.change(await screen.findByLabelText("New password"), {
      target: { value: "new-password-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    fireEvent.change(await screen.findByLabelText("Current password"), {
      target: { value: "current-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(await screen.findByText("Your password has been changed.")).toBeInTheDocument();
    expect(changePassword).toHaveBeenLastCalledWith("new-password-1", "current-password");
  });
});
