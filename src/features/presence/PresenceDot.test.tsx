import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatLastActiveAgo, PresenceDot } from "./PresenceDot";
import { renderWithProviders } from "@/test/renderWithProviders";

describe("formatLastActiveAgo", () => {
  it("formats sub-minute durations as 'just now'", () => {
    expect(formatLastActiveAgo(5_000)).toBe("Active just now");
  });

  it("formats minutes", () => {
    expect(formatLastActiveAgo(5 * 60_000)).toBe("Active 5m ago");
  });

  it("formats hours", () => {
    expect(formatLastActiveAgo(3 * 60 * 60_000)).toBe("Active 3h ago");
  });

  it("formats days", () => {
    expect(formatLastActiveAgo(2 * 24 * 60 * 60_000)).toBe("Active 2d ago");
  });
});

describe("PresenceDot", () => {
  it("renders nothing when presence is unknown", () => {
    const { container } = renderWithProviders(<PresenceDot presence={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a plain sr-only label with no status message or last-active", () => {
    renderWithProviders(<PresenceDot presence="online" />);
    expect(screen.getByText("Online")).toBeInTheDocument();
  });

  it("includes the status message and last-active-ago in the accessible text when provided", () => {
    renderWithProviders(
      <PresenceDot presence="online" statusMsg="Making cupcakes" lastActiveAgoMs={5 * 60_000} />,
    );
    expect(screen.getByText(/Online — Making cupcakes/)).toBeInTheDocument();
    expect(screen.getByText(/Active 5m ago/)).toBeInTheDocument();
  });
});
