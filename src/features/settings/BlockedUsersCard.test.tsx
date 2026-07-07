import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlockedUsersCard } from "./BlockedUsersCard";

const getIgnoredUsers = vi.fn();
const unignoreUser = vi.fn();

vi.mock("@/lib/matrix", () => ({
  getIgnoredUsers: (...args: unknown[]) => getIgnoredUsers(...args),
  unignoreUser: (...args: unknown[]) => unignoreUser(...args),
}));

function renderWithProviders(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

beforeEach(() => {
  getIgnoredUsers.mockReset();
  unignoreUser.mockReset().mockResolvedValue(undefined);
});

describe("BlockedUsersCard", () => {
  it("lists ignored users and unblocks one on click", async () => {
    getIgnoredUsers.mockResolvedValue(["@spammer:example.org"]);
    renderWithProviders(<BlockedUsersCard />);

    expect(await screen.findByText("@spammer:example.org")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Unblock" }));

    await waitFor(() => expect(unignoreUser).toHaveBeenCalled());
    expect(unignoreUser.mock.calls[0][0]).toBe("@spammer:example.org");
  });

  it("renders nothing when there are no blocked users", async () => {
    getIgnoredUsers.mockResolvedValue([]);
    const { container } = renderWithProviders(<BlockedUsersCard />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("keeps a user's own Unblock button disabled while its request is in flight, even after unblocking a second user", async () => {
    getIgnoredUsers.mockResolvedValue(["@a:example.org", "@b:example.org"]);
    let resolveA!: () => void;
    unignoreUser.mockImplementation(
      (userId: string) =>
        new Promise<void>((resolve) => {
          if (userId === "@a:example.org") resolveA = resolve;
          else resolve();
        }),
    );
    renderWithProviders(<BlockedUsersCard />);
    await screen.findByText("@a:example.org");

    const [unblockA, unblockB] = screen.getAllByRole("button", { name: "Unblock" });
    fireEvent.click(unblockA);
    expect(unblockA).toBeDisabled();

    fireEvent.click(unblockB);
    await waitFor(() => expect(unignoreUser).toHaveBeenCalledTimes(2));
    expect(unignoreUser.mock.calls[1][0]).toBe("@b:example.org");

    // @a's own request is still unresolved — its button must stay disabled
    // rather than re-enabling just because a *different* mutation call
    // settled.
    expect(unblockA).toBeDisabled();

    resolveA();
    await waitFor(() => expect(unblockA).not.toBeDisabled());
  });
});
