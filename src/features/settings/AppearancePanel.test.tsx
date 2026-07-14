import { fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppearancePanel } from "./AppearancePanel";

const storeSet = vi.fn();
const load = vi.fn();

vi.mock("@tauri-apps/plugin-store", () => ({
  load: (...args: unknown[]) => load(...args),
}));

/** Radix's DropdownMenu opens on pointerdown, not click, in jsdom. */
function openMenu(name: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name }), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

function renderPanel() {
  const store = createStore();
  return render(
    <Provider store={store}>
      <AppearancePanel />
    </Provider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  storeSet.mockReset();
  load.mockReset().mockResolvedValue({ get: vi.fn().mockResolvedValue(undefined), set: storeSet });
  document.documentElement.removeAttribute("data-theme");
});

describe("AppearancePanel", () => {
  it("renders the heading and all six appearance pickers", () => {
    renderPanel();
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.getByText("Theme")).toBeInTheDocument();
    expect(screen.getByText("Font size")).toBeInTheDocument();
    expect(screen.getByText("Message density")).toBeInTheDocument();
    expect(screen.getByText("Motion")).toBeInTheDocument();
    expect(screen.getByText("Message layout")).toBeInTheDocument();
    expect(screen.getByText("Emoji-only messages")).toBeInTheDocument();
  });

  it("defaults to Dark theme, Medium font, Cozy density, Match system motion", () => {
    renderPanel();
    expect(screen.getByRole("button", { name: "Dark" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Medium" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cozy" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Match system" })).toHaveLength(1);
  });

  it("switching theme updates the trigger label and the DOM live", () => {
    renderPanel();
    openMenu("Dark");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Midnight" }));
    expect(screen.getByRole("button", { name: "Midnight" })).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe("midnight");
  });

  it("defaults to Bubble message layout and switches on click", () => {
    renderPanel();
    const bubbleButton = screen.getByRole("button", { name: /Bubble/ });
    const discordButton = screen.getByRole("button", { name: /Discord/ });
    expect(bubbleButton).toHaveAttribute("aria-pressed", "true");
    expect(discordButton).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(discordButton);

    expect(discordButton).toHaveAttribute("aria-pressed", "true");
    expect(bubbleButton).toHaveAttribute("aria-pressed", "false");
  });

  it("lets the message layout picker wrap instead of overflowing a narrow pane", () => {
    renderPanel();
    const bubbleButton = screen.getByRole("button", { name: /Bubble/ });
    const fieldset = bubbleButton.closest("fieldset");
    expect(fieldset).toHaveClass("flex-wrap");
  });

  it("discloses that IRC mode doesn't show read receipts yet, only when IRC is selected", () => {
    renderPanel();
    expect(screen.queryByText(/doesn't show read receipts/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /IRC/ }));

    expect(screen.getByText(/doesn't show read receipts/)).toBeInTheDocument();
  });
});
