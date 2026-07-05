import { fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatShell } from "./ChatShell";
import type {
  ReactionToggleResult,
  RoomMessageSummary,
  RoomSummary,
  RoomTimelineUpdate,
  SendQueueUpdateEvent,
} from "@/lib/matrix";

// ChatShell talks to Tauri IPC the moment it mounts (get_timeline_page,
// timeline:update / send_queue:update listeners) — mock lib/matrix entirely
// so the test exercises only the component, not a real Tauri backend.
const getTimelinePage = vi.fn();
const sendMessage = vi.fn().mockResolvedValue(undefined);
const sendReply = vi.fn().mockResolvedValue(undefined);
const editMessage = vi.fn().mockResolvedValue(undefined);
const redactEvent = vi.fn().mockResolvedValue(undefined);
const toggleReaction = vi.fn<(...args: unknown[]) => Promise<ReactionToggleResult>>();
const canRedact = vi.fn().mockResolvedValue(true);

let timelineUpdateCallback: ((update: RoomTimelineUpdate) => void) | undefined;
let sendQueueUpdateCallback: ((update: SendQueueUpdateEvent) => void) | undefined;

vi.mock("@/lib/matrix", () => ({
  getTimelinePage: (...args: unknown[]) => getTimelinePage(...args),
  sendMessage: (...args: unknown[]) => sendMessage(...args),
  sendReply: (...args: unknown[]) => sendReply(...args),
  editMessage: (...args: unknown[]) => editMessage(...args),
  redactEvent: (...args: unknown[]) => redactEvent(...args),
  toggleReaction: (...args: unknown[]) => toggleReaction(...args),
  canRedact: (...args: unknown[]) => canRedact(...args),
  onTimelineUpdate: vi.fn((callback: (update: RoomTimelineUpdate) => void) => {
    timelineUpdateCallback = callback;
    return Promise.resolve(() => {});
  }),
  onSendQueueUpdate: vi.fn((callback: (update: SendQueueUpdateEvent) => void) => {
    sendQueueUpdateCallback = callback;
    return Promise.resolve(() => {});
  }),
}));

const room: RoomSummary = {
  room_id: "!abc123:localhost",
  name: "general",
  unread_count: 0,
};

function renderChatShell() {
  const store = createStore();
  return render(
    <JotaiProvider store={store}>
      <ChatShell room={room} currentUserId="@me:localhost" />
    </JotaiProvider>,
  );
}

function sendDraft(text: string) {
  const textarea = screen.getByPlaceholderText("Message general");
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
}

describe("ChatShell", () => {
  beforeEach(() => {
    getTimelinePage.mockReset().mockResolvedValue({ messages: [], next_cursor: null });
    sendMessage.mockReset().mockResolvedValue(undefined);
    sendReply.mockReset().mockResolvedValue(undefined);
    toggleReaction.mockReset();
    timelineUpdateCallback = undefined;
    sendQueueUpdateCallback = undefined;
  });

  it("flips a bubble from pending to sent when a send_queue:update arrives", async () => {
    sendMessage.mockImplementation(() => new Promise(() => {})); // never resolves on its own
    renderChatShell();
    await screen.findByText("No messages yet");

    sendDraft("hello");

    expect(await screen.findByText(/sending…/)).toBeInTheDocument();

    // The optimistic echo's transaction_id is `local-<timestamp>` — grab it
    // off the DOM id set by ChatShell rather than guessing the timestamp.
    const bubble = screen.getByText("hello").closest("[id^='message-local-']");
    const transactionId = bubble?.id.replace("message-", "");
    expect(transactionId).toBeTruthy();

    sendQueueUpdateCallback?.({
      room_id: room.room_id,
      transaction_id: transactionId!,
      send_state: { state: "sent" },
    });

    expect(await screen.findByText("hello")).toBeInTheDocument();
    expect(screen.queryByText(/sending…/)).not.toBeInTheDocument();
  });

  it("flips a bubble from pending to error when a send_queue:update reports an error", async () => {
    sendMessage.mockImplementation(() => new Promise(() => {}));
    renderChatShell();
    await screen.findByText("No messages yet");

    sendDraft("hello");
    await screen.findByText(/sending…/);

    const bubble = screen.getByText("hello").closest("[id^='message-local-']");
    const transactionId = bubble?.id.replace("message-", "");

    sendQueueUpdateCallback?.({
      room_id: room.room_id,
      transaction_id: transactionId!,
      send_state: { state: "error", message: "network down" },
    });

    expect(await screen.findByText(/failed to send/)).toBeInTheDocument();
  });

  it("reconciles a local echo with the real event from a timeline:update", async () => {
    sendMessage.mockResolvedValue(undefined);
    renderChatShell();

    sendDraft("hello");
    await screen.findByText("hello");

    const realMessage: RoomMessageSummary = {
      event_id: "$real:localhost",
      sender: "@me:localhost",
      body: "hello",
      formatted_body: null,
      timestamp_ms: Date.now(),
      edited: false,
      redacted: false,
      reactions: [],
      in_reply_to: null,
      transaction_id: null,
      send_state: { state: "sent" },
    };
    timelineUpdateCallback?.({ room_id: room.room_id, messages: [realMessage] });

    // Only one "hello" bubble should remain — no duplicate from the local echo.
    expect(await screen.findAllByText("hello")).toHaveLength(1);
  });

  it("clicking a reaction chip calls toggleReaction", async () => {
    toggleReaction.mockResolvedValue({ action: "added" });
    getTimelinePage.mockResolvedValue({
      messages: [
        {
          event_id: "$msg:localhost",
          sender: "@alice:localhost",
          body: "hi",
          formatted_body: null,
          timestamp_ms: Date.now(),
          edited: false,
          redacted: false,
          reactions: [{ key: "👍", count: 1, reacted_by_me: false }],
          in_reply_to: null,
          transaction_id: null,
          send_state: { state: "sent" },
        },
      ],
      next_cursor: null,
    });
    renderChatShell();

    fireEvent.click(await screen.findByRole("button", { name: /👍/ }));

    expect(toggleReaction).toHaveBeenCalledWith(room.room_id, "$msg:localhost", "👍");
  });
});
