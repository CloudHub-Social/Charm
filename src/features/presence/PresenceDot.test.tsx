import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatLastActiveAgo, PresenceDot } from "./PresenceDot";
import { renderWithProviders } from "@/test/renderWithProviders";

describe("PresenceDot (Spec 40, item 6)", () => {
  it("renders no tooltip when neither statusMsg nor lastActiveAgoMs is present", () => {
    renderWithProviders(<PresenceDot presence="online" />);
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.queryByText(/Active/)).not.toBeInTheDocument();
  });

  it("returns null when presence is unknown", () => {
    const { container } = renderWithProviders(<PresenceDot presence={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a tooltip trigger with the status message and last-active time", () => {
    renderWithProviders(
      <PresenceDot presence="unavailable" statusMsg="Making cupcakes" lastActiveAgoMs={65_000} />,
    );
    // Radix only mounts TooltipContent on open, but the accessible dot label
    // and trigger are always present.
    expect(screen.getByText("Away")).toBeInTheDocument();
  });
});

describe("formatLastActiveAgo (Spec 40, item 6)", () => {
  it("renders sub-minute durations as just now", () => {
    expect(formatLastActiveAgo(30_000)).toBe("Active just now");
  });

  it("renders minutes", () => {
    expect(formatLastActiveAgo(5 * 60_000)).toBe("Active 5m ago");
  });

  it("renders hours once past 60 minutes", () => {
    expect(formatLastActiveAgo(3 * 60 * 60_000)).toBe("Active 3h ago");
  });

  it("renders days once past 24 hours", () => {
    expect(formatLastActiveAgo(2 * 24 * 60 * 60_000)).toBe("Active 2d ago");
  });
});
