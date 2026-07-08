import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SettingsCard, SettingTile } from "./SettingsCard";

describe("SettingsCard / SettingTile", () => {
  it("renders an optional heading above the card", () => {
    render(
      <SettingsCard heading="Security">
        <SettingTile title="Password" />
      </SettingsCard>,
    );
    expect(screen.getByRole("heading", { name: "Security" })).toBeInTheDocument();
  });

  it("omits the heading element when none is given", () => {
    render(
      <SettingsCard>
        <SettingTile title="Password" />
      </SettingsCard>,
    );
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it("renders title, description, and a trailing control", () => {
    render(
      <SettingsCard>
        <SettingTile
          title="Theme"
          description="Changes apply immediately."
          control={<button type="button">Change</button>}
        />
      </SettingsCard>,
    );
    expect(screen.getByText("Theme")).toBeInTheDocument();
    expect(screen.getByText("Changes apply immediately.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change" })).toBeInTheDocument();
  });

  it("renders custom children instead of the title/description/control layout", () => {
    render(
      <SettingsCard>
        <SettingTile>
          <span>Custom row content</span>
        </SettingTile>
      </SettingsCard>,
    );
    expect(screen.getByText("Custom row content")).toBeInTheDocument();
  });
});
