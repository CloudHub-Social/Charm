import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PollRecoveryTray } from "./PollRecoveryTray";

const getPendingPollRelations = vi.fn();
const retryPollVote = vi.fn();
const discardPollVote = vi.fn();

vi.mock("@/lib/matrix", () => ({
  getPendingPollRelations: (...args: unknown[]) => getPendingPollRelations(...args),
  retryPollVote: (...args: unknown[]) => retryPollVote(...args),
  discardPollVote: (...args: unknown[]) => discardPollVote(...args),
  retryPollEnd: vi.fn(),
  discardPollEnd: vi.fn(),
}));

describe("PollRecoveryTray", () => {
  beforeEach(() => {
    getPendingPollRelations.mockReset().mockResolvedValue([]);
    retryPollVote.mockReset().mockResolvedValue(true);
    discardPollVote.mockReset().mockResolvedValue(true);
  });

  it("recovers a failed vote whose poll target is not loaded", async () => {
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
    render(<PollRecoveryTray roomId="!room:example.org" loadedMessages={[]} />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(retryPollVote).toHaveBeenCalledWith("!room:example.org", "$unloaded-poll", "txn-vote"),
    );
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Poll send recovery" })).not.toBeInTheDocument(),
    );
  });

  it("leaves recovery to the loaded poll row when its target is visible", async () => {
    getPendingPollRelations.mockResolvedValue([
      {
        poll_event_id: "$loaded-poll",
        transaction_id: "txn-vote",
        kind: "vote",
        answer_id: "0",
        failed: true,
      },
    ]);
    render(
      <PollRecoveryTray
        roomId="!room:example.org"
        loadedMessages={[{ event_id: "$loaded-poll" }]}
      />,
    );

    await waitFor(() => expect(getPendingPollRelations).toHaveBeenCalledOnce());
    expect(screen.queryByRole("region", { name: "Poll send recovery" })).not.toBeInTheDocument();
  });
});
