import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PinnedMessagesPanel } from "./PinnedMessagesPanel";
import { makeRoomDetails } from "./testUtils";
import { renderWithProviders } from "@/test/renderWithProviders";
import type { PinnedMessageSummary } from "@/lib/matrix";

const getRoomDetails = vi.fn();
const getPinnedMessages = vi.fn();

vi.mock("@/lib/matrix", () => ({
  getRoomDetails: (...args: unknown[]) => getRoomDetails(...args),
  onRoomDetailsUpdate: vi.fn().mockResolvedValue(() => {}),
  getPinnedMessages: (...args: unknown[]) => getPinnedMessages(...args),
}));

function pinnedMessage(overrides: Partial<PinnedMessageSummary> = {}): PinnedMessageSummary {
  return {
    event_id: "$1",
    sender: "@alice:example.org",
    sender_display_name: "Alice",
    preview: "Read the room rules before posting",
    timestamp_ms: 1_700_000_000_000,
    is_redacted: false,
    is_undecrypted: false,
    ...overrides,
  };
}

describe("PinnedMessagesPanel", () => {
  it("lists resolved pinned messages in order and calls onClose", async () => {
    const details = makeRoomDetails({ pinned_event_ids: ["$1", "$2"] });
    getRoomDetails.mockResolvedValue(details);
    getPinnedMessages.mockResolvedValue([
      pinnedMessage({ event_id: "$1", preview: "read this first" }),
      pinnedMessage({ event_id: "$2", preview: "then this", sender_display_name: "Bob" }),
    ]);
    const onClose = vi.fn();

    renderWithProviders(
      <PinnedMessagesPanel
        roomId={details.room_id}
        onClose={onClose}
        onJumpToMessage={() => {}}
      />,
    );

    const items = await screen.findAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("read this first");
    expect(items[1]).toHaveTextContent("then this");

    screen.getByRole("button", { name: "Close pinned messages" }).click();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows an empty state when nothing is pinned", async () => {
    const details = makeRoomDetails({ pinned_event_ids: [] });
    getRoomDetails.mockResolvedValue(details);
    getPinnedMessages.mockResolvedValue([]);

    renderWithProviders(
      <PinnedMessagesPanel roomId={details.room_id} onClose={() => {}} onJumpToMessage={() => {}} />,
    );

    expect(await screen.findByText("No pinned messages yet.")).toBeInTheDocument();
  });

  it("shows an error message when the fetch fails", async () => {
    const details = makeRoomDetails({ pinned_event_ids: ["$1"] });
    getRoomDetails.mockResolvedValue(details);
    getPinnedMessages.mockRejectedValue(new Error("network error"));

    renderWithProviders(
      <PinnedMessagesPanel roomId={details.room_id} onClose={() => {}} onJumpToMessage={() => {}} />,
    );

    expect(await screen.findByText("Couldn't load pinned messages.")).toBeInTheDocument();
  });

  it("calls onJumpToMessage with the clicked message's event id", async () => {
    const details = makeRoomDetails({ pinned_event_ids: ["$1"] });
    getRoomDetails.mockResolvedValue(details);
    getPinnedMessages.mockResolvedValue([pinnedMessage({ event_id: "$1" })]);
    const onJumpToMessage = vi.fn();

    renderWithProviders(
      <PinnedMessagesPanel
        roomId={details.room_id}
        onClose={() => {}}
        onJumpToMessage={onJumpToMessage}
      />,
    );

    (await screen.findByText("Read the room rules before posting")).click();
    expect(onJumpToMessage).toHaveBeenCalledWith("$1");
  });

  it("renders a placeholder for a redacted pinned message instead of an empty body", async () => {
    const details = makeRoomDetails({ pinned_event_ids: ["$1"] });
    getRoomDetails.mockResolvedValue(details);
    getPinnedMessages.mockResolvedValue([
      pinnedMessage({ event_id: "$1", preview: "", is_redacted: true }),
    ]);

    renderWithProviders(
      <PinnedMessagesPanel roomId={details.room_id} onClose={() => {}} onJumpToMessage={() => {}} />,
    );

    expect(await screen.findByText("This message was deleted.")).toBeInTheDocument();
  });
});
