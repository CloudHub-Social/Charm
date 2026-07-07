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

  it("disables every Unblock button while any one request is in flight, and never fires a second concurrent unignoreUser call", async () => {
    getIgnoredUsers.mockResolvedValue(["@a:example.org", "@b:example.org"]);
    let resolveA!: () => void;
    unignoreUser.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveA = resolve;
        }),
    );
    renderWithProviders(<BlockedUsersCard />);
    await screen.findByText("@a:example.org");

    const [unblockA, unblockB] = screen.getAllByRole("button", { name: "Unblock" });
    fireEvent.click(unblockA);
    await waitFor(() => expect(unignoreUser).toHaveBeenCalledTimes(1));
    expect(unblockA).toBeDisabled();
    expect(unblockB).toBeDisabled();

    // `unignore_user` does a read-modify-write of the whole ignored-user
    // list server-side — a second concurrent call for a different user
    // could read the same pre-removal list and clobber @a's removal on
    // write. Clicking @b's (disabled) button while @a is in flight must not
    // start a second request.
    fireEvent.click(unblockB);
    expect(unignoreUser).toHaveBeenCalledTimes(1);
    expect(unignoreUser.mock.calls[0][0]).toBe("@a:example.org");

    resolveA();
    await waitFor(() => expect(unblockB).not.toBeDisabled());
  });
});
