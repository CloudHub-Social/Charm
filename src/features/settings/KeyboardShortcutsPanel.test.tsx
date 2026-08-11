import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { featureFlagTestHooks } from "@/featureFlags";
import { KeyboardShortcutsPanel } from "./KeyboardShortcutsPanel";

describe("KeyboardShortcutsPanel", () => {
  afterEach(() => featureFlagTestHooks.reset());

  it("documents the composer and media-viewer shortcuts", () => {
    render(<KeyboardShortcutsPanel />);
    expect(screen.getByText("Send message")).toBeInTheDocument();
    expect(screen.getByText("Enter")).toBeInTheDocument();
    expect(screen.getByText("Insert a newline")).toBeInTheDocument();
    expect(screen.getByText("Previous/next image in the lightbox")).toBeInTheDocument();
  });

  it("shows quick navigation without message search when only its flag is enabled", () => {
    featureFlagTestHooks.setCache({ quick_switcher: true });
    render(<KeyboardShortcutsPanel />);

    expect(screen.getByText("Open the quick switcher")).toBeInTheDocument();
    expect(screen.queryByText("Search messages")).not.toBeInTheDocument();
  });

  it("shows message search when both navigation flags are enabled", () => {
    featureFlagTestHooks.setCache({
      quick_switcher: true,
      encrypted_local_message_search: true,
    });
    render(<KeyboardShortcutsPanel />);

    expect(screen.getByText("Search messages")).toBeInTheDocument();
  });
});
