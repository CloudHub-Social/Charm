import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as featureFlags from "@/featureFlags";
import { featureFlagTestHooks, FEATURE_FLAG_CATALOG } from "@/featureFlags";
import { LabsPanel } from "./LabsPanel";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn().mockRejectedValue(new Error("store unavailable")),
}));

beforeEach(() => {
  localStorage.clear();
  featureFlagTestHooks.reset();
});
afterEach(() => vi.restoreAllMocks());

/** A flag known to exist in the generated catalog, for stable assertions. */
const A_FLAG = "canary";

describe("LabsPanel", () => {
  it("applies and rolls back the supported UX bundle from Labs", async () => {
    featureFlagTestHooks.setCache({});
    render(<LabsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Use refreshed UX" }));
    const shell = screen.getByRole("switch", { name: "Toggle Ux refresh v1" });
    await waitFor(() => expect(shell).toBeChecked());
    expect(screen.getByRole("switch", { name: "Toggle Composer parity" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Toggle Message action parity" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Toggle Voice recording" })).not.toBeChecked();
    const rollback = screen.getByRole("button", { name: "Use legacy UX" });
    await waitFor(() => expect(rollback).toBeEnabled());
    fireEvent.click(rollback);
    await waitFor(() => expect(shell).not.toBeChecked());
    expect(screen.getByRole("switch", { name: "Toggle Composer parity" })).not.toBeChecked();
  });

  it("disables UX bundles until flags are initialized", () => {
    render(<LabsPanel />);
    expect(screen.getByRole("button", { name: "Use refreshed UX" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Use legacy UX" })).toBeDisabled();
  });

  it("reports rejected flag changes without exposing backend errors", async () => {
    vi.spyOn(featureFlags, "setFeatureFlagOverride").mockRejectedValueOnce(
      new Error("private backend detail"),
    );
    render(<LabsPanel />);
    const toggle = screen.getByRole("switch", { name: "Toggle Canary" });
    fireEvent.click(toggle);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not finish applying the flag change",
    );
    expect(screen.queryByText("private backend detail")).not.toBeInTheDocument();
    expect(toggle).not.toBeChecked();
    await waitFor(() => expect(toggle).toBeEnabled());
  });
  it("lists every catalog flag with its default state", () => {
    render(<LabsPanel />);
    for (const key of Object.keys(FEATURE_FLAG_CATALOG)) {
      const label = key.charAt(0).toUpperCase() + key.replace(/_/g, " ").slice(1);
      expect(screen.getByRole("switch", { name: `Toggle ${label}` })).toBeInTheDocument();
    }
    // canary defaults off → its switch is unchecked and not marked overridden.
    expect(screen.getByRole("switch", { name: "Toggle Canary" })).not.toBeChecked();
    expect(screen.queryByText(/Overridden/)).not.toBeInTheDocument();
  });

  it("toggling a flag sets an override and reveals a reset affordance", async () => {
    render(<LabsPanel />);
    const toggle = screen.getByRole("switch", { name: "Toggle Canary" });
    fireEvent.click(toggle);

    await waitFor(() => expect(toggle).toBeChecked());
    const overriddenNote = await screen.findByText(/Overridden/);
    expect(overriddenNote).toBeInTheDocument();
    // Persisted to the local mirror (non-Tauri path).
    expect(localStorage.getItem("charm:featureFlags")).toContain(A_FLAG);
  });

  it("reset clears the override and reverts to the default", async () => {
    render(<LabsPanel />);
    const toggle = screen.getByRole("switch", { name: "Toggle Canary" });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());

    const note = await screen.findByText(/Overridden/);
    const reset = within(note).getByRole("button", { name: /Reset to default/ });
    await waitFor(() => expect(reset).toBeEnabled());
    fireEvent.click(reset);

    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(screen.queryByText(/Overridden/)).not.toBeInTheDocument();
  });
});
