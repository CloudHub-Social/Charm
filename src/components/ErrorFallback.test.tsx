import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openSentryFeedbackDialog } from "@/observability/instrument";
import { ErrorFallback } from "./ErrorFallback";

vi.mock("@/observability/instrument", () => ({
  openSentryFeedbackDialog: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(openSentryFeedbackDialog).mockResolvedValue(true);
});

describe("ErrorFallback", () => {
  it("opens the Sentry feedback form from the crash screen", () => {
    render(<ErrorFallback resetError={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));

    expect(openSentryFeedbackDialog).toHaveBeenCalledTimes(1);
  });

  it("explains when feedback is unavailable", async () => {
    vi.mocked(openSentryFeedbackDialog).mockResolvedValue(false);
    render(<ErrorFallback resetError={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));

    expect(await screen.findByRole("status")).toBeVisible();
    expect(
      screen.getByText(
        "Feedback is available when Sentry observability is enabled and this build has a Sentry DSN.",
      ),
    ).toBeVisible();
  });
});
