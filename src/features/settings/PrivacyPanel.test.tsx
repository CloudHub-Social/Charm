import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PrivacyPanel } from "./PrivacyPanel";
import { renderWithProviders } from "@/test/renderWithProviders";

const getPrivacySettings = vi.fn();
const setPrivacySettings = vi.fn();

vi.mock("@/lib/matrix", () => ({
  getPrivacySettings: (...args: unknown[]) => getPrivacySettings(...args),
  setPrivacySettings: (...args: unknown[]) => setPrivacySettings(...args),
}));

function defaultSettings() {
  return {
    hide_read_receipts: false,
    hide_typing: false,
    appear_offline: false,
    idle_timeout_minutes: null,
  };
}

beforeEach(() => {
  getPrivacySettings.mockReset().mockResolvedValue(defaultSettings());
  setPrivacySettings.mockReset().mockImplementation((settings) => Promise.resolve(settings));
});

describe("PrivacyPanel", () => {
  it("reflects the current settings — all toggles reflect off/on defaults", async () => {
    renderWithProviders(<PrivacyPanel />);

    const receiptsToggle = await screen.findByRole("checkbox", { name: /send read receipts/i });
    const typingToggle = await screen.findByRole("checkbox", { name: /send typing indicators/i });
    const appearOfflineToggle = await screen.findByRole("checkbox", { name: /appear offline/i });

    expect(receiptsToggle).toBeChecked();
    expect(typingToggle).toBeChecked();
    expect(appearOfflineToggle).not.toBeChecked();
  });

  it("turning off 'send read receipts' persists hide_read_receipts: true", async () => {
    renderWithProviders(<PrivacyPanel />);
    const receiptsToggle = await screen.findByRole("checkbox", { name: /send read receipts/i });

    fireEvent.click(receiptsToggle);

    await waitFor(() =>
      expect(setPrivacySettings).toHaveBeenCalledWith(
        expect.objectContaining({ hide_read_receipts: true }),
      ),
    );
  });

  it("turning off 'send typing indicators' persists hide_typing: true", async () => {
    renderWithProviders(<PrivacyPanel />);
    const typingToggle = await screen.findByRole("checkbox", { name: /send typing indicators/i });

    fireEvent.click(typingToggle);

    await waitFor(() =>
      expect(setPrivacySettings).toHaveBeenCalledWith(expect.objectContaining({ hide_typing: true })),
    );
  });

  it("toggling 'appear offline' on persists appear_offline: true", async () => {
    renderWithProviders(<PrivacyPanel />);
    const toggle = await screen.findByRole("checkbox", { name: /appear offline/i });

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(setPrivacySettings).toHaveBeenCalledWith(
        expect.objectContaining({ appear_offline: true }),
      ),
    );
  });

  it("changing the auto-away timeout persists idle_timeout_minutes", async () => {
    renderWithProviders(<PrivacyPanel />);
    const select = await screen.findByRole("combobox", { name: /auto-away timeout/i });

    fireEvent.change(select, { target: { value: "15" } });

    await waitFor(() =>
      expect(setPrivacySettings).toHaveBeenCalledWith(
        expect.objectContaining({ idle_timeout_minutes: 15 }),
      ),
    );
  });
});
