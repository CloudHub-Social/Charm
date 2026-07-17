import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AddExistingToSpaceDialog } from "./AddExistingToSpaceDialog";
import { makeRoomSummary } from "./testFixtures";

const addExistingSpaceChild = vi.fn();

vi.mock("@/lib/matrix", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  addExistingSpaceChild: (...args: unknown[]) => addExistingSpaceChild(...args),
}));

const rooms = [
  makeRoomSummary({ room_id: "!design:localhost", name: "Design" }),
  makeRoomSummary({ room_id: "!eng:localhost", name: "Engineering", is_space: true }),
  makeRoomSummary({ room_id: "!dm:localhost", name: "Alice", is_direct: true }),
  makeRoomSummary({ room_id: "!invited:localhost", name: "Pending Invite", membership: "invite" }),
];

function renderDialog(overrides: Partial<Parameters<typeof AddExistingToSpaceDialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  render(
    <AddExistingToSpaceDialog
      spaceId="!team:localhost"
      spaceName="Team"
      rooms={rooms}
      excludedIds={new Set()}
      onOpenChange={onOpenChange}
      {...overrides}
    />,
  );
  return { onOpenChange };
}

describe("AddExistingToSpaceDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when spaceId is null", () => {
    renderDialog({ spaceId: null });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("lists joined rooms and spaces, excluding direct messages and excluded ids", () => {
    renderDialog({ excludedIds: new Set(["!eng:localhost"]) });

    expect(screen.getByRole("button", { name: /Design/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Engineering/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Alice/ })).not.toBeInTheDocument();
  });

  it("excludes rooms that are only pending invites, not joined yet", () => {
    renderDialog();

    expect(screen.getByRole("button", { name: /Design/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Pending Invite/ })).not.toBeInTheDocument();
  });

  it("marks space candidates with a Space label", () => {
    renderDialog();
    const engineeringButton = screen.getByRole("button", { name: /Engineering/ });
    expect(engineeringButton).toHaveTextContent("Space");
  });

  it("filters candidates by search query", () => {
    renderDialog();

    fireEvent.change(screen.getByPlaceholderText("Search your rooms and spaces"), {
      target: { value: "design" },
    });

    expect(screen.getByRole("button", { name: /Design/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Engineering/ })).not.toBeInTheDocument();
  });

  it("shows an empty state when no candidates match", () => {
    renderDialog();

    fireEvent.change(screen.getByPlaceholderText("Search your rooms and spaces"), {
      target: { value: "nonexistent" },
    });

    expect(screen.getByText("No matching rooms or spaces.")).toBeInTheDocument();
  });

  it("adds the selected room and closes on success", async () => {
    addExistingSpaceChild.mockResolvedValueOnce(undefined);
    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /Design/ }));

    expect(addExistingSpaceChild).toHaveBeenCalledWith("!team:localhost", "!design:localhost");
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("shows an error and keeps the dialog open on failure", async () => {
    addExistingSpaceChild.mockRejectedValueOnce(new Error("network error"));
    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /Design/ }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("network error"));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("resets query and error when closed", () => {
    const { onOpenChange } = renderDialog();

    fireEvent.change(screen.getByPlaceholderText("Search your rooms and spaces"), {
      target: { value: "design" },
    });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("clears a stale error and query when re-targeted at a different space without closing", async () => {
    addExistingSpaceChild.mockRejectedValueOnce(new Error("network error"));
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <AddExistingToSpaceDialog
        spaceId="!team:localhost"
        spaceName="Team"
        rooms={rooms}
        excludedIds={new Set()}
        onOpenChange={onOpenChange}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("Search your rooms and spaces"), {
      target: { value: "design" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Design/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("network error"));

    rerender(
      <AddExistingToSpaceDialog
        spaceId="!other:localhost"
        spaceName="Other"
        rooms={rooms}
        excludedIds={new Set()}
        onOpenChange={onOpenChange}
      />,
    );

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search your rooms and spaces")).toHaveValue("");
  });

  it("blocks dismissal while an add request is in flight", async () => {
    let resolveAdd: () => void = () => {};
    addExistingSpaceChild.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveAdd = resolve;
      }),
    );
    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /Design/ }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    resolveAdd();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("does not close a re-targeted dialog when an earlier request for a different space settles", async () => {
    let resolveFirstAdd: () => void = () => {};
    addExistingSpaceChild.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveFirstAdd = resolve;
      }),
    );
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <AddExistingToSpaceDialog
        spaceId="!team:localhost"
        spaceName="Team"
        rooms={rooms}
        excludedIds={new Set()}
        onOpenChange={onOpenChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Design/ }));

    rerender(
      <AddExistingToSpaceDialog
        spaceId="!other:localhost"
        spaceName="Other"
        rooms={rooms}
        excludedIds={new Set()}
        onOpenChange={onOpenChange}
      />,
    );

    resolveFirstAdd();
    await Promise.resolve();
    await Promise.resolve();

    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
