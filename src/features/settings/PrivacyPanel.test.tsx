import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { PrivacyPanel } from "./PrivacyPanel";
import { setPrivacySettings } from "@/features/privacy/privacySettings";
import { renderWithProviders } from "@/test/renderWithProviders";

beforeEach(async () => {
  await setPrivacySettings({
    hideReadReceipts: false,
    hideTyping: false,
    appearOffline: false,
    autoIdleEnabled: false,
    idleTimeoutMins: 10,
  });
});

describe("PrivacyPanel (Spec 40)", () => {
  it("renders every toggle reflecting the current settings", () => {
    renderWithProviders(<PrivacyPanel />);

    expect(screen.getByRole("switch", { name: "Send read receipts" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Send typing indicators" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Appear offline" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Auto-idle when inactive" })).not.toBeChecked();
  });

  it("turning off 'send read receipts' persists hideReadReceipts=true", async () => {
    renderWithProviders(<PrivacyPanel />);
    fireEvent.click(screen.getByRole("switch", { name: "Send read receipts" }));

    await screen.findByRole("switch", { name: "Send read receipts" }).then((el) => {
      expect(el).not.toBeChecked();
    });
  });

  it("turning off 'send typing indicators' persists hideTyping=true", () => {
    renderWithProviders(<PrivacyPanel />);
    fireEvent.click(screen.getByRole("switch", { name: "Send typing indicators" }));

    expect(screen.getByRole("switch", { name: "Send typing indicators" })).not.toBeChecked();
  });

  it("turning on 'appear offline' disables the auto-idle toggle", () => {
    renderWithProviders(<PrivacyPanel />);
    fireEvent.click(screen.getByRole("switch", { name: "Appear offline" }));

    expect(screen.getByRole("switch", { name: "Appear offline" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Auto-idle when inactive" })).toBeDisabled();
  });

  it("shows the idle timeout selector only once auto-idle is enabled", () => {
    renderWithProviders(<PrivacyPanel />);
    expect(screen.queryByRole("combobox", { name: "Idle timeout" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: "Auto-idle when inactive" }));

    expect(screen.getByRole("combobox", { name: "Idle timeout" })).toBeInTheDocument();
  });

  it("changing the idle timeout persists the new value", () => {
    renderWithProviders(<PrivacyPanel />);
    fireEvent.click(screen.getByRole("switch", { name: "Auto-idle when inactive" }));

    const select = screen.getByRole("combobox", { name: "Idle timeout" });
    fireEvent.change(select, { target: { value: "30" } });

    expect(select).toHaveValue("30");
  });
});
