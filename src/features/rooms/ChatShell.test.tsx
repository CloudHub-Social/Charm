import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatShell } from "./ChatShell";
import type { RoomMessageSummary, RoomSummary, ReceiptUpdate, TypingUpdate } from "@/lib/matrix";

// ChatShell talks to Tauri IPC the moment it mounts (get_timeline_page,
// timeline:update/receipts:update/typing:update listeners, mark_room_read) —
// mock lib/matrix entirely, same pattern as QrLoginScreen.test.tsx, so the
// test exercises only the component's own rendering/state.
let timelineCallback:
  | ((update: { room_id: string; messages: RoomMessageSummary[] }) => void)
  | undefined;
let receiptsCallback: ((update: ReceiptUpdate) => void) | undefined;
let typingCallback: ((update: TypingUpdate) => void) | undefined;

const markRoomRead = vi.fn().mockResolvedValue(undefined);
const sendTyping = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/matrix", () => ({
  getTimelinePage: vi.fn().mockResolvedValue({ messages: [] }),
  sendMessage: vi.fn().mockResolvedValue(undefined),
  markRoomRead: (...args: unknown[]) => markRoomRead(...args),
  sendTyping: (...args: unknown[]) => sendTyping(...args),
  onTimelineUpdate: vi.fn((callback: typeof timelineCallback) => {
    timelineCallback = callback;
    return Promise.resolve(() => {});
  }),
  onReceiptsUpdate: vi.fn((callback: (update: ReceiptUpdate) => void) => {
    receiptsCallback = callback;
    return Promise.resolve(() => {});
  }),
  onTypingUpdate: vi.fn((callback: (update: TypingUpdate) => void) => {
    typingCallback = callback;
    return Promise.resolve(() => {});
  }),
}));

const room: RoomSummary = {
  room_id: "!room:localhost",
  name: "general",
  unread_count: 0,
};

describe("ChatShell", () => {
  it("prompts to select a room when none is active", () => {
    render(<ChatShell room={null} currentUserId="@me:localhost" />);
    expect(screen.getByText("Select a room to start chatting")).toBeInTheDocument();
  });

  it("marks the room read once it becomes active", async () => {
    render(<ChatShell room={room} currentUserId="@me:localhost" />);
    await vi.waitFor(() => expect(markRoomRead).toHaveBeenCalledWith(room.room_id));
  });

  it("renders a read-receipt avatar under the message a user last read", async () => {
    render(<ChatShell room={room} currentUserId="@me:localhost" />);
    await vi.waitFor(() => expect(timelineCallback).toBeDefined());

    act(() => {
      timelineCallback?.({
        room_id: room.room_id,
        messages: [
          { event_id: "$a", sender: "@me:localhost", body: "hi", timestamp_ms: 1 },
          { event_id: "$b", sender: "@alice:localhost", body: "hey", timestamp_ms: 2 },
        ],
      });
    });
    await vi.waitFor(() => expect(receiptsCallback).toBeDefined());

    act(() => {
      receiptsCallback?.({
        room_id: room.room_id,
        receipts: [
          { event_id: "$b", user_id: "@alice:localhost", receipt_type: "read", ts_ms: 100 },
        ],
      });
    });

    await vi.waitFor(() => expect(screen.getAllByText("AL").length).toBeGreaterThan(1));
  });

  it("does not render a receipt avatar for the current user's own receipt", async () => {
    render(<ChatShell room={room} currentUserId="@me:localhost" />);
    await vi.waitFor(() => expect(timelineCallback).toBeDefined());

    act(() => {
      timelineCallback?.({
        room_id: room.room_id,
        messages: [{ event_id: "$a", sender: "@me:localhost", body: "hi", timestamp_ms: 1 }],
      });
    });
    await vi.waitFor(() => expect(receiptsCallback).toBeDefined());

    act(() => {
      receiptsCallback?.({
        room_id: room.room_id,
        receipts: [{ event_id: "$a", user_id: "@me:localhost", receipt_type: "read", ts_ms: 100 }],
      });
    });

    expect(screen.queryByText("ME")).not.toBeInTheDocument();
  });

  it("shows a singular typing row for one other user", async () => {
    render(<ChatShell room={room} currentUserId="@me:localhost" />);
    await vi.waitFor(() => expect(typingCallback).toBeDefined());

    act(() => {
      typingCallback?.({ room_id: room.room_id, user_ids: ["@alice:localhost"] });
    });

    expect(await screen.findByText("@alice:localhost is typing…")).toBeInTheDocument();
  });

  it("pluralizes the typing row for two other users", async () => {
    render(<ChatShell room={room} currentUserId="@me:localhost" />);
    await vi.waitFor(() => expect(typingCallback).toBeDefined());

    act(() => {
      typingCallback?.({
        room_id: room.room_id,
        user_ids: ["@alice:localhost", "@bob:localhost"],
      });
    });

    expect(
      await screen.findByText("@alice:localhost and @bob:localhost are typing…"),
    ).toBeInTheDocument();
  });

  it("summarizes three or more typing users", async () => {
    render(<ChatShell room={room} currentUserId="@me:localhost" />);
    await vi.waitFor(() => expect(typingCallback).toBeDefined());

    act(() => {
      typingCallback?.({
        room_id: room.room_id,
        user_ids: ["@alice:localhost", "@bob:localhost", "@carol:localhost"],
      });
    });

    expect(
      await screen.findByText("@alice:localhost, @bob:localhost, and 1 other are typing…"),
    ).toBeInTheDocument();
  });

  it("filters the current user out of the typing row", async () => {
    render(<ChatShell room={room} currentUserId="@me:localhost" />);
    await vi.waitFor(() => expect(typingCallback).toBeDefined());

    act(() => {
      typingCallback?.({ room_id: room.room_id, user_ids: ["@me:localhost"] });
    });

    expect(screen.queryByText(/is typing/)).not.toBeInTheDocument();
  });
});
