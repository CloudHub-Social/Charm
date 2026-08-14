import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as MatrixModule from "@/lib/matrix";
import { PollMessage } from "./PollMessage";
import { makeMessageSummary } from "./testFixtures";
import type { MessageRowLayoutProps } from "./messageRowShared";

const voteOnPoll = vi.fn();
const endPoll = vi.fn();

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

  it("marks edited poll content and keeps edit history available", async () => {
    const onViewEditHistory = vi.fn();
    render(
      <PollMessage
        message={pollMessage({ edited: true })}
        roomId="!room:example.org"
        own
        rowActions={rowActions({ onViewEditHistory })}
      />,
    );

    expect(screen.getByText("(edited)")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByText("Edit history"));
    expect(onViewEditHistory).toHaveBeenCalledOnce();
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
