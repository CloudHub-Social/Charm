import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as MatrixModule from "@/lib/matrix";
import { PollMessage } from "./PollMessage";
import { makeMessageSummary } from "./testFixtures";
import type { MessageRowLayoutProps } from "./messageRowShared";

const voteOnPoll = vi.fn();
const endPoll = vi.fn();
const displayFormats = vi.hoisted(() => ({ clockFormat: "24h" as "12h" | "24h" }));

vi.mock("@/features/appearance/useDisplayFormats", () => ({
  useDisplayFormats: () => displayFormats,
}));

vi.mock("@/featureFlags", () => ({ useFlag: () => true }));

vi.mock("@/lib/matrix", async () => {
  const actual = await vi.importActual<typeof MatrixModule>("@/lib/matrix");
  return {
    ...actual,
    voteOnPoll: (...args: unknown[]) => voteOnPoll(...args),
    endPoll: (...args: unknown[]) => endPoll(...args),
  };
});

function pollMessage(
  overrides: Partial<NonNullable<MatrixModule.RoomMessageSummary["poll"]>> = {},
) {
  return makeMessageSummary({
    event_id: "$poll",
    sender: "@alice:example.org",
    sender_display_name: "Alice",
    body: "Poll fallback",
    poll: {
      question: "Lunch?",
      kind: "disclosed",
      max_selections: 1,
      answers: [
        { id: "0", text: "Pizza", votes: 2, selected_by_me: false },
        { id: "1", text: "Tacos", votes: 1, selected_by_me: true },
      ],
      ended: false,
      edited: false,
      ...overrides,
    },
  });
}

function rowActions(overrides: Partial<MessageRowLayoutProps> = {}): MessageRowLayoutProps {
  return {
    message: pollMessage(),
    roomId: "!room:example.org",
    currentUserId: "@moderator:example.org",
    own: false,
    sameSenderAsPrev: false,
    sameSenderAsNext: false,
    canRedact: false,
    canPin: false,
    isPinned: false,
    readers: [],
    senderNameByUserId: new Map(),
    isNew: false,
    getActionsHandle: () => undefined,
    registerActionsRef: vi.fn(),
    onReply: vi.fn(),
    onReact: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onCopy: vi.fn(),
    onCopyLink: vi.fn(),
    onPin: vi.fn(),
    onUnpin: vi.fn(),
    onResend: vi.fn(),
    onDiscard: vi.fn(),
    onJumpToMessage: vi.fn(),
    isPending: false,
    isError: false,
    disableRelationActions: false,
    isUndecrypted: false,
    rowKey: "$poll",
    ...overrides,
  };
}

beforeEach(() => {
  voteOnPoll.mockReset().mockResolvedValue("txn-vote");
  endPoll.mockReset().mockResolvedValue("txn-end");
});

describe("PollMessage", () => {
  it("does not label multi-select answer totals as voters or percentages", () => {
    render(
      <PollMessage
        message={pollMessage({
          max_selections: 2,
          answers: [
            { id: "0", text: "Pizza", votes: 1, selected_by_me: true },
            { id: "1", text: "Tacos", votes: 1, selected_by_me: true },
          ],
        })}
        roomId="!room:example.org"
        own={false}
      />,
    );
    expect(screen.getByText("2 selections")).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    expect(screen.queryByText(/2 votes/)).not.toBeInTheDocument();
  });

  it("does not start row long press from interactive poll controls", () => {
    const startLongPress = vi.fn();
    render(
      <PollMessage
        message={pollMessage()}
        roomId="!room:example.org"
        own
        rowActions={rowActions({
          onSenderClick: vi.fn(),
          getActionsHandle: () => ({
            startLongPress,
            cancelLongPress: vi.fn(),
          }),
        })}
      />,
    );
    for (const name of ["Alice", /Pizza/, "End poll"]) {
      fireEvent.touchStart(screen.getByRole("button", { name }));
    }
    expect(startLongPress).not.toHaveBeenCalled();
    fireEvent.touchStart(screen.getByRole("heading", { name: "Lunch?" }));
    expect(startLongPress).toHaveBeenCalledOnce();
  });

  it("opens the sender profile through the shared row action", () => {
    const onSenderClick = vi.fn();
    render(
      <PollMessage
        message={pollMessage()}
        roomId="!room:example.org"
        own={false}
        rowActions={rowActions({ onSenderClick })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Alice" }));
    expect(onSenderClick).toHaveBeenCalledWith("@alice:example.org", "Alice");
  });

  it("excludes voting during end admission without treating queue acceptance as closure", async () => {
    let finish!: () => void;
    endPoll.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<PollMessage message={pollMessage()} roomId="!room:example.org" own />);
    fireEvent.click(screen.getByRole("button", { name: "End poll" }));
    const answer = screen.getByRole("button", { name: /Pizza/ });
    expect(answer).toBeDisabled();
    fireEvent.click(answer);
    expect(voteOnPoll).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(answer).toBeEnabled();
    expect(screen.queryByText(/Poll closed/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "End poll" })).toBeEnabled();
  });

  it("does not end a poll while a vote is pending", async () => {
    let finish!: () => void;
    voteOnPoll.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<PollMessage message={pollMessage()} roomId="!room:example.org" own />);
    fireEvent.click(screen.getByRole("button", { name: /Pizza/ }));
    expect(screen.getByRole("button", { name: "End poll" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "End poll" }));
    expect(endPoll).not.toHaveBeenCalled();
    await act(async () => finish());
  });
  it("renders forwarded read receipts", () => {
    render(
      <PollMessage
        message={pollMessage()}
        roomId="!room:example.org"
        own={false}
        rowActions={rowActions({
          readers: ["@bob:example.org"],
          senderNameByUserId: new Map([["@bob:example.org", "Bob"]]),
        })}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Seen by 1 people. Show full list." }),
    ).toBeInTheDocument();
  });

  it.each(["12h", "24h"] as const)("uses the selected %s clock", (clockFormat) => {
    displayFormats.clockFormat = clockFormat;
    const message = { ...pollMessage(), timestamp_ms: new Date(2026, 8, 4, 15, 5).getTime() };
    const { container } = render(
      <PollMessage message={message} roomId="!room:example.org" own={false} />,
    );
    expect(container.querySelector("time")).toHaveTextContent(
      new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
        hour12: clockFormat === "12h",
      }).format(message.timestamp_ms),
    );
  });

  it("does not replace multi-select votes with single answers", () => {
    render(
      <PollMessage
        message={pollMessage({ max_selections: 2 })}
        roomId="!room:example.org"
        own={false}
      />,
    );
    const answer = screen.getByRole("button", { name: /Pizza/ });
    expect(answer).toBeDisabled();
    fireEvent.click(answer);
    expect(voteOnPoll).not.toHaveBeenCalled();
    expect(screen.getByText(/Voting on multi-select polls is not supported/)).toBeInTheDocument();
  });
  it("renders disclosed tallies and sends a replacement vote", async () => {
    render(<PollMessage message={pollMessage()} roomId="!room:example.org" own={false} />);

    expect(screen.getByText("2 · 67%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Pizza/ }));

    await waitFor(() => expect(voteOnPoll).toHaveBeenCalledWith("!room:example.org", "$poll", "0"));
  });

  it("hides undisclosed results until the poll closes", () => {
    render(
      <PollMessage
        message={pollMessage({ kind: "undisclosed" })}
        roomId="!room:example.org"
        own={false}
      />,
    );

    expect(screen.getByText("Results hidden until the poll closes")).toBeInTheDocument();
    expect(screen.queryByText("2 · 67%")).not.toBeInTheDocument();
    expect(screen.getByText("Selected")).toBeInTheDocument();
  });

  it("marks edited poll content without offering unsupported message actions", async () => {
    render(
      <PollMessage
        message={pollMessage({ edited: true })}
        roomId="!room:example.org"
        own
        rowActions={rowActions({ onForward: vi.fn(), onViewEditHistory: vi.fn() })}
      />,
    );

    expect(screen.getByText("(edited)")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    expect(await screen.findByText("Copy")).toBeInTheDocument();
    expect(screen.queryByText("Reply")).not.toBeInTheDocument();
    expect(screen.queryByText("Forward")).not.toBeInTheDocument();
    expect(screen.queryByText("Edit history")).not.toBeInTheDocument();
  });

  it("lets the poll creator end an open poll", async () => {
    render(<PollMessage message={pollMessage()} roomId="!room:example.org" own />);
    fireEvent.click(screen.getByRole("button", { name: "End poll" }));

    await waitFor(() => expect(endPoll).toHaveBeenCalledWith("!room:example.org", "$poll"));
  });

  it("lets a moderator end another user's poll", async () => {
    render(
      <PollMessage
        message={pollMessage()}
        roomId="!room:example.org"
        own={false}
        rowActions={rowActions({ canRedact: true })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "End poll" }));

    await waitFor(() => expect(endPoll).toHaveBeenCalledWith("!room:example.org", "$poll"));
  });
});
