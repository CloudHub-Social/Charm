import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import packageJson from "../../../package.json";
import { AboutPanel } from "./AboutPanel";

describe("AboutPanel", () => {
  it("shows the app version and a link to the source repo", () => {
    render(<AboutPanel />);
    expect(screen.getByText(packageJson.version)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/CloudHub-Social/Charm",
    );
  });
});
