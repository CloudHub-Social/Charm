import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeSentry, openSentryFeedbackDialog } from "@/observability/instrument";
import { ObservabilityPanel } from "./ObservabilityPanel";

vi.mock("@/observability/instrument", () => ({
  initializeSentry: vi.fn(),
  closeSentry: vi.fn().mockResolvedValue(undefined),
  openSentryFeedbackDialog: vi.fn().mockResolvedValue(true),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn().mockRejectedValue(new Error("store unavailable")),
}));

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ObservabilityPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(initializeSentry).mockReturnValue(true);
  vi.mocked(openSentryFeedbackDialog).mockResolvedValue(true);
  localStorage.clear();
});

describe("ObservabilityPanel", () => {
  it("renders Sentry opt-in off by default with sub-toggles disabled", async () => {
    renderPanel();

    const sentryToggle = await screen.findByRole("switch", {
      name: "Enable Sentry observability",
    });
    expect(sentryToggle).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Enable Sentry session replay" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Enable Sentry profiling" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Enable Sentry structured logs" })).toBeDisabled();
  });

  it("enables sub-toggles after primary opt-in", async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole("switch", { name: "Enable Sentry observability" }));

    expect(
      await screen.findByRole("switch", { name: "Enable Sentry session replay" }),
    ).toBeEnabled();
  });

  it("gates the feedback form behind Sentry opt-in", async () => {
    renderPanel();

    const feedbackButton = await screen.findByRole("button", { name: "Send feedback" });
    expect(feedbackButton).toBeDisabled();

    fireEvent.click(screen.getByRole("switch", { name: "Enable Sentry observability" }));

    expect(feedbackButton).toBeDisabled();
  });

  it("also requires a feedback category before the button is enabled", async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole("switch", { name: "Enable Sentry observability" }));
    const feedbackButton = screen.getByRole("button", { name: "Send feedback" });
    expect(feedbackButton).toBeDisabled();

    fireEvent.click(screen.getByRole("radio", { name: "Bug" }));

    expect(feedbackButton).toBeEnabled();
    fireEvent.click(feedbackButton);

    expect(openSentryFeedbackDialog).toHaveBeenCalledTimes(1);
    expect(openSentryFeedbackDialog).toHaveBeenCalledWith({
      surface: "settings",
      category: "bug",
    });
  });

  it("passes the feature-request category when selected", async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole("switch", { name: "Enable Sentry observability" }));
    fireEvent.click(screen.getByRole("radio", { name: "Feature request" }));
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));

    expect(openSentryFeedbackDialog).toHaveBeenCalledWith({
      surface: "settings",
      category: "feature_request",
    });
  });

  it("announces feedback availability failures", async () => {
    vi.mocked(openSentryFeedbackDialog).mockResolvedValue(false);
    renderPanel();

    fireEvent.click(await screen.findByRole("switch", { name: "Enable Sentry observability" }));
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
