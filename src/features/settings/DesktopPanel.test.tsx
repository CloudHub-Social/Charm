import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopPanel } from "./DesktopPanel";

const getAutostart = vi.fn();
const setAutostart = vi.fn();

vi.mock("@/lib/matrix", () => ({
  getAutostart: (...args: unknown[]) => getAutostart(...args),
  setAutostart: (...args: unknown[]) => setAutostart(...args),
}));

function renderWithProviders(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

beforeEach(() => {
  getAutostart.mockReset().mockResolvedValue(false);
  setAutostart.mockReset().mockResolvedValue(undefined);
});

describe("DesktopPanel", () => {
  it("reflects the current autostart state", async () => {
    getAutostart.mockResolvedValue(true);
    renderWithProviders(<DesktopPanel />);

    const checkbox = await screen.findByRole("checkbox", { name: /launch charm when i log in/i });
    await waitFor(() => expect(checkbox).toBeChecked());
  });

  it("toggling the checkbox calls setAutostart", async () => {
    renderWithProviders(<DesktopPanel />);
    const checkbox = await screen.findByRole("checkbox", { name: /launch charm when i log in/i });

    fireEvent.click(checkbox);

    // react-query's `mutationFn` is called with the mutation variable as its
    // first argument plus an internal context object as a second — assert
    // only the variable we actually care about, not react-query's internals.
    await waitFor(() => expect(setAutostart).toHaveBeenCalled());
    expect(setAutostart.mock.calls[0][0]).toBe(true);
  });
});
