import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FocusPanel } from "./FocusPanel";
import { renderWithProviders } from "@/test/renderWithProviders";

vi.mock("@/featureFlags", () => ({ useFlag: () => true }));

const getDndState = vi.fn();
const setDndState = vi.fn();
const onDndChanged = vi.fn();

vi.mock("@/lib/matrix", () => ({
  getDndState: (...args: unknown[]) => getDndState(...args),
  setDndState: (...args: unknown[]) => setDndState(...args),
  onDndChanged: (...args: unknown[]) => onDndChanged(...args),
}));

beforeEach(() => {
  getDndState.mockReset().mockResolvedValue({ enabled: false, until: null });
  setDndState
    .mockReset()
    .mockImplementation((enabled: boolean, until: number | null) =>
      Promise.resolve({ enabled, until }),
    );
  onDndChanged.mockReset().mockReturnValue(Promise.resolve(() => {}));
});

describe("FocusPanel", () => {
  it("reflects the current DND state", async () => {
    getDndState.mockResolvedValue({ enabled: true, until: null });
    renderWithProviders(<FocusPanel />);

    const checkbox = await screen.findByRole("checkbox", { name: /do not disturb/i });
    await waitFor(() => expect(checkbox).toBeChecked());
    expect(screen.getByTestId("dnd-active-indicator")).toBeInTheDocument();
  });

  it("toggling on calls setDndState with an indefinite until", async () => {
    renderWithProviders(<FocusPanel />);
    const checkbox = await screen.findByRole("checkbox", { name: /do not disturb/i });

    fireEvent.click(checkbox);

    await waitFor(() => expect(setDndState).toHaveBeenCalledWith(true, null));
  });

  it("a preset duration button calls setDndState with a future timestamp", async () => {
    renderWithProviders(<FocusPanel />);
    const preset = await screen.findByRole("button", { name: "30 minutes" });

    fireEvent.click(preset);

    await waitFor(() => expect(setDndState).toHaveBeenCalled());
    const [, until] = setDndState.mock.calls[0] as [boolean, number];
    expect(until).toBeGreaterThan(Date.now());
  });

  it("toggling off calls setDndState with enabled false", async () => {
    getDndState.mockResolvedValue({ enabled: true, until: null });
    renderWithProviders(<FocusPanel />);
    const checkbox = await screen.findByRole("checkbox", { name: /do not disturb/i });
    await waitFor(() => expect(checkbox).toBeChecked());

    fireEvent.click(checkbox);

    await waitFor(() => expect(setDndState).toHaveBeenCalledWith(false, null));
  });
});
