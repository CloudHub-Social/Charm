import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LoadingOlderHeader } from "./LoadingOlderHeader";

describe("timeline header gutters", () => {
  it("keeps the loading label inset from the clipped timeline boundary", () => {
    render(<LoadingOlderHeader context={{ loadingMore: true, hasMore: true }} />);
    expect(screen.getByText(/Loading older messages/)).toHaveClass("px-4", "pt-4");
  });

  it("keeps caught-up hairlines inside the message gutters", () => {
    render(<LoadingOlderHeader context={{ loadingMore: false, hasMore: false }} />);
    expect(screen.getByText("You're all caught up").parentElement).toHaveClass("px-4", "pt-4");
  });
  it.each([true, false])("uses refreshed gutters when loading=%s", (loadingMore) => {
    render(
      <LoadingOlderHeader context={{ loadingMore, hasMore: false, uxRefreshEnabled: true }} />,
    );
    const label = screen.getByText(loadingMore ? /Loading older messages/ : "You're all caught up");
    const surface = loadingMore ? label : label.parentElement;
    expect(surface).toHaveClass("px-3", "pt-5", "sm:px-6");
    expect(surface).not.toHaveClass("pt-4");
  });

  it("does not reserve a header surface when history remains available", () => {
    const { container } = render(
      <LoadingOlderHeader context={{ loadingMore: false, hasMore: true }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
