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
const resolveAvatar = vi.fn();
const changePassword = vi.fn();
const deactivateAccount = vi.fn();

vi.mock("@/lib/matrix", () => ({
  getProfile: (...args: unknown[]) => getProfile(...args),
  logout: (...args: unknown[]) => logout(...args),
  setDisplayName: (...args: unknown[]) => setDisplayName(...args),
  setAvatar: (...args: unknown[]) => setAvatar(...args),
  removeAvatar: (...args: unknown[]) => removeAvatar(...args),
  resolveAvatar: (...args: unknown[]) => resolveAvatar(...args),
  changePassword: (...args: unknown[]) => changePassword(...args),
  deactivateAccount: (...args: unknown[]) => deactivateAccount(...args),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
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
    uses_oauth: false,
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

  it("resolves the profile's mxc:// avatar url rather than rendering it raw", async () => {
    getProfile.mockResolvedValue({
      user_id: "@me:localhost",
      display_name: "Me",
      avatar_url: "mxc://example.org/abc123",
      uses_oauth: false,
    });
    resolveAvatar.mockResolvedValue("/cache/avatar-thumb.png");
    renderWithProviders(<AccountPanel onLoggedOut={vi.fn()} />);

    // `AvatarImage` (Radix) only mounts an `<img>` once the browser reports
    // the image loaded, which jsdom never does — so this asserts on the
    // resolution call itself (see `useProfile.test.ts` for the hook-level
    // proof that the resolved path is actually what gets passed as `src`).
    await waitFor(() => expect(resolveAvatar).toHaveBeenCalledWith("mxc://example.org/abc123"));
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

  it("keeps the typed new password visible (read-only) during the UIA confirmation step", async () => {
    changePassword.mockRejectedValueOnce(new Error("uia"));
    renderWithProviders(<AccountPanel onLoggedOut={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Change password" }));
    fireEvent.change(await screen.findByLabelText("New password"), {
      target: { value: "new-password-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await screen.findByLabelText("Current password");
    const newPasswordInput = screen.getByLabelText("New password") as HTMLInputElement;
    expect(newPasswordInput.value).toBe("new-password-1");
    expect(newPasswordInput).toHaveAttribute("readonly");
  });

  it("hides the change-password action for an OAuth/OIDC-managed account", async () => {
    getProfile.mockResolvedValue({
      user_id: "@me:localhost",
      display_name: "Me",
      avatar_url: null,
      uses_oauth: true,
    });
    renderWithProviders(<AccountPanel onLoggedOut={vi.fn()} />);

    await screen.findByText(/managed there rather than in Charm/);
    expect(screen.queryByRole("button", { name: "Change password" })).not.toBeInTheDocument();
  });
});
