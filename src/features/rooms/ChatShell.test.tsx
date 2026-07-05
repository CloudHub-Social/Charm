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
const sendMessage = vi.fn().mockResolvedValue("txn-1");
const sendReply = vi.fn().mockResolvedValue("txn-1");
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
    sendMessage.mockReset().mockResolvedValue("txn-1");
    sendReply.mockReset().mockResolvedValue("txn-1");
    toggleReaction.mockReset();
    timelineUpdateCallback = undefined;
    sendQueueUpdateCallback = undefined;
  });

  it("flips a bubble from pending to sent when a send_queue:update arrives", async () => {
    // Resolves with the SDK's transaction id (not a client placeholder) —
    // that's the id the optimistic echo is keyed on and what a real
    // `send_queue:update` would carry.
    sendMessage.mockResolvedValue("txn-1");
    renderChatShell();
    await screen.findByText("No messages yet");

    sendDraft("hello");

    expect(await screen.findByText(/sending…/)).toBeInTheDocument();
    expect(document.getElementById("message-txn-1")).toBeInTheDocument();

    sendQueueUpdateCallback?.({
      room_id: room.room_id,
      transaction_id: "txn-1",
      send_state: { state: "sent" },
    });

    expect(await screen.findByText("hello")).toBeInTheDocument();
    expect(screen.queryByText(/sending…/)).not.toBeInTheDocument();
  });

  it("flips a bubble from pending to error when a send_queue:update reports an error", async () => {
    sendMessage.mockResolvedValue("txn-1");
    renderChatShell();
    await screen.findByText("No messages yet");

    sendDraft("hello");
    await screen.findByText(/sending…/);

    sendQueueUpdateCallback?.({
      room_id: room.room_id,
      transaction_id: "txn-1",
      send_state: { state: "error", message: "network down" },
    });

    expect(await screen.findByText(/failed to send/)).toBeInTheDocument();
  });

  it("reconciles a local echo with the real event once the synced event carries the same transaction id", async () => {
    // Reproduces the real-world mismatch: the optimistic echo only knows the
    // SDK's transaction id ("txn-1", not a real event id yet), and the
    // synced event that eventually arrives has an entirely different real
    // `event_id` — the two only correlate via the matching
    // `transaction_id` (mirroring `unsigned.transaction_id` on the real
    // event). If the ids didn't agree, this would render two "hello"
    // bubbles and the echo would be stuck on "sending…" forever.
    sendMessage.mockResolvedValue("txn-1");
    renderChatShell();

    sendDraft("hello");
    await screen.findByText(/sending…/);
    expect(document.getElementById("message-txn-1")).toBeInTheDocument();

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
      transaction_id: "txn-1",
      send_state: { state: "sent" },
    };
    timelineUpdateCallback?.({ room_id: room.room_id, messages: [realMessage] });

    // Exactly one "hello" bubble remains — the real event replaced the echo
    // in place rather than being appended alongside it — and it reflects
    // the real event's sent state, not still "sending…".
    expect(await screen.findAllByText("hello")).toHaveLength(1);
    expect(screen.queryByText(/sending…/)).not.toBeInTheDocument();
    expect(document.getElementById("message-txn-1")).not.toBeInTheDocument();
    expect(document.getElementById("message-$real:localhost")).toBeInTheDocument();
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
