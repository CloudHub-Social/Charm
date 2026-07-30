import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReactionBar } from "./ReactionBar";
import type { ReactionGroup } from "@/lib/matrix";
import type * as MatrixModule from "@/lib/matrix";

const mockUseFlag = vi.hoisted(() => vi.fn(() => true));
const getReactionDetails = vi.hoisted(() => vi.fn());

vi.mock("@/featureFlags", () => ({ useFlag: () => mockUseFlag() }));
vi.mock("@/lib/matrix", async (importOriginal) => {
  const actual = await importOriginal<typeof MatrixModule>();
  return { ...actual, getReactionDetails: (...args: unknown[]) => getReactionDetails(...args) };
});

describe("ReactionBar", () => {
  beforeEach(() => {
    mockUseFlag.mockReturnValue(true);
    getReactionDetails.mockReset().mockResolvedValue([]);
  });

  it("renders a chip per reaction group with its count", () => {
    const reactions: ReactionGroup[] = [
      { key: "👍", count: 2, reacted_by_me: false },
      { key: "🎉", count: 1, reacted_by_me: true },
    ];
    render(<ReactionBar reactions={reactions} onToggle={vi.fn()} />);

    expect(screen.getByText("👍")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("🎉")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("marks own reactions as pressed", () => {
    const reactions: ReactionGroup[] = [{ key: "🎉", count: 1, reacted_by_me: true }];
    render(<ReactionBar reactions={reactions} onToggle={vi.fn()} />);

    expect(screen.getByRole("button", { name: /🎉/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("calls onToggle with the reaction key when a chip is clicked", () => {
    const onToggle = vi.fn();
    const reactions: ReactionGroup[] = [{ key: "👍", count: 1, reacted_by_me: false }];
    render(<ReactionBar reactions={reactions} onToggle={onToggle} />);

    fireEvent.click(screen.getByRole("button", { name: /^👍\d+$/ }));

    expect(onToggle).toHaveBeenCalledWith("👍");
  });

  it("renders nothing when there are no reactions yet", () => {
    const { container } = render(<ReactionBar reactions={[]} onToggle={vi.fn()} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("disables chips and the add-reaction picker for a still-pending message", () => {
    const reactions: ReactionGroup[] = [{ key: "👍", count: 1, reacted_by_me: false }];
    render(<ReactionBar reactions={reactions} onToggle={vi.fn()} disabled />);

    expect(screen.getByRole("button", { name: /^👍\d+$/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add reaction" })).toBeDisabled();
  });

  it("keeps reaction details disabled when message-action parity is off", () => {
    mockUseFlag.mockReturnValue(false);
    const reactions: ReactionGroup[] = [{ key: "👍", count: 1, reacted_by_me: false }];
    render(
      <ReactionBar
        reactions={reactions}
        onToggle={vi.fn()}
        roomId="!room:example.org"
        eventId="$event"
      />,
    );

    fireEvent.mouseEnter(screen.getByRole("button", { name: /^👍\d+$/ }));

    expect(getReactionDetails).not.toHaveBeenCalled();
  });

  it.each([
    { roomId: undefined, eventId: "$event" },
    { roomId: "!room:example.org", eventId: undefined },
  ])("does not fetch details without both Matrix identifiers", ({ roomId, eventId }) => {
    const reactions: ReactionGroup[] = [{ key: "👍", count: 1, reacted_by_me: false }];
    render(
      <ReactionBar reactions={reactions} onToggle={vi.fn()} roomId={roomId} eventId={eventId} />,
    );

    fireEvent.mouseEnter(screen.getByRole("button", { name: /^👍\d+$/ }));

    expect(getReactionDetails).not.toHaveBeenCalled();
  });

  it("shows the empty-detail state after a successful lookup", async () => {
    getReactionDetails.mockResolvedValue([]);
    const reactions: ReactionGroup[] = [{ key: "👍", count: 1, reacted_by_me: false }];
    render(
      <ReactionBar
        reactions={reactions}
        onToggle={vi.fn()}
        roomId="!room:example.org"
        eventId="$event"
      />,
    );
    const chip = screen.getByRole("button", { name: /^👍\d+$/ });

    fireEvent.mouseEnter(chip);
    fireEvent.focus(chip);

    expect(await screen.findByText("No reactions")).toBeInTheDocument();
  });

  it("loads reaction details when a chip receives keyboard focus", async () => {
    getReactionDetails.mockResolvedValue([{ sender: "@alice:example.org", origin_server_ts: 1 }]);
    const reactions: ReactionGroup[] = [{ key: "👍", count: 1, reacted_by_me: false }];
    render(
      <ReactionBar
        reactions={reactions}
        onToggle={vi.fn()}
        roomId="!room:example.org"
        eventId="$event"
      />,
    );

    fireEvent.focus(screen.getByRole("button", { name: /^👍\d+$/ }));

    expect(await screen.findByText("@alice:example.org")).toBeInTheDocument();
    expect(getReactionDetails).toHaveBeenCalledOnce();
  });

  it("exposes a small reactor set through a touch-accessible viewer action", async () => {
    getReactionDetails.mockResolvedValue([
      { sender: "@alice:example.org", origin_server_ts: 1 },
      { sender: "@bob:example.org", origin_server_ts: 2 },
    ]);
    const reactions: ReactionGroup[] = [{ key: "👍", count: 2, reacted_by_me: false }];
    render(
      <ReactionBar
        reactions={reactions}
        onToggle={vi.fn()}
        roomId="!room:example.org"
        eventId="$event"
      />,
    );
    const chip = screen.getByRole("button", { name: /^👍\d+$/ });

    fireEvent.mouseEnter(chip);
    fireEvent.focus(chip);

    expect(await screen.findByText("@alice:example.org")).toBeInTheDocument();
    expect(screen.getByText("@bob:example.org")).toBeInTheDocument();
    const viewReactors = screen.getByRole("button", { name: "View all 2 reactions for 👍" });
    fireEvent.blur(chip, { relatedTarget: viewReactors });
    fireEvent.click(viewReactors);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("2 reactions")).toBeInTheDocument();
    expect(getReactionDetails).toHaveBeenCalledOnce();
  });

  it("exposes the reactor overflow as a directly keyboard-focusable action", async () => {
    getReactionDetails.mockResolvedValue(
      Array.from({ length: 9 }, (_, index) => ({
        sender: `@user-${index}:example.org`,
        origin_server_ts: index,
      })),
    );
    const reactions: ReactionGroup[] = [{ key: "👍", count: 9, reacted_by_me: false }];
    render(
      <ReactionBar
        reactions={reactions}
        onToggle={vi.fn()}
        roomId="!room:example.org"
        eventId="$event"
      />,
    );

    const viewAll = screen.getByRole("button", { name: "View all 9 reactions for 👍" });
    viewAll.focus();
    expect(viewAll).toHaveFocus();

    fireEvent.click(viewAll);

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(await screen.findByText("@user-8:example.org")).toBeInTheDocument();
  });

  it("shows a loading state while the full reactor list refetches", async () => {
    getReactionDetails.mockReturnValue(new Promise(() => {}));
    const reactions: ReactionGroup[] = [{ key: "👍", count: 9, reacted_by_me: false }];
    render(
      <ReactionBar
        reactions={reactions}
        onToggle={vi.fn()}
        roomId="!room:example.org"
        eventId="$event"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "View all 9 reactions for 👍" }));

    expect(await screen.findByText("Loading reactions…")).toBeInTheDocument();
    expect(screen.queryByText("0 reactions")).not.toBeInTheDocument();
  });

  it("surfaces a full-list failure and retries the reactor lookup", async () => {
    const recoveredDetails = Array.from({ length: 9 }, (_, index) => ({
      sender: `@recovered-${index}:example.org`,
      origin_server_ts: index,
    }));
    getReactionDetails
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(recoveredDetails);
    const reactions: ReactionGroup[] = [{ key: "👍", count: 9, reacted_by_me: false }];
    render(
      <ReactionBar
        reactions={reactions}
        onToggle={vi.fn()}
        roomId="!room:example.org"
        eventId="$event"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "View all 9 reactions for 👍" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load reactions.");
    expect(screen.queryByText("Loading reactions…")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("@recovered-8:example.org")).toBeInTheDocument();
    expect(getReactionDetails).toHaveBeenCalledTimes(2);
  });

  it("clears reactor details after the full-list dialog closes", async () => {
    const firstDetails = Array.from({ length: 9 }, (_, index) => ({
      sender: `@first-${index}:example.org`,
      origin_server_ts: index,
    }));
    const refreshedDetails = Array.from({ length: 9 }, (_, index) => ({
      sender: `@refreshed-${index}:example.org`,
      origin_server_ts: index + 10,
    }));
    getReactionDetails.mockResolvedValueOnce(firstDetails).mockResolvedValueOnce(refreshedDetails);
    const reactions: ReactionGroup[] = [{ key: "👍", count: 9, reacted_by_me: false }];
    render(
      <ReactionBar
        reactions={reactions}
        onToggle={vi.fn()}
        roomId="!room:example.org"
        eventId="$event"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "View all 9 reactions for 👍" }));
    expect(await screen.findByText("@first-8:example.org")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    const chip = screen.getByRole("button", { name: /^👍9$/ });
    fireEvent.mouseEnter(chip);
    fireEvent.focus(chip);

    expect(await screen.findByText("@refreshed-0:example.org")).toBeInTheDocument();
    expect(getReactionDetails).toHaveBeenCalledTimes(2);
  });

  it("surfaces detail lookup failures instead of loading forever", async () => {
    getReactionDetails.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([]);
    const reactions: ReactionGroup[] = [{ key: "👍", count: 1, reacted_by_me: false }];
    render(
      <ReactionBar
        reactions={reactions}
        onToggle={vi.fn()}
        roomId="!room:example.org"
        eventId="$event"
      />,
    );
    const chip = screen.getByRole("button", { name: /^👍\d+$/ });

    fireEvent.mouseEnter(chip);
    fireEvent.focus(chip);

    expect(await screen.findByText("Could not load reactions.")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    await waitFor(() => expect(getReactionDetails).toHaveBeenCalledOnce());

    fireEvent.blur(chip);
    fireEvent.mouseEnter(chip);
    fireEvent.focus(chip);

    expect(await screen.findByText("No reactions")).toBeInTheDocument();
    expect(getReactionDetails).toHaveBeenCalledTimes(2);
  });

  it("deduplicates repeated hover requests before React commits loading state", () => {
    getReactionDetails.mockReturnValue(new Promise(() => {}));
    const reactions: ReactionGroup[] = [{ key: "👍", count: 1, reacted_by_me: false }];
    render(
      <ReactionBar
        reactions={reactions}
        onToggle={vi.fn()}
        roomId="!room:example.org"
        eventId="$event"
      />,
    );
    const chip = screen.getByRole("button", { name: /^👍\d+$/ });

    fireEvent.mouseEnter(chip);
    fireEvent.mouseEnter(chip);

    expect(getReactionDetails).toHaveBeenCalledTimes(1);
  });

  it("discards a reaction-detail response after its tooltip closes", async () => {
    let resolveDetails!: (details: Array<{ sender: string; origin_server_ts: number }>) => void;
    getReactionDetails.mockReturnValue(
      new Promise((resolve) => {
        resolveDetails = resolve;
      }),
    );
    const reactions: ReactionGroup[] = [{ key: "👍", count: 1, reacted_by_me: false }];
    render(
      <ReactionBar
        reactions={reactions}
        onToggle={vi.fn()}
        roomId="!room:example.org"
        eventId="$event"
      />,
    );
    const chip = screen.getByRole("button", { name: /^👍\d+$/ });

    fireEvent.mouseEnter(chip);
    fireEvent.focus(chip);
    fireEvent.blur(chip);
    resolveDetails([{ sender: "@alice:example.org", origin_server_ts: 1 }]);

    await waitFor(() => expect(getReactionDetails).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("@alice:example.org")).not.toBeInTheDocument();

    fireEvent.mouseEnter(chip);
    expect(getReactionDetails).toHaveBeenCalledTimes(2);
  });

  it("uses the live reaction count while cached reactor details refresh", async () => {
    const details = Array.from({ length: 9 }, (_, index) => ({
      sender: `@user-${index}:example.org`,
      origin_server_ts: index,
    }));
    getReactionDetails.mockResolvedValueOnce(details).mockReturnValueOnce(new Promise(() => {}));
    const { rerender } = render(
      <ReactionBar
        reactions={[{ key: "👍", count: 9, reacted_by_me: false }]}
        onToggle={vi.fn()}
        roomId="!room:example.org"
        eventId="$event"
      />,
    );

    const chip = screen.getByRole("button", { name: /^👍9$/ });
    fireEvent.mouseEnter(chip);
    fireEvent.focus(chip);
    expect(
      await screen.findByRole("button", { name: "View all 9 reactions for 👍" }),
    ).toBeInTheDocument();

    rerender(
      <ReactionBar
        reactions={[{ key: "👍", count: 10, reacted_by_me: false }]}
        onToggle={vi.fn()}
        roomId="!room:example.org"
        eventId="$event"
      />,
    );

    expect(
      screen.getByRole("button", { name: "View all 10 reactions for 👍" }),
    ).toBeInTheDocument();
  });

  it("refreshes an open tooltip when its reaction count changes", async () => {
    getReactionDetails
      .mockResolvedValueOnce([{ sender: "@alice:example.org", origin_server_ts: 1 }])
      .mockResolvedValueOnce([
        { sender: "@alice:example.org", origin_server_ts: 1 },
        { sender: "@bob:example.org", origin_server_ts: 2 },
      ]);
    const { rerender } = render(
      <ReactionBar
        reactions={[{ key: "👍", count: 1, reacted_by_me: false }]}
        onToggle={vi.fn()}
        roomId="!room:example.org"
        eventId="$event"
      />,
    );
    const chip = screen.getByRole("button", { name: /^👍1$/ });
    fireEvent.mouseEnter(chip);
    fireEvent.focus(chip);
    expect(await screen.findByText("@alice:example.org")).toBeInTheDocument();

    rerender(
      <ReactionBar
        reactions={[{ key: "👍", count: 2, reacted_by_me: false }]}
        onToggle={vi.fn()}
        roomId="!room:example.org"
        eventId="$event"
      />,
    );

    expect(await screen.findByText("@bob:example.org")).toBeInTheDocument();
    expect(getReactionDetails).toHaveBeenCalledTimes(2);
  });

  it("closes the reactor dialog when its reaction disappears", async () => {
    getReactionDetails.mockResolvedValue([{ sender: "@alice:example.org", origin_server_ts: 1 }]);
    const props = {
      onToggle: vi.fn(),
      roomId: "!room:example.org",
      eventId: "$event",
    };
    const { rerender } = render(
      <ReactionBar {...props} reactions={[{ key: "👍", count: 1, reacted_by_me: false }]} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "View all 1 reactions for 👍" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    rerender(<ReactionBar {...props} reactions={[]} />);

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("invalidates tooltip details when a reaction disappears and later returns", async () => {
    getReactionDetails
      .mockResolvedValueOnce([{ sender: "@alice:example.org", origin_server_ts: 1 }])
      .mockResolvedValueOnce([{ sender: "@bob:example.org", origin_server_ts: 2 }]);
    const props = {
      onToggle: vi.fn(),
      roomId: "!room:example.org",
      eventId: "$event",
    };
    const reaction: ReactionGroup = { key: "👍", count: 1, reacted_by_me: false };
    const { rerender } = render(<ReactionBar {...props} reactions={[reaction]} />);
    const chip = screen.getByRole("button", { name: /^👍1$/ });
    fireEvent.mouseEnter(chip);
    fireEvent.focus(chip);
    expect(await screen.findByText("@alice:example.org")).toBeInTheDocument();

    rerender(<ReactionBar {...props} reactions={[]} />);
    rerender(<ReactionBar {...props} reactions={[reaction]} />);

    const restoredChip = screen.getByRole("button", { name: /^👍1$/ });
    fireEvent.mouseEnter(restoredChip);
    fireEvent.focus(restoredChip);

    expect(await screen.findByText("@bob:example.org")).toBeInTheDocument();
    expect(getReactionDetails).toHaveBeenCalledTimes(2);
  });
});
