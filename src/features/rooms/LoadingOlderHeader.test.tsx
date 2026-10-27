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
});
