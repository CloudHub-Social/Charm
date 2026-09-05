import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as MatrixModule from "@/lib/matrix";
import { PollMessage, resetAcknowledgedPollClosesForTests } from "./PollMessage";
import { makeMessageSummary } from "./testFixtures";
import type { MessageRowLayoutProps } from "./messageRowShared";

const voteOnPoll = vi.fn();
const getPendingPollVote = vi.fn();
const retryPollVote = vi.fn();
const discardPollVote = vi.fn();
const endPoll = vi.fn();
const retryPollEnd = vi.fn();
const getPendingPollEnd = vi.fn();
const confirmPollEndSynced = vi.fn();
const discardPollEnd = vi.fn();
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
    getPendingPollVote: (...args: unknown[]) => getPendingPollVote(...args),
    retryPollVote: (...args: unknown[]) => retryPollVote(...args),
    discardPollVote: (...args: unknown[]) => discardPollVote(...args),
    endPoll: (...args: unknown[]) => endPoll(...args),
    retryPollEnd: (...args: unknown[]) => retryPollEnd(...args),
    getPendingPollEnd: (...args: unknown[]) => getPendingPollEnd(...args),
    confirmPollEndSynced: (...args: unknown[]) => confirmPollEndSynced(...args),
    discardPollEnd: (...args: unknown[]) => discardPollEnd(...args),
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
  resetAcknowledgedPollClosesForTests();
  voteOnPoll.mockReset().mockResolvedValue("txn-vote");
  getPendingPollVote.mockReset().mockResolvedValue(null);
  retryPollVote.mockReset().mockResolvedValue(true);
  discardPollVote.mockReset().mockResolvedValue(true);
  endPoll.mockReset().mockResolvedValue("txn-end");
  retryPollEnd.mockReset().mockResolvedValue(true);
  getPendingPollEnd.mockReset().mockResolvedValue(null);
  confirmPollEndSynced.mockReset().mockResolvedValue(undefined);
  discardPollEnd.mockReset().mockResolvedValue(true);
});

describe("PollMessage", () => {
  it("shows a failed local echo directly on the poll card", () => {
    render(
      <PollMessage
        message={pollMessage()}
        roomId="!room:example.org"
        own
        rowActions={rowActions({ isError: true })}
      />,
    );

    expect(screen.getByText("(failed to send)")).toBeInTheDocument();
  });

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
    let finish!: (transactionId: string) => void;
    endPoll.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<PollMessage message={pollMessage()} roomId="!room:example.org" own />);
    const endButton = screen.getByRole("button", { name: "End poll" });
    await waitFor(() => expect(endButton).toBeEnabled());
    fireEvent.click(endButton);
    const answer = screen.getByRole("button", { name: /Pizza/ });
    expect(answer).toBeDisabled();
    fireEvent.click(answer);
    expect(voteOnPoll).not.toHaveBeenCalled();
    await act(async () => finish("txn-end"));
    await waitFor(() => expect(screen.getByRole("button", { name: /Pizza/ })).toBeDisabled());
    expect(screen.queryByText(/Poll closed/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close queued" })).toBeDisabled();
    expect(retryPollEnd).not.toHaveBeenCalled();
    expect(endPoll).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: /Pizza/ })).toBeDisabled();
    view.rerender(
      <PollMessage message={pollMessage({ ended: true })} roomId="!room:example.org" own />,
    );
    await waitFor(() =>
      expect(confirmPollEndSynced).toHaveBeenCalledWith("!room:example.org", "$poll"),
    );
    expect(screen.getByText(/Poll closed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry closing poll" })).not.toBeInTheDocument();
  });

  it("restores a queued close after the poll row remounts", async () => {
    getPendingPollEnd.mockResolvedValueOnce({
      transaction_id: "txn-restored-end",
      failed: false,
    });
    render(<PollMessage message={pollMessage()} roomId="!restored-room:example.org" own />);

    expect(await screen.findByRole("button", { name: "Close queued" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Pizza/ })).toBeDisabled();
    expect(getPendingPollEnd).toHaveBeenCalledWith("!restored-room:example.org", "$poll");
  });

  it("does not restore creator-only close state for another user's poll", () => {
    render(<PollMessage message={pollMessage()} roomId="!other-room:example.org" own={false} />);

    expect(getPendingPollEnd).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Pizza/ })).toBeEnabled();
  });

  it("clears restored close state when another renderer discards it", async () => {
    getPendingPollEnd
      .mockResolvedValueOnce({ transaction_id: "txn-failed-end", failed: true })
      .mockResolvedValueOnce(null);
    const view = render(<PollMessage message={pollMessage()} roomId="!room:example.org" own />);
    expect(await screen.findByRole("button", { name: "Retry closing poll" })).toBeEnabled();

    view.rerender(
      <PollMessage message={pollMessage({ edited: true })} roomId="!room:example.org" own />,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "End poll" })).toBeEnabled());
    expect(screen.getByRole("button", { name: /Pizza/ })).toBeEnabled();
  });

  it("does not acknowledge a retry when another renderer already removed the close", async () => {
    getPendingPollEnd.mockResolvedValueOnce({
      transaction_id: "txn-removed-end",
      failed: true,
    });
    retryPollEnd.mockResolvedValueOnce(false);
    render(<PollMessage message={pollMessage()} roomId="!room:example.org" own />);
    const retry = await screen.findByRole("button", { name: "Retry closing poll" });

    fireEvent.click(retry);

    await waitFor(() =>
      expect(retryPollEnd).toHaveBeenCalledWith("!room:example.org", "$poll", "txn-removed-end"),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "End poll" })).toBeEnabled());
    expect(screen.getByRole("button", { name: /Pizza/ })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Close queued" })).not.toBeInTheDocument();
  });

  it("retains the admission lock after actually retrying a failed close", async () => {
    getPendingPollEnd.mockResolvedValueOnce({
      transaction_id: "txn-retried-end",
      failed: true,
    });
    render(<PollMessage message={pollMessage()} roomId="!room:example.org" own />);
    const retry = await screen.findByRole("button", { name: "Retry closing poll" });

    fireEvent.click(retry);

    await waitFor(() =>
      expect(retryPollEnd).toHaveBeenCalledWith("!room:example.org", "$poll", "txn-retried-end"),
    );
    expect(screen.getByRole("button", { name: "Close queued" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Pizza/ })).toBeDisabled();
  });

  it("discards a failed local close after another client ends the poll", async () => {
    getPendingPollEnd.mockResolvedValueOnce({
      transaction_id: "txn-failed-end",
      failed: true,
    });
    render(<PollMessage message={pollMessage({ ended: true })} roomId="!room:example.org" own />);

    await waitFor(() =>
      expect(discardPollEnd).toHaveBeenCalledWith(
        "!room:example.org",
        "$poll",
        "txn-failed-end",
      ),
    );
    expect(screen.getByText(/Poll closed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry closing poll" })).not.toBeInTheDocument();
  });

  it("does not retain a successful queued close after the timeline ended", async () => {
    getPendingPollEnd
      .mockResolvedValueOnce({ transaction_id: "txn-synced-end", failed: false })
      .mockResolvedValueOnce(null);
    const view = render(
      <PollMessage message={pollMessage({ ended: true })} roomId="!room:example.org" own />,
    );
    await waitFor(() => expect(getPendingPollEnd).toHaveBeenCalledOnce());
    view.unmount();

    render(<PollMessage message={pollMessage()} roomId="!room:example.org" own />);
    await waitFor(() => expect(screen.getByRole("button", { name: "End poll" })).toBeEnabled());
    expect(screen.queryByRole("button", { name: "Close queued" })).not.toBeInTheDocument();
  });

  it("preserves the end admission lock across a timeline refresh", async () => {
    let finish!: (transactionId: string) => void;
    endPoll.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<PollMessage message={pollMessage()} roomId="!room:example.org" own />);
    await waitFor(() => expect(screen.getByRole("button", { name: "End poll" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "End poll" }));

    view.rerender(
      <PollMessage message={pollMessage({ edited: true })} roomId="!room:example.org" own />,
    );

    expect(screen.getByRole("button", { name: /Pizza/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Ending…" })).toBeDisabled();
    await act(async () => finish("txn-end"));
  });

  it("offers to discard a queued close that fails after admission", async () => {
    getPendingPollEnd
      .mockResolvedValueOnce({ transaction_id: "txn-failed-end", failed: false })
      .mockResolvedValueOnce({ transaction_id: "txn-failed-end", failed: true });
    const view = render(<PollMessage message={pollMessage()} roomId="!room:example.org" own />);
    expect(await screen.findByRole("button", { name: "Close queued" })).toBeDisabled();

    view.rerender(
      <PollMessage message={pollMessage({ edited: true })} roomId="!room:example.org" own />,
    );

    const discard = await screen.findByRole("button", { name: "Discard failed close" });
    expect(screen.getByRole("button", { name: "Retry closing poll" })).toBeEnabled();
    fireEvent.click(discard);
    await waitFor(() =>
      expect(discardPollEnd).toHaveBeenCalledWith(
        "!room:example.org",
        "$poll",
        "txn-failed-end",
      ),
    );
  });

  it("reconciles a failed queued close when vote totals change", async () => {
    getPendingPollEnd
      .mockResolvedValueOnce({ transaction_id: "txn-failed-end", failed: false })
      .mockResolvedValueOnce({ transaction_id: "txn-failed-end", failed: true });
    const view = render(<PollMessage message={pollMessage()} roomId="!room:example.org" own />);
    expect(await screen.findByRole("button", { name: "Close queued" })).toBeDisabled();

    view.rerender(
      <PollMessage
        message={pollMessage({
          answers: [
            { id: "pizza", text: "Pizza", votes: 2, selected_by_me: false },
            { id: "salad", text: "Salad", votes: 0, selected_by_me: false },
          ],
        })}
        roomId="!room:example.org"
        own
      />,
    );

    expect(await screen.findByRole("button", { name: "Retry closing poll" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Discard failed close" })).toBeEnabled();
  });

  it("rechecks a queued close even when poll content is unchanged", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      getPendingPollEnd
        .mockResolvedValueOnce({ transaction_id: "txn-failed-end", failed: false })
        .mockResolvedValueOnce({ transaction_id: "txn-failed-end", failed: true });
      render(<PollMessage message={pollMessage()} roomId="!room:example.org" own />);
      expect(await screen.findByRole("button", { name: "Close queued" })).toBeDisabled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      expect(screen.getByRole("button", { name: "Retry closing poll" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Discard failed close" })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a locally acknowledged close locked until the timeline ends", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      getPendingPollEnd
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ transaction_id: "txn-acknowledged-end", failed: false });
      endPoll.mockResolvedValueOnce("txn-acknowledged-end");
      render(<PollMessage message={pollMessage()} roomId="!room:example.org" own />);
      await act(async () => {});
      fireEvent.click(screen.getByRole("button", { name: "End poll" }));
      await act(async () => {});

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      expect(screen.getByRole("button", { name: /Pizza/ })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Close queued" })).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an acknowledged close locked across a row remount", async () => {
    getPendingPollEnd
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ transaction_id: "txn-remounted-end", failed: false });
    endPoll.mockResolvedValueOnce("txn-remounted-end");
    const view = render(<PollMessage message={pollMessage()} roomId="!remount:example.org" own />);
    await waitFor(() => expect(screen.getByRole("button", { name: "End poll" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "End poll" }));
    await waitFor(() => expect(endPoll).toHaveBeenCalledOnce());
    view.unmount();

    render(<PollMessage message={pollMessage()} roomId="!remount:example.org" own />);

    expect(await screen.findByRole("button", { name: "Close queued" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Pizza/ })).toBeDisabled();
  });

  it("does not carry an acknowledged close into another account", async () => {
    getPendingPollEnd.mockResolvedValue(null);
    endPoll.mockResolvedValueOnce("txn-account-end");
    const firstAccount = rowActions({ currentUserId: "@alice:example.org" });
    const view = render(
      <PollMessage
        message={pollMessage()}
        roomId="!shared:example.org"
        own
        rowActions={firstAccount}
      />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "End poll" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "End poll" }));
    await waitFor(() => expect(endPoll).toHaveBeenCalledOnce());
    view.unmount();

    render(
      <PollMessage
        message={pollMessage()}
        roomId="!shared:example.org"
        own
        rowActions={rowActions({ currentUserId: "@bob:example.org" })}
      />,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "End poll" })).toBeEnabled());
  });

  it("blocks mutations while a queued close is being restored", async () => {
    let finish!: (pending: null) => void;
    getPendingPollEnd.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          finish = resolve;
        }),
    );
    render(<PollMessage message={pollMessage()} roomId="!cold-room:example.org" own />);

    expect(screen.getByRole("button", { name: /Pizza/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "End poll" })).toBeDisabled();
    await act(async () => finish(null));
    expect(screen.getByRole("button", { name: /Pizza/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: "End poll" })).toBeEnabled();
  });

  it("restores and retries an asynchronously failed vote", async () => {
    getPendingPollVote
      .mockResolvedValueOnce({ transaction_id: "txn-failed-vote", answer_id: "0", failed: true })
      .mockResolvedValue(null);
    render(<PollMessage message={pollMessage()} roomId="!room:example.org" own={false} />);

    const retry = await screen.findByRole("button", { name: "Retry vote" });
    expect(screen.getByRole("button", { name: /Pizza/ })).toBeDisabled();
    fireEvent.click(retry);

    await waitFor(() =>
      expect(retryPollVote).toHaveBeenCalledWith(
        "!room:example.org",
        "$poll",
        "txn-failed-vote",
      ),
    );
  });

  it("discards an asynchronously failed vote through the poll lock", async () => {
    getPendingPollVote.mockResolvedValueOnce({
      transaction_id: "txn-failed-vote",
      answer_id: "1",
      failed: true,
    });
    render(<PollMessage message={pollMessage()} roomId="!room:example.org" own={false} />);

    fireEvent.click(await screen.findByRole("button", { name: "Discard vote" }));

    await waitFor(() =>
      expect(discardPollVote).toHaveBeenCalledWith(
        "!room:example.org",
        "$poll",
        "txn-failed-vote",
      ),
    );
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
    const answer = screen.getByRole("button", { name: /Pizza/ });
    await waitFor(() => expect(answer).toBeEnabled());
    fireEvent.click(answer);
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
    const answer = screen.getByRole("button", { name: /Pizza/ });
    await waitFor(() => expect(answer).toBeEnabled());
    fireEvent.click(answer);

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
    const endButton = screen.getByRole("button", { name: "End poll" });
    await waitFor(() => expect(endButton).toBeEnabled());
    fireEvent.click(endButton);

    await waitFor(() => expect(endPoll).toHaveBeenCalledWith("!room:example.org", "$poll"));
  });

  it("does not let a moderator end another user's poll", () => {
    render(
      <PollMessage
        message={pollMessage()}
        roomId="!room:example.org"
        own={false}
        rowActions={rowActions({ canRedact: true })}
      />,
    );
    expect(screen.queryByRole("button", { name: "End poll" })).not.toBeInTheDocument();
    expect(endPoll).not.toHaveBeenCalled();
  });
});
