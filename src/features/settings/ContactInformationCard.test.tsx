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

  it("shows an error instead of a permanent loading state when the query fails", async () => {
    get3pids.mockRejectedValue(new Error("network error"));
    renderWithProviders(<ContactInformationCard />);

    expect(await screen.findByText("Couldn't load contact information")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("still shows an error on a failed background refetch, even with a cached empty result", async () => {
    // The empty-list early return must not run ahead of the isError check —
    // otherwise a query that first resolved to [] and then failed on a
    // later refetch would silently render nothing instead of the error.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["settings", "3pids"], []);
    get3pids.mockRejectedValue(new Error("network error"));

    render(
      <QueryClientProvider client={client}>
        <ContactInformationCard />
      </QueryClientProvider>,
    );
    await client.refetchQueries({ queryKey: ["settings", "3pids"] });

    expect(await screen.findByText("Couldn't load contact information")).toBeInTheDocument();
  });
});
