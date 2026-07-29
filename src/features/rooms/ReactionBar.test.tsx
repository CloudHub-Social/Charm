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

    fireEvent.click(screen.getByRole("button", { name: /👍/ }));

    expect(onToggle).toHaveBeenCalledWith("👍");
  });

  it("renders nothing when there are no reactions yet", () => {
    const { container } = render(<ReactionBar reactions={[]} onToggle={vi.fn()} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("disables chips and the add-reaction picker for a still-pending message", () => {
    const reactions: ReactionGroup[] = [{ key: "👍", count: 1, reacted_by_me: false }];
    render(<ReactionBar reactions={reactions} onToggle={vi.fn()} disabled />);

    expect(screen.getByRole("button", { name: /👍/ })).toBeDisabled();
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

    fireEvent.mouseEnter(screen.getByRole("button", { name: /👍/ }));

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

    fireEvent.mouseEnter(screen.getByRole("button", { name: /👍/ }));

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
    const chip = screen.getByRole("button", { name: /👍/ });

    fireEvent.mouseEnter(chip);
    fireEvent.focus(chip);

    expect(await screen.findByText("No reactions")).toBeInTheDocument();
  });

  it("lists a small reactor set without a View all action", async () => {
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
    const chip = screen.getByRole("button", { name: /👍/ });

    fireEvent.mouseEnter(chip);
    fireEvent.focus(chip);

    expect(await screen.findByText("@alice:example.org")).toBeInTheDocument();
    expect(screen.getByText("@bob:example.org")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /View all/ })).not.toBeInTheDocument();
  });

  it("leaves the tooltip in its loading state when detail lookup fails", async () => {
    getReactionDetails.mockRejectedValue(new Error("offline"));
    const reactions: ReactionGroup[] = [{ key: "👍", count: 1, reacted_by_me: false }];
    render(
      <ReactionBar
        reactions={reactions}
        onToggle={vi.fn()}
        roomId="!room:example.org"
        eventId="$event"
      />,
    );
    const chip = screen.getByRole("button", { name: /👍/ });

    fireEvent.mouseEnter(chip);
    fireEvent.focus(chip);

    expect(await screen.findByText("Loading…")).toBeInTheDocument();
    await waitFor(() => expect(getReactionDetails).toHaveBeenCalledOnce());
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
    const chip = screen.getByRole("button", { name: /👍/ });

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
    const chip = screen.getByRole("button", { name: /👍/ });

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

    const chip = screen.getByRole("button", { name: /👍/ });
    fireEvent.mouseEnter(chip);
    fireEvent.focus(chip);
    expect(await screen.findByRole("button", { name: "View all 9" })).toBeInTheDocument();

    rerender(
      <ReactionBar
        reactions={[{ key: "👍", count: 10, reacted_by_me: false }]}
        onToggle={vi.fn()}
        roomId="!room:example.org"
        eventId="$event"
      />,
    );

    expect(screen.getByRole("button", { name: "View all 10" })).toBeInTheDocument();
  });
});
