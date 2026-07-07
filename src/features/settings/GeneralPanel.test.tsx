import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GeneralPanel } from "./GeneralPanel";

const getAutostart = vi.fn();
const setAutostart = vi.fn();

vi.mock("@/lib/matrix", () => ({
  getAutostart: (...args: unknown[]) => getAutostart(...args),
  setAutostart: (...args: unknown[]) => setAutostart(...args),
}));

const isPermissionGranted = vi.fn();
const requestPermission = vi.fn();

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: (...args: unknown[]) => isPermissionGranted(...args),
  requestPermission: (...args: unknown[]) => requestPermission(...args),
}));

function renderWithProviders(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

beforeEach(() => {
  getAutostart.mockReset().mockResolvedValue(false);
  setAutostart.mockReset().mockResolvedValue(undefined);
  isPermissionGranted.mockReset().mockResolvedValue(false);
  requestPermission.mockReset().mockResolvedValue("granted");
});

describe("GeneralPanel", () => {
  it("reflects the current autostart state", async () => {
    getAutostart.mockResolvedValue(true);
    renderWithProviders(<GeneralPanel />);

    const checkbox = await screen.findByRole("checkbox", { name: /launch charm when i log in/i });
    await waitFor(() => expect(checkbox).toBeChecked());
  });

  it("toggling the checkbox calls setAutostart", async () => {
    renderWithProviders(<GeneralPanel />);
    const checkbox = await screen.findByRole("checkbox", { name: /launch charm when i log in/i });

    fireEvent.click(checkbox);

    // react-query's `mutationFn` is called with the mutation variable as its
    // first argument plus an internal context object as a second — assert
    // only the variable we actually care about, not react-query's internals.
    await waitFor(() => expect(setAutostart).toHaveBeenCalled());
    expect(setAutostart.mock.calls[0][0]).toBe(true);
  });

  it("shows an Enable button when notifications aren't granted", async () => {
    renderWithProviders(<GeneralPanel />);
    expect(await screen.findByRole("button", { name: "Enable" })).toBeInTheDocument();
  });

  it("clicking Enable requests notification permission", async () => {
    renderWithProviders(<GeneralPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Enable" }));

    await waitFor(() => expect(requestPermission).toHaveBeenCalled());
  });

  it("shows Enabled instead of a button once notifications are granted", async () => {
    isPermissionGranted.mockResolvedValue(true);
    renderWithProviders(<GeneralPanel />);

    expect(await screen.findByText("Enabled")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable" })).not.toBeInTheDocument();
  });
});
