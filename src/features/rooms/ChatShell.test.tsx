import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { forwardRef, useImperativeHandle, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatShell } from "./ChatShell";
import type {
  ReactionToggleResult,
  ReceiptUpdate,
  RoomMessageSummary,
  RoomSummary,
  RoomTimelineUpdate,
  TypingUpdate,
} from "@/lib/matrix";
import { makeRoomSummary } from "./testFixtures";
import { roomSettingsAtom } from "@/features/room-info/roomInfoAtoms";
import { TYPING_AUTO_HIDE_MS } from "./useChatTyping";

// ChatShell talks to Tauri IPC the moment it mounts (get_timeline_page,
// timeline:update / receipts:update / typing:update / upload:progress
// listeners, mark_room_read) — mock lib/matrix entirely so the test
// exercises only the component, not a real Tauri backend. Local-echo
// pending/sent/error transitions now arrive purely via `timeline:update`
// (the room's live `Timeline`, not a client-side echo) — see the tests
// below that drive `timelineUpdateCallback` directly for that.
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
const openUrl = vi.fn().mockResolvedValue(undefined);

let timelineUpdateCallback: ((update: RoomTimelineUpdate) => void) | undefined;
let receiptsCallback: ((update: ReceiptUpdate) => void) | undefined;
let typingCallback: ((update: TypingUpdate) => void) | undefined;
let uploadProgressCallback:
  | ((progress: { txn_id: string; room_id: string; sent: number; total: number }) => void)
  | undefined;

// Scroll-anchoring (Spec 26) is driven off two IntersectionObservers in
// `useChatTimeline.ts`: the bottom sentinel (also Spec 05's mark-as-read
// signal, constructed with `{ threshold: 1 }`) and the top sentinel that
// triggers backward-pagination (constructed with a `rootMargin`, no
// `threshold`). `src/test/setup.ts`'s global stub never invokes its
// callback, so tests that need to simulate "the user is/isn't scrolled to
// bottom/top" install this one instead, which records each constructor's
// callback — keyed by that same `threshold` distinction — for tests to fire
// directly.
let bottomIntersectionCallback: IntersectionObserverCallback | undefined;
let topIntersectionCallback: IntersectionObserverCallback | undefined;

class FakeIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds: ReadonlyArray<number>;
  constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) {
    if (options.threshold === 1) {
      bottomIntersectionCallback = callback;
    } else {
      topIntersectionCallback = callback;
    }
    const threshold = options.threshold ?? 0;
    this.thresholds = Array.isArray(threshold) ? threshold : [threshold];
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

let scrollIntoViewMock: ReturnType<typeof vi.fn<Element["scrollIntoView"]>>;

function fireBottomIntersection(isIntersecting: boolean) {
  act(() => {
    bottomIntersectionCallback?.(
      [{ isIntersecting } as IntersectionObserverEntry],
      undefined as unknown as IntersectionObserver,
    );
  });
}

function fireTopIntersection(isIntersecting: boolean) {
  act(() => {
    topIntersectionCallback?.(
      [{ isIntersecting } as IntersectionObserverEntry],
      undefined as unknown as IntersectionObserver,
    );
  });
}

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openFileDialog(...args),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => openUrl(...args),
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
  onRoomDetailsUpdate: vi.fn(() => Promise.resolve(() => {})),
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
      onEmptyChange?: (isEmpty: boolean) => void;
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
      props.onEmptyChange?.(true);
    };
    useImperativeHandle(ref, () => ({ submit: commit }));
    return (
      <textarea
        aria-label={props.placeholder}
        placeholder={props.placeholder}
        value={value}
        onChange={(e) => {
          const next = e.currentTarget.value;
          setValue(next);
          props.onEmptyChange?.(next.trim().length === 0);
        }}
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
    sender_display_name: null,
    sender_avatar_url: null,
    sender_avatar_path: null,
    formatted_body: null,
    timestamp_ms: 1,
    edited: false,
    redacted: false,
    reactions: [],
    in_reply_to: null,
    transaction_id: null,
    send_state: { state: "sent" },
    media: null,
    is_undecrypted: false,
    ...overrides,
  };
}

function renderChatShell(store = createStore()) {
  return {
    store,
    ...render(
      <JotaiProvider store={store}>
        <ChatShell room={room} currentUserId="@me:localhost" />
      </JotaiProvider>,
    ),
  };
}

function sendDraft(text: string) {
  const textarea = screen.getByPlaceholderText("Message general");
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
}

describe("ChatShell", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    getTimelinePage.mockReset().mockResolvedValue({ messages: [], next_cursor: null });
    sendMessage.mockReset().mockResolvedValue("txn-1");
    sendReply.mockReset().mockResolvedValue("txn-1");
    toggleReaction.mockReset();
    markRoomRead.mockReset().mockResolvedValue(undefined);
    sendTyping.mockReset().mockResolvedValue(undefined);
    sendAttachment.mockReset().mockResolvedValue(undefined);
    openFileDialog.mockReset();
    openUrl.mockReset().mockResolvedValue(undefined);
    timelineUpdateCallback = undefined;
    receiptsCallback = undefined;
    typingCallback = undefined;
    uploadProgressCallback = undefined;
    bottomIntersectionCallback = undefined;
    topIntersectionCallback = undefined;
    globalThis.IntersectionObserver =
      FakeIntersectionObserver as unknown as typeof IntersectionObserver;
    // jsdom doesn't implement `scrollIntoView` at all (useChatTimeline.ts
    // guards the call with `?.()` for exactly this reason).
    scrollIntoViewMock = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoViewMock;
  });

  it("prompts to select a room when none is active", () => {
    render(<ChatShell room={null} currentUserId="@me:localhost" />);
    expect(screen.getByText("Select a room to start chatting")).toBeInTheDocument();
  });

  it("disables Send while the composer is empty, and enables it once text is typed", async () => {
    renderChatShell();
    await screen.findByText("No messages yet");
    const sendButton = screen.getByRole("button", { name: "Send" });
    expect(sendButton).toBeDisabled();

    const composer = screen.getByPlaceholderText(`Message ${room.name}`);
    fireEvent.change(composer, { target: { value: "hello" } });
    expect(sendButton).not.toBeDisabled();

    fireEvent.change(composer, { target: { value: "   " } });
    expect(sendButton).toBeDisabled();
  });

  it("disables Send again after a message is sent, clearing the composer", async () => {
    renderChatShell();
    await screen.findByText("No messages yet");
    const sendButton = screen.getByRole("button", { name: "Send" });
    const composer = screen.getByPlaceholderText(`Message ${room.name}`);

    fireEvent.change(composer, { target: { value: "hello" } });
    expect(sendButton).not.toBeDisabled();

    fireEvent.click(sendButton);
    expect(sendButton).toBeDisabled();
  });

  it("marks the room read once it becomes active", async () => {
    renderChatShell();
    await vi.waitFor(() => expect(markRoomRead).toHaveBeenCalledWith(room.room_id));
  });

  it("scrolls to the bottom once the initial page of messages renders", async () => {
    getTimelinePage.mockResolvedValue({
      messages: [
        summary({ event_id: "$a", sender: "@alice:localhost", body: "hi", timestamp_ms: 1 }),
      ],
      next_cursor: null,
    });
    renderChatShell();

    await screen.findByText("hi");
    await vi.waitFor(() => expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: "end" }));
  });

  it("keeps the view pinned to bottom when a live message arrives while already at bottom", async () => {
    // The bottom-sentinel observer (which `fireBottomIntersection` drives)
    // only mounts once there's a `latestEventId` to observe for — start with
    // a non-empty timeline so it's actually wired up before asserting on it.
    getTimelinePage.mockResolvedValue({
      messages: [
        summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
      ],
      next_cursor: null,
    });
    renderChatShell();
    await screen.findByText("first");
    fireBottomIntersection(true);
    scrollIntoViewMock.mockClear();

    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
          summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
        ],
      });
    });

    await screen.findByText("second");
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: "end" });
  });

  it("does not force-scroll when a live message arrives while the user has scrolled away from bottom", async () => {
    // Regression guard for Charm 1.0 issue #328 ("Jump to Present is overly
    // sticky") — yanking the view down while the user is deliberately
    // reading history is the exact failure mode Spec 26 calls out to avoid.
    getTimelinePage.mockResolvedValue({
      messages: [
        summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
      ],
      next_cursor: null,
    });
    renderChatShell();
    await screen.findByText("first");
    fireBottomIntersection(false);
    scrollIntoViewMock.mockClear();

    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
          summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
        ],
      });
    });

    await screen.findByText("second");
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it("opens a newly-selected room scrolled to bottom, even if the previous room was scrolled up", async () => {
    getTimelinePage.mockResolvedValue({
      messages: [
        summary({
          event_id: "$a",
          sender: "@alice:localhost",
          body: "room A msg",
          timestamp_ms: 1,
        }),
      ],
      next_cursor: null,
    });
    const roomB: RoomSummary = makeRoomSummary({ room_id: "!roomB:localhost", name: "Room B" });
    const store = createStore();

    const { rerender } = render(
      <JotaiProvider store={store}>
        <ChatShell room={room} currentUserId="@me:localhost" />
      </JotaiProvider>,
    );
    await screen.findByText("room A msg");
    fireBottomIntersection(false); // user scrolled up in room A
    scrollIntoViewMock.mockClear();

    getTimelinePage.mockResolvedValue({
      messages: [
        summary({
          event_id: "$b",
          sender: "@alice:localhost",
          body: "room B msg",
          timestamp_ms: 1,
        }),
      ],
      next_cursor: null,
    });
    rerender(
      <JotaiProvider store={store}>
        <ChatShell room={roomB} currentUserId="@me:localhost" />
      </JotaiProvider>,
    );

    await screen.findByText("room B msg");
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: "end" });
  });

  it("loads and prepends older history, preserving scroll position, when the top sentinel scrolls into view", async () => {
    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
      ],
      next_cursor: "more",
    });
    renderChatShell();
    await screen.findByText("second");

    const container = screen.getByText("second").closest("div.overflow-y-auto");
    if (!container) throw new Error("expected a scroll container");
    // jsdom never computes real layout, so fake `scrollHeight` as a function
    // of how many message rows are actually in the DOM right now — this
    // naturally differs between the anchor capture (before the older page's
    // rows are added) and the restore effect's read (after), the same way a
    // real browser's `scrollHeight` would grow once the taller list paints.
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => 250 + container.querySelectorAll('[id^="message-"]').length * 150,
    });
    Object.defineProperty(container, "scrollTop", {
      value: 20,
      writable: true,
      configurable: true,
    });

    let resolveOlderPage:
      | ((page: { messages: unknown[]; next_cursor: string | null }) => void)
      | undefined;
    getTimelinePage.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOlderPage = resolve;
      }),
    );
    fireTopIntersection(true);
    // The older-history request is in flight — the loading indicator shows,
    // and a second intersection shouldn't kick off a duplicate request.
    expect(await screen.findByText("Loading older messages…")).toBeInTheDocument();
    fireTopIntersection(true);
    expect(getTimelinePage).toHaveBeenCalledTimes(2);

    act(() => {
      resolveOlderPage?.({
        messages: [
          summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
          summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
        ],
        next_cursor: null,
      });
    });

    await screen.findByText("first");
    await waitFor(() =>
      expect(screen.queryByText("Loading older messages…")).not.toBeInTheDocument(),
    );
    // scrollHeight grew by 150px (one more message row) once the older page
    // rendered above the previously-visible content; scrollTop should have
    // been nudged by that same delta so "second" stays visually in place.
    expect(container.scrollTop).toBe(170);
  });

  it("does not request another page once the room's history start has been reached", async () => {
    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({
          event_id: "$a",
          sender: "@alice:localhost",
          body: "only message",
          timestamp_ms: 1,
        }),
      ],
      next_cursor: null,
    });
    renderChatShell();
    await screen.findByText("only message");

    getTimelinePage.mockClear();
    fireTopIntersection(true);

    expect(getTimelinePage).not.toHaveBeenCalled();
  });

  it("does not mark the room read while room settings covers the chat, but does once it closes", async () => {
    const store = createStore();
    store.set(roomSettingsAtom, { roomId: room.room_id, section: "general" });
    renderChatShell(store);

    await screen.findByText("No messages yet");
    // Give the suppressed effect a tick to (not) fire before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(markRoomRead).not.toHaveBeenCalled();

    act(() => {
      store.set(roomSettingsAtom, null);
    });

    await vi.waitFor(() => expect(markRoomRead).toHaveBeenCalledWith(room.room_id));
  });

  it("renders the sender's resolved display name over the raw MXID, with matching initials", async () => {
    renderChatShell();
    await screen.findByText("No messages yet");

    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({
            event_id: "$1",
            sender: "@alice:localhost",
            sender_display_name: "Alice Anderson",
            body: "hi there",
          }),
        ],
      });
    });

    expect(await screen.findByText("Alice Anderson")).toBeInTheDocument();
    expect(screen.queryByText("@alice:localhost")).not.toBeInTheDocument();
    // Initials come from the display name, not the MXID ("@a" -> "AL" vs "AL").
    expect(screen.getByText("AL")).toBeInTheDocument();
  });

  it("falls back to the raw MXID as the sender label when no display name has resolved", async () => {
    renderChatShell();
    await screen.findByText("No messages yet");

    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({
            event_id: "$1",
            sender: "@bob:localhost",
            sender_display_name: null,
            body: "hi there",
          }),
        ],
      });
    });

    expect(await screen.findByText("@bob:localhost")).toBeInTheDocument();
  });

  it("flips a bubble from pending to sent as the Timeline's own timeline:update local echo transitions", async () => {
    // The room's live Timeline (not ChatShell) creates the local echo and
    // pushes it via `timeline:update`, keyed on the SDK's send-queue
    // transaction id — ChatShell just renders whatever it's sent.
    renderChatShell();
    await screen.findByText("No messages yet");

    sendDraft("hello");
    expect(sendMessage).toHaveBeenCalledWith(room.room_id, "hello", null, null);

    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({
            event_id: "txn-1",
            sender: "@me:localhost",
            body: "hello",
            transaction_id: "txn-1",
            send_state: { state: "pending" },
          }),
        ],
      });
    });

    expect(await screen.findByText(/sending…/)).toBeInTheDocument();
    expect(document.getElementById("message-txn-1")).toBeInTheDocument();

    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({
            event_id: "txn-1",
            sender: "@me:localhost",
            body: "hello",
            transaction_id: "txn-1",
            send_state: { state: "sent" },
          }),
        ],
      });
    });

    expect(await screen.findByText("hello")).toBeInTheDocument();
    expect(screen.queryByText(/sending…/)).not.toBeInTheDocument();
  });

  it("flips a bubble from pending to error as a timeline:update reports a send failure", async () => {
    renderChatShell();
    await screen.findByText("No messages yet");

    sendDraft("hello");

    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({
            event_id: "txn-1",
            sender: "@me:localhost",
            body: "hello",
            transaction_id: "txn-1",
            send_state: { state: "pending" },
          }),
        ],
      });
    });
    await screen.findByText(/sending…/);

    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({
            event_id: "txn-1",
            sender: "@me:localhost",
            body: "hello",
            transaction_id: "txn-1",
            send_state: { state: "error", message: "network down" },
          }),
        ],
      });
    });

    expect(await screen.findByText(/failed to send/)).toBeInTheDocument();
  });

  it("reconciles the Timeline's local echo with the real event once it carries the same transaction id", async () => {
    // Reproduces the real-world mismatch: the local echo only knows the
    // SDK's transaction id ("txn-1", not a real event id yet), and the
    // synced event that eventually arrives has an entirely different real
    // `event_id` — the two only correlate via the matching
    // `transaction_id` (mirroring `unsigned.transaction_id` on the real
    // event). If the ids didn't agree, this would render two "hello"
    // bubbles and the echo would be stuck on "sending…" forever.
    renderChatShell();
    await screen.findByText("No messages yet");

    sendDraft("hello");

    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({
            event_id: "txn-1",
            sender: "@me:localhost",
            body: "hello",
            transaction_id: "txn-1",
            send_state: { state: "pending" },
          }),
        ],
      });
    });
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
    act(() => {
      timelineUpdateCallback?.({ room_id: room.room_id, messages: [realMessage] });
    });

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

  it("auto-hides the typing row after the last update with no follow-up", async () => {
    vi.useFakeTimers();
    try {
      renderChatShell();
      await vi.waitFor(() => expect(typingCallback).toBeDefined());

      act(() => {
        typingCallback?.({ room_id: room.room_id, user_ids: ["@alice:localhost"] });
      });
      expect(screen.getByText("@alice:localhost is typing…")).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(TYPING_AUTO_HIDE_MS);
      });
      expect(screen.queryByText(/is typing/)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a following-the-conversation bar that expands to list participants", async () => {
    getRoomMembers.mockResolvedValueOnce([
      {
        user_id: "@alice:localhost",
        display_name: "Alice",
        avatar_url: null,
        power_level: 0,
        membership: "join",
      },
      {
        user_id: "@bob:localhost",
        display_name: "Bob",
        avatar_url: null,
        power_level: 0,
        membership: "join",
      },
    ]);
    renderChatShell();

    const bar = await screen.findByRole("button", {
      name: "Alice and Bob are following the conversation",
    });
    expect(bar).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Alice", { selector: "span" })).not.toBeInTheDocument();

    fireEvent.click(bar);

    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(bar).toHaveAttribute("aria-expanded", "true");
  });

  it("pluralizes the following-the-conversation bar past 3 participants", async () => {
    getRoomMembers.mockResolvedValueOnce(
      ["Alice", "Bob", "Carol", "Dave"].map((name) => ({
        user_id: `@${name.toLowerCase()}:localhost`,
        display_name: name,
        avatar_url: null,
        power_level: 0,
        membership: "join" as const,
      })),
    );
    renderChatShell();

    expect(
      await screen.findByRole("button", {
        name: "Alice, Bob, Carol, and 1 other are following the conversation",
      }),
    ).toBeInTheDocument();
  });

  it("excludes invited-but-not-joined members from the following-the-conversation bar", async () => {
    getRoomMembers.mockResolvedValueOnce([
      {
        user_id: "@alice:localhost",
        display_name: "Alice",
        avatar_url: null,
        power_level: 0,
        membership: "join",
      },
      {
        user_id: "@bob:localhost",
        display_name: "Bob",
        avatar_url: null,
        power_level: 0,
        membership: "invite",
      },
    ]);
    renderChatShell();

    expect(
      await screen.findByRole("button", {
        name: "Alice is following the conversation",
      }),
    ).toBeInTheDocument();
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

    const replyRef = {
      event_id: "$original",
      sender: "@me:localhost",
      sender_display_name: null,
      preview: "the original",
    };

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

  it("clears in-flight upload rows when switching rooms", async () => {
    sendAttachment.mockImplementation(() => new Promise(() => {})); // keep the upload in-flight
    openFileDialog.mockResolvedValue("/Users/me/room-a.mp4");
    const roomB: RoomSummary = makeRoomSummary({ room_id: "!roomB:localhost", name: "Room B" });
    const store = createStore();

    const { rerender } = render(
      <JotaiProvider store={store}>
        <ChatShell room={room} currentUserId="@me:localhost" />
      </JotaiProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Attach" }));

    await waitFor(() => expect(screen.getByText("room-a.mp4")).toBeInTheDocument());

    rerender(
      <JotaiProvider store={store}>
        <ChatShell room={roomB} currentUserId="@me:localhost" />
      </JotaiProvider>,
    );

    await waitFor(() => expect(screen.queryByText("room-a.mp4")).not.toBeInTheDocument());
    expect(await screen.findByPlaceholderText("Message Room B")).toBeInTheDocument();
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

  it("does not pass pathless drop files to desktop attachment upload", async () => {
    renderChatShell();
    const textarea = await screen.findByPlaceholderText("Message general");
    const file = new File(["fake"], "drop.png", { type: "image/png" });

    fireEvent.drop(textarea, {
      dataTransfer: { files: [file] },
    });

    await Promise.resolve();
    expect(sendAttachment).not.toHaveBeenCalled();
  });

  it("does not pass pathless pasted files to desktop attachment upload", async () => {
    renderChatShell();
    const textarea = await screen.findByPlaceholderText("Message general");
    const file = new File(["fake"], "pasted.png", { type: "image/png" });

    fireEvent.paste(textarea, {
      clipboardData: { files: [file] },
    });

    await Promise.resolve();
    expect(sendAttachment).not.toHaveBeenCalled();
  });

  it("passes browser File uploads through in web builds", async () => {
    vi.stubEnv("VITE_CHARM_BUILD_TARGET", "web");
    renderChatShell();
    const textarea = await screen.findByPlaceholderText("Message general");
    const file = new File(["fake"], "drop.png", { type: "image/png" });

    fireEvent.drop(textarea, {
      dataTransfer: { files: [file] },
    });

    await waitFor(() =>
      expect(sendAttachment).toHaveBeenCalledWith(room.room_id, file, expect.any(String)),
    );
  });

  it("opens a formatted-body link via the system browser instead of navigating the webview", async () => {
    getTimelinePage.mockResolvedValue({
      messages: [
        summary({
          event_id: "$msg:localhost",
          sender: "@alice:localhost",
          body: "click here",
          formatted_body: '<a href="https://example.org/path">click here</a>',
          timestamp_ms: Date.now(),
        }),
      ],
      next_cursor: null,
    });
    renderChatShell();

    const link = await screen.findByRole("link", { name: "click here" });
    fireEvent.click(link);

    expect(openUrl).toHaveBeenCalledWith("https://example.org/path");
  });

  it("does not open a link with a scheme outside the http/https/mailto/tel allowlist", async () => {
    // `mxc://` survives the sanitizer's own URI allowlist (it's meaningful
    // for `<img src>`) but isn't a scheme `handleMessageLinkClick` will ever
    // hand to `openUrl` for an `<a href>` — this exercises that extra check
    // specifically, independent of what the sanitizer already strips.
    getTimelinePage.mockResolvedValue({
      messages: [
        summary({
          event_id: "$msg:localhost",
          sender: "@alice:localhost",
          body: "click here",
          formatted_body: '<a href="mxc://example.org/mediaid">click here</a>',
          timestamp_ms: Date.now(),
        }),
      ],
      next_cursor: null,
    });
    renderChatShell();

    const link = await screen.findByRole("link", { name: "click here" });
    fireEvent.click(link);

    expect(openUrl).not.toHaveBeenCalled();
  });

  it("leaves a relative or fragment link alone instead of resolving it against the app's own origin", async () => {
    // Regression test: an earlier version resolved `href` against
    // `window.location.href` before checking its scheme, which turned a
    // relative path into an absolute `http(s)` URL and opened it via
    // `openUrl` — contradicting the intent that relative/fragment hrefs
    // (both valid per the sanitizer's allowlist) are left untouched.
    getTimelinePage.mockResolvedValue({
      messages: [
        summary({
          event_id: "$msg:localhost",
          sender: "@alice:localhost",
          body: "click here",
          formatted_body: '<a href="/some/path">click here</a>',
          timestamp_ms: Date.now(),
        }),
      ],
      next_cursor: null,
    });
    renderChatShell();

    const link = await screen.findByRole("link", { name: "click here" });
    fireEvent.click(link);

    expect(openUrl).not.toHaveBeenCalled();
  });
});
