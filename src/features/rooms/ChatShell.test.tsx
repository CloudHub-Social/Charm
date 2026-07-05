import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { forwardRef, useImperativeHandle, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatShell } from "./ChatShell";
import type {
  ReactionToggleResult,
  ReceiptUpdate,
  RoomMessageSummary,
  RoomSummary,
  RoomTimelineUpdate,
  SendQueueUpdateEvent,
  TypingUpdate,
} from "@/lib/matrix";
import { makeRoomSummary } from "./testFixtures";

// ChatShell talks to Tauri IPC the moment it mounts (get_timeline_page,
// timeline:update / send_queue:update / receipts:update / typing:update /
// upload:progress listeners, mark_room_read) — mock lib/matrix entirely so
// the test exercises only the component, not a real Tauri backend.
const getTimelinePage = vi.fn();
const sendMessage = vi.fn().mockResolvedValue("txn-1");
const sendReply = vi.fn().mockResolvedValue("txn-1");
const editMessage = vi.fn().mockResolvedValue(undefined);
const redactEvent = vi.fn().mockResolvedValue(undefined);
const toggleReaction = vi.fn<(...args: unknown[]) => Promise<ReactionToggleResult>>();
const canRedact = vi.fn().mockResolvedValue(true);
const markRoomRead = vi.fn().mockResolvedValue(undefined);
const sendTyping = vi.fn().mockResolvedValue(undefined);
const sendAttachment = vi.fn().mockResolvedValue(undefined);
const openFileDialog = vi.fn();
const getRoomMembers = vi.fn().mockResolvedValue([]);
const listRooms = vi.fn().mockResolvedValue([]);
const runCommand = vi.fn().mockResolvedValue({ status: "success" });

let timelineUpdateCallback: ((update: RoomTimelineUpdate) => void) | undefined;
let sendQueueUpdateCallback: ((update: SendQueueUpdateEvent) => void) | undefined;
let receiptsCallback: ((update: ReceiptUpdate) => void) | undefined;
let typingCallback: ((update: TypingUpdate) => void) | undefined;
let uploadProgressCallback:
  | ((progress: { txn_id: string; room_id: string; sent: number; total: number }) => void)
  | undefined;

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openFileDialog(...args),
}));

vi.mock("@/lib/matrix", () => ({
  getTimelinePage: (...args: unknown[]) => getTimelinePage(...args),
  sendMessage: (...args: unknown[]) => sendMessage(...args),
  sendReply: (...args: unknown[]) => sendReply(...args),
  editMessage: (...args: unknown[]) => editMessage(...args),
  redactEvent: (...args: unknown[]) => redactEvent(...args),
  toggleReaction: (...args: unknown[]) => toggleReaction(...args),
  canRedact: (...args: unknown[]) => canRedact(...args),
  markRoomRead: (...args: unknown[]) => markRoomRead(...args),
  sendTyping: (...args: unknown[]) => sendTyping(...args),
  sendAttachment: (...args: unknown[]) => sendAttachment(...args),
  getRoomMembers: (...args: unknown[]) => getRoomMembers(...args),
  listRooms: (...args: unknown[]) => listRooms(...args),
  runCommand: (...args: unknown[]) => runCommand(...args),
  onTimelineUpdate: vi.fn((callback: (update: RoomTimelineUpdate) => void) => {
    timelineUpdateCallback = callback;
    return Promise.resolve(() => {});
  }),
  onSendQueueUpdate: vi.fn((callback: (update: SendQueueUpdateEvent) => void) => {
    sendQueueUpdateCallback = callback;
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
  onUploadProgress: vi.fn((callback: typeof uploadProgressCallback) => {
    uploadProgressCallback = callback;
    return Promise.resolve(() => {});
  }),
}));

// Composer's own rich-text/TipTap behavior (formatting, autocomplete,
// keybinding) is unit-tested directly in composerSerialize.test.ts /
// composerSuggestions.test.ts / composerKeybinding.test.ts — driving a real
// ProseMirror editor through jsdom here would test TipTap, not ChatShell's
// own send/echo/reconciliation logic. This fake keeps the same
// props contract (placeholder, onSubmit, onSlashCommand, submit() via ref).
vi.mock("./Composer", () => ({
  Composer: forwardRef(function Composer(
    props: {
      placeholder: string;
      onSubmit: (content: {
        body: string;
        formattedBody: string | null;
        mentions: string[] | null;
      }) => void;
      onSlashCommand: (parsed: { command: string; args: string[] }) => void;
    },
    ref,
  ) {
    const [value, setValue] = useState("");
    const commit = () => {
      const trimmed = value.trim();
      if (!trimmed) return;
      if (trimmed.startsWith("/")) {
        const [word, ...rest] = trimmed.slice(1).split(/\s+/);
        props.onSlashCommand({ command: word, args: rest });
      } else {
        props.onSubmit({ body: trimmed, formattedBody: null, mentions: null });
      }
      setValue("");
    };
    useImperativeHandle(ref, () => ({ submit: commit }));
    return (
      <textarea
        aria-label={props.placeholder}
        placeholder={props.placeholder}
        value={value}
        onChange={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            commit();
          }
        }}
      />
    );
  }),
}));

const room: RoomSummary = makeRoomSummary();

/** Minimal-but-complete `RoomMessageSummary` for tests that don't care about
 * edit/reaction/reply/send-state/media fields — fills them with inert defaults. */
function summary(
  overrides: Partial<RoomMessageSummary> & Pick<RoomMessageSummary, "event_id" | "sender" | "body">,
): RoomMessageSummary {
  return {
    formatted_body: null,
    timestamp_ms: 1,
    edited: false,
    redacted: false,
    reactions: [],
    in_reply_to: null,
    transaction_id: null,
    send_state: { state: "sent" },
    media: null,
    ...overrides,
  };
}

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
    markRoomRead.mockReset().mockResolvedValue(undefined);
    sendTyping.mockReset().mockResolvedValue(undefined);
    sendAttachment.mockReset().mockResolvedValue(undefined);
    openFileDialog.mockReset();
    timelineUpdateCallback = undefined;
    sendQueueUpdateCallback = undefined;
    receiptsCallback = undefined;
    typingCallback = undefined;
    uploadProgressCallback = undefined;
  });

  it("prompts to select a room when none is active", () => {
    render(<ChatShell room={null} currentUserId="@me:localhost" />);
    expect(screen.getByText("Select a room to start chatting")).toBeInTheDocument();
  });

  it("marks the room read once it becomes active", async () => {
    renderChatShell();
    await vi.waitFor(() => expect(markRoomRead).toHaveBeenCalledWith(room.room_id));
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

    const realMessage = summary({
      event_id: "$real:localhost",
      sender: "@me:localhost",
      body: "hello",
      timestamp_ms: Date.now(),
      transaction_id: "txn-1",
      send_state: { state: "sent" },
    });
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
        summary({
          event_id: "$msg:localhost",
          sender: "@alice:localhost",
          body: "hi",
          timestamp_ms: Date.now(),
          reactions: [{ key: "👍", count: 1, reacted_by_me: false }],
        }),
      ],
      next_cursor: null,
    });
    renderChatShell();

    fireEvent.click(await screen.findByRole("button", { name: /👍/ }));

    expect(toggleReaction).toHaveBeenCalledWith(room.room_id, "$msg:localhost", "👍");
  });

  it("renders a read-receipt avatar under the message a user last read", async () => {
    renderChatShell();
    await vi.waitFor(() => expect(timelineUpdateCallback).toBeDefined());

    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({ event_id: "$a", sender: "@me:localhost", body: "hi", timestamp_ms: 1 }),
          summary({ event_id: "$b", sender: "@alice:localhost", body: "hey", timestamp_ms: 2 }),
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
    renderChatShell();
    await vi.waitFor(() => expect(timelineUpdateCallback).toBeDefined());

    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({ event_id: "$a", sender: "@me:localhost", body: "hi", timestamp_ms: 1 }),
        ],
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
    renderChatShell();
    await vi.waitFor(() => expect(typingCallback).toBeDefined());

    act(() => {
      typingCallback?.({ room_id: room.room_id, user_ids: ["@alice:localhost"] });
    });

    expect(await screen.findByText("@alice:localhost is typing…")).toBeInTheDocument();
  });

  it("pluralizes the typing row for two other users", async () => {
    renderChatShell();
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
    renderChatShell();
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
    renderChatShell();
    await vi.waitFor(() => expect(typingCallback).toBeDefined());

    act(() => {
      typingCallback?.({ room_id: room.room_id, user_ids: ["@me:localhost"] });
    });

    expect(screen.queryByText(/is typing/)).not.toBeInTheDocument();
  });

  it("allows deleting an own message without waiting on the async can_redact resolution", async () => {
    // canRedact is only ever queried for *other* senders' messages — an own
    // message must be immediately deletable, not flash hidden until this
    // (never-resolving, here) promise settles.
    canRedact.mockImplementation(() => new Promise(() => {}));
    getTimelinePage.mockResolvedValue({
      messages: [summary({ event_id: "$mine", sender: "@me:localhost", body: "hi" })],
      next_cursor: null,
    });
    renderChatShell();

    fireEvent.pointerDown(await screen.findByRole("button", { name: "More actions" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });

    expect(await screen.findByText("Delete")).toBeInTheDocument();
  });

  it("stops showing a reply's quote preview once that reply message is itself redacted", async () => {
    renderChatShell();
    await vi.waitFor(() => expect(timelineUpdateCallback).toBeDefined());

    const replyRef = { event_id: "$original", sender: "@me:localhost", preview: "the original" };

    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({
            event_id: "$reply",
            sender: "@alice:localhost",
            body: "hi back",
            in_reply_to: replyRef,
            redacted: false,
          }),
        ],
      });
    });

    // The quote block renders the replied-to sender's name.
    expect(await screen.findByText("@me:localhost")).toBeInTheDocument();

    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({
            event_id: "$reply",
            sender: "@alice:localhost",
            body: "",
            in_reply_to: replyRef,
            redacted: true,
          }),
        ],
      });
    });

    expect(await screen.findByText("Message deleted")).toBeInTheDocument();
    expect(screen.queryByText("@me:localhost")).not.toBeInTheDocument();
  });

  it("keeps relation actions disabled for a sent message that still has a transaction-id echo", async () => {
    // send_state can flip to "sent" before the corresponding timeline:update
    // replaces the echo's transaction-id event_id with the real one — the
    // action menu must key off having a real ($-prefixed) event id, not
    // just off send_state.
    getTimelinePage.mockResolvedValue({
      messages: [
        summary({
          event_id: "txn-1",
          sender: "@me:localhost",
          body: "hi",
          transaction_id: "txn-1",
          send_state: { state: "sent" },
        }),
      ],
      next_cursor: null,
    });
    renderChatShell();

    fireEvent.pointerDown(await screen.findByRole("button", { name: "More actions" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    const reply = (await screen.findByText("Reply")).closest('[role="menuitem"]');
    expect(reply).toHaveAttribute("data-disabled");
  });

  it("opens the action menu on a long-press anywhere on the message row, not just its trigger buttons", async () => {
    getTimelinePage.mockResolvedValue({
      messages: [summary({ event_id: "$msg", sender: "@alice:localhost", body: "hi" })],
      next_cursor: null,
    });
    renderChatShell();

    const row = (await screen.findByText("hi")).closest(".group");
    expect(row).toBeTruthy();

    vi.useFakeTimers();
    fireEvent.touchStart(row!);
    vi.advanceTimersByTime(500);
    vi.useRealTimers();

    expect(await screen.findByText("Reply")).toBeInTheDocument();
  });

  it("ignores a stale can_redact response for a room the user has since navigated away from", async () => {
    const roomB: RoomSummary = makeRoomSummary({ room_id: "!roomB:localhost", name: "Room B" });
    let resolveRoomACheck: ((allowed: boolean) => void) | undefined;
    let calls = 0;
    canRedact.mockImplementation(
      () =>
        new Promise((resolve) => {
          // Only capture the *first* call's resolver (room A's) — room B's
          // own call should be left permanently pending in this test so its
          // Delete affordance can only appear if (incorrectly) fed by room
          // A's late response.
          if (calls === 0) resolveRoomACheck = resolve;
          calls += 1;
        }),
    );
    getTimelinePage
      .mockResolvedValueOnce({
        messages: [summary({ event_id: "$a", sender: "@alice:localhost", body: "in room A" })],
        next_cursor: null,
      })
      .mockResolvedValueOnce({
        messages: [summary({ event_id: "$b", sender: "@alice:localhost", body: "in room B" })],
        next_cursor: null,
      });

    const store = createStore();
    const { rerender } = render(
      <JotaiProvider store={store}>
        <ChatShell room={room} currentUserId="@me:localhost" />
      </JotaiProvider>,
    );
    await screen.findByText("in room A");
    await vi.waitFor(() =>
      expect(canRedact).toHaveBeenCalledWith(room.room_id, "@alice:localhost"),
    );

    // Navigate to room B before room A's canRedact call resolves.
    rerender(
      <JotaiProvider store={store}>
        <ChatShell room={roomB} currentUserId="@me:localhost" />
      </JotaiProvider>,
    );
    await screen.findByText("in room B");

    // Room A's (stale) response arrives late, saying @alice can be
    // redacted there — it must not leak into room B's state for the same
    // sender.
    resolveRoomACheck?.(true);
    await Promise.resolve();

    fireEvent.pointerDown(await screen.findByRole("button", { name: "More actions" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    // canRedact was only ever mocked to resolve for room A's call; room B's
    // own call is still pending (never resolved in this test), so Delete
    // must not be shown yet.
    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
  });

  it("enables the attach button and opens the file dialog on click", async () => {
    openFileDialog.mockResolvedValue("/Users/me/cat.png");
    renderChatShell();

    const attachButton = await screen.findByRole("button", { name: "Attach" });
    expect(attachButton).not.toBeDisabled();

    fireEvent.click(attachButton);

    await waitFor(() =>
      expect(sendAttachment).toHaveBeenCalledWith(
        room.room_id,
        "/Users/me/cat.png",
        expect.any(String),
      ),
    );
  });

  it("shows an upload progress bar that reacts to upload:progress and clears on completion", async () => {
    sendAttachment.mockImplementation(() => new Promise(() => {})); // never resolves during this test
    openFileDialog.mockResolvedValue("/Users/me/video.mp4");

    // ChatShell's txn id is `local-${Date.now()}-${Math.random()...}` —
    // freeze both so the test can compute the exact id it generates and
    // drive the mocked upload:progress callback with a matching txn_id.
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    vi.spyOn(Math, "random").mockReturnValue(0.123456789);

    renderChatShell();

    fireEvent.click(await screen.findByRole("button", { name: "Attach" }));

    await waitFor(() => expect(screen.getByText("video.mp4")).toBeInTheDocument());

    const expectedTxnId = `local-1700000000000-${(0.123456789).toString(36).slice(2)}`;

    // Progress ticks in.
    act(() => {
      uploadProgressCallback?.({
        txn_id: expectedTxnId,
        room_id: room.room_id,
        sent: 50,
        total: 100,
      });
    });
    const progressBar = document.querySelector(".bg-primary.transition-\\[width\\]");
    await waitFor(() => expect(progressBar).toHaveStyle({ width: "50%" }));

    // Completion clears the row.
    act(() => {
      uploadProgressCallback?.({
        txn_id: expectedTxnId,
        room_id: room.room_id,
        sent: 100,
        total: 100,
      });
    });
    await waitFor(() => expect(screen.queryByText("video.mp4")).not.toBeInTheDocument());

    vi.restoreAllMocks();
  });

  it("lets a failed upload be dismissed instead of persisting indefinitely", async () => {
    sendAttachment.mockRejectedValue(new Error("network error"));
    openFileDialog.mockResolvedValue("/Users/me/broken.mp4");

    renderChatShell();

    fireEvent.click(await screen.findByRole("button", { name: "Attach" }));

    await waitFor(() => expect(screen.getByText("Upload failed")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Dismiss failed upload broken.mp4" }));

    await waitFor(() => expect(screen.queryByText("broken.mp4")).not.toBeInTheDocument());
  });

  it("dispatches the same upload path on paste-image-into-composer", async () => {
    renderChatShell();
    const textarea = await screen.findByPlaceholderText("Message general");

    const file = new File(["fake"], "pasted.png", { type: "image/png" });
    Object.defineProperty(file, "path", { value: "/Users/me/pasted.png" });

    fireEvent.paste(textarea, {
      clipboardData: { files: [file] },
    });

    await waitFor(() =>
      expect(sendAttachment).toHaveBeenCalledWith(
        room.room_id,
        "/Users/me/pasted.png",
        expect.any(String),
      ),
    );
  });
});
