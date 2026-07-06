import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import App from "./App";
import { queryClient } from "./providers";

const tryRestoreSession = vi.fn();

vi.mock("@/lib/matrix", () => ({
  tryRestoreSession: (...args: unknown[]) => tryRestoreSession(...args),
}));

vi.mock("@/lib/deepLink", () => ({
  watchDeepLinks: () => Promise.resolve(() => Promise.resolve()),
}));

vi.mock("@/features/auth/LoginScreen", () => ({
  LoginScreen: () => <div>login screen</div>,
}));

vi.mock("@/features/rooms/RoomsScreen", () => ({
  RoomsScreen: ({ onLoggedOut }: { onLoggedOut: () => void }) => (
    <button onClick={onLoggedOut}>trigger logout</button>
  ),
}));

describe("App", () => {
  it("clears the shared query cache and returns to the login screen on logout", async () => {
    tryRestoreSession.mockResolvedValue({ user_id: "@me:localhost", device_id: "DEVICE1" });
    const clearSpy = vi.spyOn(queryClient, "clear");

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "trigger logout" }));

    expect(clearSpy).toHaveBeenCalled();
    expect(await screen.findByText("login screen")).toBeInTheDocument();

    clearSpy.mockRestore();
  });
});
