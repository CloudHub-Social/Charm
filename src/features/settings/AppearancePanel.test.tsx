import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppearancePanel } from "./AppearancePanel";

const rollout = vi.hoisted(() => ({ appearance: true }));
vi.mock("@/featureFlags", () => ({
  useFlag: (key: string) => (key === "appearance_parity" ? rollout.appearance : true),
}));

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
  rollout.appearance = true;
  localStorage.clear();
  storeSet.mockReset();
  load.mockReset().mockResolvedValue({ get: vi.fn().mockResolvedValue(undefined), set: storeSet });
  document.documentElement.removeAttribute("data-theme");
});

describe("AppearancePanel", () => {
  it("hides clock and date controls when the rollout is disabled", () => {
    rollout.appearance = false;
    renderPanel();
    expect(screen.queryByText("Clock format")).not.toBeInTheDocument();
    expect(screen.queryByText("Date format")).not.toBeInTheDocument();
    expect(screen.queryByText("Font family")).not.toBeInTheDocument();
    expect(screen.queryByText("Message spacing")).not.toBeInTheDocument();
  });

  it("updates and persists clock and date choices", async () => {
    renderPanel();
    openMenu("System clock");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "24-hour" }));
    expect(screen.getByRole("button", { name: "24-hour" })).toBeInTheDocument();
    openMenu("System date");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "YYYY-MM-DD" }));
    expect(screen.getByRole("button", { name: "YYYY-MM-DD" })).toBeInTheDocument();
    await waitFor(() =>
      expect(storeSet).toHaveBeenLastCalledWith(
        "appearance",
        expect.objectContaining({
          state: expect.objectContaining({ clockFormat: "24h", dateFormat: "year-first" }),
        }),
      ),
    );
  });

  it("selects and persists a local font family", async () => {
    renderPanel();
    openMenu("Charm default");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Serif", exact: true }));
    expect(screen.getByRole("button", { name: "Serif", exact: true })).toBeInTheDocument();
    await waitFor(() =>
      expect(storeSet).toHaveBeenLastCalledWith(
        "appearance",
        expect.objectContaining({ state: expect.objectContaining({ fontFamily: "serif" }) }),
      ),
    );
  });
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

  it("persists the unread message count display preference", async () => {
    renderPanel();
    const toggle = screen.getByRole("switch", { name: "Show unread message counts" });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);

    expect(toggle).toBeChecked();
    await waitFor(() =>
      expect(storeSet).toHaveBeenCalledWith(
        "appearance",
        expect.objectContaining({ state: expect.objectContaining({ showUnreadCounts: true }) }),
      ),
    );
  });

  it("persists the group DM presence-ring preference", async () => {
    renderPanel();
    const toggle = screen.getByRole("switch", { name: "Show group DM presence rings" });
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);

    expect(toggle).not.toBeChecked();
    await waitFor(() =>
      expect(storeSet).toHaveBeenCalledWith(
        "appearance",
        expect.objectContaining({ state: expect.objectContaining({ groupPresenceRing: false }) }),
      ),
    );
  });

  it("persists timeline membership and hidden-event visibility controls", async () => {
    renderPanel();
    const membership = screen.getByRole("switch", { name: "Show membership events" });
    const hidden = screen.getByRole("switch", { name: "Show hidden state events" });
    expect(membership).toBeChecked();
    expect(hidden).not.toBeChecked();

    fireEvent.click(membership);
    fireEvent.click(hidden);

    expect(membership).not.toBeChecked();
    expect(hidden).toBeChecked();
    await waitFor(() =>
      expect(storeSet).toHaveBeenLastCalledWith(
        "appearance",
        expect.objectContaining({
          state: expect.objectContaining({ hideMembershipEvents: true, showHiddenEvents: true }),
        }),
      ),
    );
  });
});
