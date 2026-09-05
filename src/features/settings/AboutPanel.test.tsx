import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import packageJson from "../../../package.json";
import { AboutPanel } from "./AboutPanel";

const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  writeText.mockClear();
  Object.assign(navigator, { clipboard: { writeText } });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("AboutPanel", () => {
  it("shows the app version, source, license, and third-party notices", () => {
    vi.stubEnv("VITE_BUILD_ID", "");
    render(<AboutPanel />);
    // Scoped to the <span> (Version row) — the Build row's fallback button
    // renders "{version}-dev" (formatBuildIdForDisplay), not the bare
    // version, so this selector is no longer ambiguous between the two rows.
    expect(screen.getByText(packageJson.version, { selector: "span" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/CloudHub-Social/Charm",
    );
    expect(screen.getByRole("link", { name: "Apache-2.0" })).toHaveAttribute(
      "href",
      "https://github.com/CloudHub-Social/Charm/blob/main/LICENSE",
    );
    expect(screen.getByRole("link", { name: "Notices" })).toHaveAttribute(
      "href",
      "https://github.com/CloudHub-Social/Charm/blob/main/THIRD_PARTY_NOTICES.md",
    );
  });

  it("shows a Build row with a human-friendly, copyable build identifier (Spec 24)", () => {
    vi.stubEnv("VITE_BUILD_ID", "0.4.2+pr187.a1b2c3d");
    render(<AboutPanel />);

    // The button's accessible name/copy value stay the raw canonical id (what
    // a reporter needs to paste), but the visible label is the friendlier
    // "{version}-pr{n} (sha-{sha})" rendering from formatBuildIdForDisplay.
    const buildButton = screen.getByRole("button", {
      name: "Copy build identifier 0.4.2+pr187.a1b2c3d",
    });
    expect(buildButton).toHaveTextContent("0.4.2-pr187 (sha-a1b2c3d)");
  });

  it("pins legal metadata links to the build source revision", () => {
    vi.stubEnv("VITE_BUILD_ID", "0.4.2+nightly.a1b2c3d");
    render(<AboutPanel />);

    expect(screen.getByRole("link", { name: "Apache-2.0" })).toHaveAttribute(
      "href",
      "https://github.com/CloudHub-Social/Charm/blob/a1b2c3d/LICENSE",
    );
    expect(screen.getByRole("link", { name: "Notices" })).toHaveAttribute(
      "href",
      "https://github.com/CloudHub-Social/Charm/blob/a1b2c3d/THIRD_PARTY_NOTICES.md",
    );
  });

  it("copies the build identifier to the clipboard when clicked", async () => {
    vi.stubEnv("VITE_BUILD_ID", "0.4.2+a1b2c3d");
    render(<AboutPanel />);

    const buildButton = screen.getByRole("button", {
      name: "Copy build identifier 0.4.2+a1b2c3d",
    });
    fireEvent.click(buildButton);

    expect(writeText).toHaveBeenCalledWith("0.4.2+a1b2c3d");
    await screen.findByText("Copied");
  });

  it("falls back to the package version when VITE_BUILD_ID is unset", () => {
    render(<AboutPanel />);
    const buildButton = screen.getByRole("button", {
      name: `Copy build identifier ${packageJson.version}`,
    });
    expect(buildButton).toHaveTextContent(`${packageJson.version}-dev`);
  });

  it("does not show Copied when the Clipboard API is unavailable", async () => {
    Object.assign(navigator, { clipboard: undefined });
    vi.stubEnv("VITE_BUILD_ID", "0.4.2+a1b2c3d");
    render(<AboutPanel />);

    const buildButton = screen.getByRole("button", {
      name: "Copy build identifier 0.4.2+a1b2c3d",
    });
    fireEvent.click(buildButton);

    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByText("Copied")).not.toBeInTheDocument();
  });
});
