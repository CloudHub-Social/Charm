import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppearancePanel } from "./AppearancePanel";

describe("AppearancePanel", () => {
  it("renders a cross-link with no controls", () => {
    render(<AppearancePanel />);
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
