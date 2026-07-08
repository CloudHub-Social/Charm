import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObservabilityPanel } from "./ObservabilityPanel";

vi.mock("@/observability/instrument", () => ({
  initializeSentry: vi.fn(),
  closeSentry: vi.fn().mockResolvedValue(undefined),
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
  localStorage.clear();
});

describe("ObservabilityPanel", () => {
  it("renders Sentry opt-in off by default with sub-toggles disabled", async () => {
    renderPanel();

    const sentryToggle = await screen.findByRole("checkbox", {
      name: "Enable Sentry observability",
    });
    expect(sentryToggle).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Enable Sentry session replay" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Enable Sentry profiling" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Enable Sentry structured logs" })).toBeDisabled();
  });

  it("enables sub-toggles after primary opt-in", async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole("checkbox", { name: "Enable Sentry observability" }));

    expect(
      await screen.findByRole("checkbox", { name: "Enable Sentry session replay" }),
    ).toBeEnabled();
  });
});
