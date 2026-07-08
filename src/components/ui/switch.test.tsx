import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Switch } from "./switch";

describe("Switch", () => {
  it("exposes switch semantics and toggles when uncontrolled", () => {
    render(<Switch aria-label="Enable setting" />);

    const control = screen.getByRole("switch", { name: "Enable setting" });
    expect(control).toHaveAttribute("aria-checked", "false");

    fireEvent.click(control);

    expect(control).toHaveAttribute("aria-checked", "true");
  });

  it("reports checked changes when controlled", () => {
    const onCheckedChange = vi.fn();
    render(
      <Switch aria-label="Enable setting" checked={false} onCheckedChange={onCheckedChange} />,
    );

    fireEvent.click(screen.getByRole("switch", { name: "Enable setting" }));

    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });
});
