import { act, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PinnedMessagesPanel } from "./PinnedMessagesPanel";
import { makeRoomDetails } from "./testUtils";
import { renderWithProviders } from "@/test/renderWithProviders";
import type { PinnedMessageSummary, RoomTimelineUpdate } from "@/lib/matrix";

const getRoomDetails = vi.fn();
const getPinnedMessages = vi.fn();
const unpinEvent = vi.fn();
let timelineUpdateCallback: ((update: RoomTimelineUpdate) => void) | undefined;

vi.mock("@/lib/matrix", () => ({
  getRoomDetails: (...args: unknown[]) => getRoomDetails(...args),
  onRoomDetailsUpdate: vi.fn().mockResolvedValue(() => {}),
  getPinnedMessages: (...args: unknown[]) => getPinnedMessages(...args),
  unpinEvent: (...args: unknown[]) => unpinEvent(...args),
  onTimelineUpdate: vi.fn((callback: (update: RoomTimelineUpdate) => void) => {
    timelineUpdateCallback = callback;
    return Promise.resolve(() => {});
  }),
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
  beforeEach(() => {
    unpinEvent.mockReset().mockResolvedValue(undefined);
    timelineUpdateCallback = undefined;
  });

  it("lists resolved pinned messages in order and calls onClose", async () => {
    const details = makeRoomDetails({ pinned_event_ids: ["$1", "$2"] });
    getRoomDetails.mockResolvedValue(details);
    getPinnedMessages.mockResolvedValue([
      pinnedMessage({ event_id: "$1", preview: "read this first" }),
      pinnedMessage({ event_id: "$2", preview: "then this", sender_display_name: "Bob" }),
    ]);
    const onClose = vi.fn();

    renderWithProviders(
      <PinnedMessagesPanel roomId={details.room_id} onClose={onClose} onJumpToMessage={() => {}} />,
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
      <PinnedMessagesPanel
        roomId={details.room_id}
        onClose={() => {}}
        onJumpToMessage={() => {}}
      />,
    );

    expect(await screen.findByText("No pinned messages yet.")).toBeInTheDocument();
  });

  it("shows an error message when the fetch fails", async () => {
    const details = makeRoomDetails({ pinned_event_ids: ["$1"] });
    getRoomDetails.mockResolvedValue(details);
    getPinnedMessages.mockRejectedValue(new Error("network error"));

    renderWithProviders(
      <PinnedMessagesPanel
        roomId={details.room_id}
        onClose={() => {}}
        onJumpToMessage={() => {}}
      />,
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
      <PinnedMessagesPanel
        roomId={details.room_id}
        onClose={() => {}}
        onJumpToMessage={() => {}}
      />,
    );

    expect(await screen.findByText("This message was deleted.")).toBeInTheDocument();
  });

  it("refetches a pinned message's preview when a timeline:update touches it (Codex review fix)", async () => {
    // A pinned message being edited or redacted doesn't change the pinned
    // id list itself, so the query wouldn't otherwise refetch — see
    // `usePinnedMessages`'s own comment.
    const details = makeRoomDetails({ pinned_event_ids: ["$1"] });
    getRoomDetails.mockResolvedValue(details);
    // A plain stateful mock (not `mockResolvedValueOnce`) — `usePinnedMessages`'s
    // query key changes once from an empty `pinnedEventIds` (before
    // `getRoomDetails` resolves) to the real one, which would otherwise
    // consume a queued "once" value on that irrelevant intermediate fetch.
    let redacted = false;
    getPinnedMessages.mockImplementation(() =>
      Promise.resolve([
        redacted
          ? pinnedMessage({ event_id: "$1", is_redacted: true, preview: "" })
          : pinnedMessage({ event_id: "$1", preview: "original" }),
      ]),
    );

    renderWithProviders(
      <PinnedMessagesPanel
        roomId={details.room_id}
        onClose={() => {}}
        onJumpToMessage={() => {}}
      />,
    );
    await screen.findByText("original");
    expect(timelineUpdateCallback).toBeDefined();
    redacted = true;

    act(() => {
      timelineUpdateCallback?.({
        room_id: details.room_id,
        messages: [{ event_id: "$1" } as never],
      });
    });

    expect(await screen.findByText("This message was deleted.")).toBeInTheDocument();
  });

  it("shows an unpin action for a redacted pinned message the user has permission to unpin (Codex review fix)", async () => {
    // MessageActions' own Pin/Unpin entry is unreachable for a redacted
    // message (every timeline row wraps it in `!message.redacted`), so a
    // pinned-then-deleted message would otherwise have no way to ever be
    // unpinned from Charm.
    const details = makeRoomDetails({ pinned_event_ids: ["$1"] });
    getRoomDetails.mockResolvedValue(details);
    getPinnedMessages.mockResolvedValue([
      pinnedMessage({ event_id: "$1", preview: "", is_redacted: true }),
    ]);

    renderWithProviders(
      <PinnedMessagesPanel
        roomId={details.room_id}
        onClose={() => {}}
        onJumpToMessage={() => {}}
      />,
    );
    await screen.findByText("This message was deleted.");

    screen.getByRole("button", { name: "Unpin message" }).click();

    await waitFor(() => expect(unpinEvent).toHaveBeenCalledWith(details.room_id, "$1"));
  });

  it("does not show an unpin action for a redacted pinned message without permission", async () => {
    const details = makeRoomDetails({
      pinned_event_ids: ["$1"],
      can: { ...makeRoomDetails().can, set_pinned_events: false },
    });
    getRoomDetails.mockResolvedValue(details);
    getPinnedMessages.mockResolvedValue([
      pinnedMessage({ event_id: "$1", preview: "", is_redacted: true }),
    ]);

    renderWithProviders(
      <PinnedMessagesPanel
        roomId={details.room_id}
        onClose={() => {}}
        onJumpToMessage={() => {}}
      />,
    );
    await screen.findByText("This message was deleted.");

    expect(screen.queryByRole("button", { name: "Unpin message" })).not.toBeInTheDocument();
  });
});
