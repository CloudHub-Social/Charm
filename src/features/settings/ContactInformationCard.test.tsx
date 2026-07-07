import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContactInformationCard } from "./ContactInformationCard";

const get3pids = vi.fn();

vi.mock("@/lib/matrix", () => ({
  get3pids: (...args: unknown[]) => get3pids(...args),
}));

function renderWithProviders(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

beforeEach(() => {
  get3pids.mockReset();
});

describe("ContactInformationCard", () => {
  it("lists confirmed email/phone contact methods", async () => {
    get3pids.mockResolvedValue([
      { medium: "email", address: "me@example.org" },
      { medium: "msisdn", address: "15555550123" },
    ]);
    renderWithProviders(<ContactInformationCard />);

    expect(await screen.findByText("me@example.org")).toBeInTheDocument();
    expect(screen.getByText("Email")).toBeInTheDocument();
    expect(screen.getByText("15555550123")).toBeInTheDocument();
    expect(screen.getByText("Phone")).toBeInTheDocument();
  });

  it("renders nothing when there are no confirmed contact methods", async () => {
    get3pids.mockResolvedValue([]);
    const { container } = renderWithProviders(<ContactInformationCard />);

    await vi.waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
