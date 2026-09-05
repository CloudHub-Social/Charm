import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PollRecoveryTray } from "./PollRecoveryTray";

const getPendingPollRelations = vi.fn();
const discardPollVote = vi.fn();

vi.mock("@/lib/matrix", () => ({
  getPendingPollRelations: (...args: unknown[]) => getPendingPollRelations(...args),
  discardPollVote: (...args: unknown[]) => discardPollVote(...args),
  discardPollEnd: vi.fn(),
}));

describe("PollRecoveryTray", () => {
  beforeEach(() => {
    getPendingPollRelations.mockReset().mockResolvedValue([]);
    discardPollVote.mockReset().mockResolvedValue(true);
  });

  it("offers only discard when a failed vote's target is not loaded", async () => {
    getPendingPollRelations
      .mockResolvedValueOnce([
        {
          poll_event_id: "$unloaded-poll",
          transaction_id: "txn-vote",
          kind: "vote",
          answer_id: "0",
          failed: true,
        },
      ])
      .mockResolvedValue([]);
    render(<PollRecoveryTray roomId="!room:example.org" />);

    expect(await screen.findByRole("button", { name: "Discard" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    await waitFor(() =>
      expect(discardPollVote).toHaveBeenCalledWith(
        "!room:example.org",
        "$unloaded-poll",
        "txn-vote",
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Poll send recovery" })).not.toBeInTheDocument(),
    );
  });

  it("keeps recovery available when its poll row may be virtualized", async () => {
    getPendingPollRelations.mockResolvedValue([
      {
        poll_event_id: "$loaded-poll",
        transaction_id: "txn-vote",
        kind: "vote",
        answer_id: "0",
        failed: true,
      },
    ]);
    render(<PollRecoveryTray roomId="!room:example.org" />);

    await waitFor(() => expect(getPendingPollRelations).toHaveBeenCalledOnce());
    expect(screen.getByRole("region", { name: "Poll send recovery" })).toBeInTheDocument();
  });
});
