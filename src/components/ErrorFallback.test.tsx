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
  it("requires a feedback category before the button is enabled", () => {
    render(<ErrorFallback resetError={vi.fn()} sentryEventId="event-123" />);

    expect(screen.getByRole("button", { name: "Send feedback" })).toBeDisabled();
  });

  it("opens the Sentry feedback form from the crash screen with the chosen category", () => {
    render(<ErrorFallback resetError={vi.fn()} sentryEventId="event-123" />);

    fireEvent.click(screen.getByRole("radio", { name: "Bug" }));
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));

    expect(openSentryFeedbackDialog).toHaveBeenCalledTimes(1);
    expect(openSentryFeedbackDialog).toHaveBeenCalledWith({
      associatedEventId: "event-123",
      surface: "crash-fallback",
      category: "bug",
    });
  });

  it("passes the feature-request category when selected", () => {
    render(<ErrorFallback resetError={vi.fn()} sentryEventId="event-123" />);

    fireEvent.click(screen.getByRole("radio", { name: "Feature request" }));
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));

    expect(openSentryFeedbackDialog).toHaveBeenCalledWith({
      associatedEventId: "event-123",
      surface: "crash-fallback",
      category: "feature_request",
    });
  });

  it("explains when feedback is unavailable", async () => {
    vi.mocked(openSentryFeedbackDialog).mockResolvedValue(false);
    render(<ErrorFallback resetError={vi.fn()} />);

    fireEvent.click(screen.getByRole("radio", { name: "Bug" }));
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));

    expect(await screen.findByRole("status")).toBeVisible();
    expect(
      screen.getByText(
        "Feedback is available when Sentry observability is enabled and this build has a Sentry DSN.",
      ),
    ).toBeVisible();
  });
});
