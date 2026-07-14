import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import type { ReactElement } from "react";
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
import { messageRowKey } from "./messageRowShared";
import { membersDrawerOpenAtomFamily, roomSettingsAtom } from "@/features/room-info/roomInfoAtoms";
import { messageLayoutAtom } from "@/features/appearance/atoms";
import { TYPING_AUTO_HIDE_MS } from "./useChatTyping";

// LinkPreviewForMessage (Spec 29) reads the room-details query cache via
// `useQuery`, which needs a QueryClientProvider ancestor even when its own
// query is disabled — wrap every render the same way the real app does.
function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  // RTL's `rerender` replaces the *entire* previously-mounted element tree,
  // including the QueryClientProvider wrapper above — so a bare
  // `rerender(<ChatShell ... />)` call site (this file has several) would
  // otherwise unmount the provider along with the old tree. Re-wrap here
  // once, so every existing call site keeps working unchanged.
  return {
    ...view,
    rerender: (nextUi: ReactElement) =>
      view.rerender(<QueryClientProvider client={client}>{nextUi}</QueryClientProvider>),
  };
}

const mockUseAdaptiveLayout = vi.hoisted(() => vi.fn(() => "desktop"));
const mockUseFlag = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/features/shell/useAdaptiveLayout", () => ({
  useAdaptiveLayout: () => mockUseAdaptiveLayout(),
}));
vi.mock("@/featureFlags", () => ({ useFlag: () => mockUseFlag() }));

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

// Spec 26 Phase 2 replaced the hand-rolled scroll-anchoring mechanisms (two
// IntersectionObservers + manual scrollHeight/scrollTop math) with
// `react-virtuoso`. Its real bottom-anchor/virtualization behavior needs
// actual browser layout to exercise meaningfully — jsdom never computes real
// element geometry, so `Virtuoso` would either render nothing (no measured
// viewport height) or require faking enough of `getBoundingClientRect` /
// `ResizeObserver` to be more a test of the library's internals than of
// ChatShell's own logic. Real virtualized-scroll behavior (sticky bottom,
// no-yank-while-scrolled-up, prepend-without-jump) is instead covered by
// `e2e/timeline-scroll.spec.ts` against a real browser layout, per Spec 26
// Phase 2's own acceptance criteria.
//
// Unit tests here fake `Virtuoso` itself: render every row unconditionally
// (no virtualization — irrelevant to what these tests check), and capture
// the callback props ChatShell wires up (`startReached`,
// `atBottomStateChange`) so tests can invoke them directly, the same way the
// old `fireBottomIntersection`/`fireTopIntersection` helpers drove the real
// IntersectionObservers. This still exercises everything that's genuinely
// ChatShell's/`useChatTimeline`'s own responsibility: mark-as-read gating,
// `loadMoreHistory`'s in-flight dedup and cursor handling, `firstItemIndex`
// bookkeeping, entrance-animation suppression during pagination, and the
// "jump to present" pill's own state machine.
let virtuosoStartReached: (() => void) | undefined;
let virtuosoAtBottomStateChange: ((atBottom: boolean) => void) | undefined;
let virtuosoComputeItemKey:
  | ((index: number, item: RoomMessageSummary, context: unknown) => string | number)
  | undefined;
const virtuosoScrollToIndexMock = vi.fn();

vi.mock("react-virtuoso", () => ({
  Virtuoso: forwardRef(function FakeVirtuoso(
    props: {
      data: RoomMessageSummary[];
      className?: string;
      firstItemIndex?: number;
      startReached?: () => void;
      atBottomStateChange?: (atBottom: boolean) => void;
      context?: unknown;
      components?: { Header?: (props: { context?: unknown }) => React.ReactNode };
      computeItemKey?: (
        index: number,
        item: RoomMessageSummary,
        context: unknown,
      ) => string | number;
      itemContent: (index: number, item: RoomMessageSummary, context: unknown) => React.ReactNode;
    },
    ref,
  ) {
    virtuosoStartReached = props.startReached;
    virtuosoAtBottomStateChange = props.atBottomStateChange;
    virtuosoComputeItemKey = props.computeItemKey;
    useImperativeHandle(ref, () => ({
      scrollToIndex: (location: unknown) => virtuosoScrollToIndexMock(location),
    }));
    const base = props.firstItemIndex ?? 0;
    const Header = props.components?.Header;
    return (
      <div data-testid="fake-virtuoso" className={props.className} data-first-item-index={base}>
        {Header ? <Header context={props.context} /> : null}
        {props.data.map((item, i) => {
          // Uses the real `computeItemKey` when ChatShell provides one, same
          // as a real Virtuoso would, rather than always keying by identity
          // regardless of what was actually passed — a test asserting on
          // `computeItemKey`'s own behavior (see "keeps stable virtualized
          // row keys...") needs the mock to actually route through it.
          const key = props.computeItemKey?.(base + i, item, props.context) ?? messageRowKey(item);
          return <div key={String(key)}>{props.itemContent(base + i, item, props.context)}</div>;
        })}
      </div>
    );
  }),
}));

function fireAtBottomStateChange(atBottom: boolean) {
  act(() => {
    virtuosoAtBottomStateChange?.(atBottom);
  });
}

function fireStartReached() {
  act(() => {
    virtuosoStartReached?.();
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
  // Spec 29: LinkPreviewForMessage reads room encryption state before ever
  // fetching a preview. None of ChatShell's own tests exercise link
  // previews, so default to "encrypted" (the safe suppress-by-default
  // state) — this must never resolve `is_encrypted: false`, or a stray
  // test message containing a URL would start firing real preview fetches
  // this test file doesn't mock.
  getRoomDetails: vi.fn().mockResolvedValue({ room_id: "!general:localhost", is_encrypted: true }),
  getUrlPreview: vi.fn(),
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

// `a.compareDocumentPosition(b) & DOCUMENT_POSITION_FOLLOWING` is truthy
// when `b` comes after `a` in the document.
function isBefore(a: Element, b: Element): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function renderChatShell(store = createStore(), roomOverride: RoomSummary = room) {
  return {
    store,
    ...render(
      <JotaiProvider store={store}>
        <ChatShell room={roomOverride} currentUserId="@me:localhost" />
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
    mockUseAdaptiveLayout.mockReturnValue("desktop");
    mockUseFlag.mockReturnValue(true);
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
    virtuosoStartReached = undefined;
    virtuosoAtBottomStateChange = undefined;
    virtuosoScrollToIndexMock.mockReset();
  });

  it("marks the exhausted start of history as all caught up", async () => {
    getTimelinePage.mockResolvedValueOnce({
      messages: [summary({ event_id: "$oldest", sender: "@alice:localhost", body: "oldest" })],
      next_cursor: null,
    });
    renderChatShell();
    expect(await screen.findByText("You're all caught up")).toBeInTheDocument();
  });

  it("prompts to select a room when none is active", () => {
    render(<ChatShell room={null} currentUserId="@me:localhost" />);
    expect(screen.getByText("Select a room to start chatting")).toBeInTheDocument();
  });

  it("renders mobile chat navigation, compact formatting, and room actions", async () => {
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    const onBack = vi.fn();
    const store = createStore();
    const otherRoom = { ...room, room_id: "!other:localhost", name: "Other room" };
    const view = render(
      <JotaiProvider store={store}>
        <ChatShell room={room} currentUserId="@me:localhost" onBack={onBack} />
      </JotaiProvider>,
    );

    await screen.findByText("No messages yet");
    expect(screen.getByText("Send the first message to start the conversation.")).toBeVisible();
    expect(screen.getByPlaceholderText("Message")).toBeVisible();
    expect(screen.queryByRole("toolbar", { name: "Formatting" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to chats" }));
    expect(onBack).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Show formatting" }));
    expect(screen.getByRole("button", { name: "Hide formatting" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    view.rerender(
      <JotaiProvider store={store}>
        <ChatShell room={otherRoom} currentUserId="@me:localhost" onBack={onBack} />
      </JotaiProvider>,
    );
    expect(screen.getByRole("button", { name: "Show formatting" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Room actions" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Show members" }));
    expect(store.get(membersDrawerOpenAtomFamily(otherRoom.room_id))).toBe(true);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Room actions" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Room settings" }));
    expect(store.get(roomSettingsAtom)).toEqual({ roomId: otherRoom.room_id, section: "general" });
  });

  it("keeps the existing mobile chat UI when the redesign flag is disabled", async () => {
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    mockUseFlag.mockReturnValue(false);

    renderChatShell();

    await screen.findByText("No messages yet");
    expect(screen.queryByText("Send the first message to start the conversation.")).toBeNull();
    expect(screen.getByPlaceholderText("Message general")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Show formatting" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back to chats" })).toBeNull();
    expect(screen.getByRole("button", { name: "Room settings" })).toBeVisible();
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

  // Real bottom-anchoring / sticky-bottom-on-arrival behavior is now
  // `react-virtuoso`'s own responsibility (`alignToBottom` +
  // `initialTopMostItemIndex` + `followOutput="auto"`), verified against a
  // real browser layout by `e2e/timeline-scroll.spec.ts` rather than here —
  // see this file's `vi.mock("react-virtuoso", ...)` comment above. This
  // test only confirms ChatShell actually wires the props that produce that
  // behavior.
  it("renders the message list bottom-anchored via Virtuoso's own props", async () => {
    getTimelinePage.mockResolvedValue({
      messages: [
        summary({ event_id: "$a", sender: "@alice:localhost", body: "hi", timestamp_ms: 1 }),
      ],
      next_cursor: null,
    });
    renderChatShell();

    await screen.findByText("hi");
    expect(screen.getByTestId("fake-virtuoso")).toBeInTheDocument();
  });

  it("marks the room read once Virtuoso reports the user is at the true bottom", async () => {
    getTimelinePage.mockResolvedValue({
      messages: [
        summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
      ],
      next_cursor: null,
    });
    renderChatShell();
    await screen.findByText("first");
    // The initial mount already marked "$a" read (it opens at bottom) —
    // scroll away, let a new message arrive unread, then return to bottom;
    // only that transition should be gated on `atBottomStateChange`.
    fireAtBottomStateChange(false);
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
    markRoomRead.mockClear();

    fireAtBottomStateChange(true);
    await vi.waitFor(() => expect(markRoomRead).toHaveBeenCalledWith(room.room_id));
  });

  it("does not mark read again while scrolled away from bottom when a new message arrives", async () => {
    getTimelinePage.mockResolvedValue({
      messages: [
        summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
      ],
      next_cursor: null,
    });
    renderChatShell();
    await screen.findByText("first");
    fireAtBottomStateChange(false);
    markRoomRead.mockClear();

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
    expect(markRoomRead).not.toHaveBeenCalled();
  });

  it("shows a jump-to-present pill once scrolled away and a new message arrives, and clicking it scrolls to bottom and marks read", async () => {
    // Regression guard for Charm 1.0 issue #328 ("Jump to Present is overly
    // sticky") in spirit — the pill must not appear while already at bottom,
    // and clicking it is the only thing that should move the view.
    getTimelinePage.mockResolvedValue({
      messages: [
        summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
      ],
      next_cursor: null,
    });
    renderChatShell();
    await screen.findByText("first");
    fireAtBottomStateChange(false);

    expect(screen.queryByText(/new message/)).not.toBeInTheDocument();

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

    const pill = await screen.findByRole("button", { name: "1 new message" });
    markRoomRead.mockClear();
    fireEvent.click(pill);

    expect(virtuosoScrollToIndexMock).toHaveBeenCalledWith(
      expect.objectContaining({ index: "LAST", align: "end" }),
    );
    expect(screen.queryByText(/new message/)).not.toBeInTheDocument();
    await vi.waitFor(() => expect(markRoomRead).toHaveBeenCalledWith(room.room_id));
  });

  it("does not show a pill for the user's own message sent through the composer while scrolled away, because sending scrolls to present first", async () => {
    // Own sends don't need special-case exclusion from the pill count
    // (see the next test) — they simply never reach it, because
    // `handleComposerSubmitAndScroll` flips `atBottom` back to `true`
    // synchronously, before the eventual `timeline:update` for the sent
    // message ever lands.
    getTimelinePage.mockResolvedValue({
      messages: [
        summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
      ],
      next_cursor: null,
    });
    renderChatShell();
    await screen.findByText("first");
    fireAtBottomStateChange(false);

    sendDraft("my own reply");

    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
          summary({
            event_id: "$b",
            sender: "@me:localhost",
            body: "my own reply",
            timestamp_ms: 2,
          }),
        ],
      });
    });

    await screen.findByText("my own reply");
    expect(screen.queryByText(/new message/)).not.toBeInTheDocument();
  });

  it("shows a jump-to-present pill for the user's own message when it arrives from a path that isn't this composer", async () => {
    // Regression test: an own message can arrive from a path this component
    // never explicitly scrolls for — another device, or a future send path
    // like an attachment upload. Unconditionally excluding every own
    // message from the pill count (as an earlier version did) would leave
    // the user with no visible way back to that message while scrolled
    // away. The pill only avoids double-counting the composer/slash-command
    // paths because those explicitly scroll to present first (see the
    // previous test) — it doesn't special-case sender identity at all.
    getTimelinePage.mockResolvedValue({
      messages: [
        summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
      ],
      next_cursor: null,
    });
    renderChatShell();
    await screen.findByText("first");
    fireAtBottomStateChange(false);

    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
          summary({
            event_id: "$b",
            sender: "@me:localhost",
            body: "from another device",
            timestamp_ms: 2,
          }),
        ],
      });
    });

    await screen.findByText("from another device");
    expect(await screen.findByRole("button", { name: "1 new message" })).toBeInTheDocument();
  });

  it("does not re-count an own message toward the pill when its pending echo is acknowledged after the user scrolls away", async () => {
    // Regression test: `messageRowKey` (transaction_id ?? event_id) changes
    // the moment a pending own send is acknowledged — the row was already
    // marked "seen" under its pending (transaction id) key while still at
    // bottom, but the acked version's key (its real event id) was never
    // seen before, so a naive fresh-diff would count the *same* message a
    // second time under its new key once the user has since scrolled away.
    getTimelinePage.mockResolvedValue({
      messages: [
        summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
      ],
      next_cursor: null,
    });
    renderChatShell();
    await screen.findByText("first");

    // The pending echo renders while still at bottom (default state).
    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
          summary({
            event_id: "txn-1",
            sender: "@me:localhost",
            body: "my message",
            timestamp_ms: 2,
            transaction_id: "txn-1",
            send_state: { state: "pending" },
          }),
        ],
      });
    });
    await screen.findByText("my message");

    // The user scrolls away before the ack snapshot lands.
    fireAtBottomStateChange(false);

    // The homeserver ack replaces the echo in place: same timestamp, but a
    // real event id and no transaction_id (per `timeline.rs`).
    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
          summary({
            event_id: "$real:localhost",
            sender: "@me:localhost",
            body: "my message",
            timestamp_ms: 2,
            transaction_id: null,
            send_state: { state: "sent" },
          }),
        ],
      });
    });

    await waitFor(() => expect(document.getElementById("message-txn-1")).not.toBeInTheDocument());
    expect(screen.queryByText(/new message/)).not.toBeInTheDocument();
  });

  it("counts a live tail message toward the jump-to-present pill even while an unrelated backward-pagination request is in flight", async () => {
    // Regression test (Codex review on PR #232): an earlier version
    // blanket-suppressed the entire jump-to-present count (and entrance
    // animation) for *any* messages update that landed while `loadingMore`
    // had been true, conflating "older history was just prepended" with "a
    // live message happened to arrive during that same window." A live
    // tail-only arrival (no prepend at all) must still animate in and count
    // toward the pill, distinguished via `firstItemIndex` not changing for
    // this specific update (see `previousFirstItemIndexRef` in ChatShell).
    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
      ],
      next_cursor: "more",
    });
    renderChatShell();
    await screen.findByText("second");
    fireAtBottomStateChange(false);

    let resolveOlderPage:
      | ((page: { messages: unknown[]; next_cursor: string | null }) => void)
      | undefined;
    getTimelinePage.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOlderPage = resolve;
      }),
    );
    fireStartReached();
    expect(await screen.findByText("Loading older messages…")).toBeInTheDocument();

    // A live message arrives at the tail — unrelated to the in-flight
    // pagination request, no history prepended.
    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
          summary({ event_id: "$c", sender: "@alice:localhost", body: "third", timestamp_ms: 3 }),
        ],
      });
    });
    await screen.findByText("third");

    expect(await screen.findByRole("button", { name: "1 new message" })).toBeInTheDocument();
    expect(document.getElementById("message-$c")?.className).toMatch(/animate-in/);

    act(() => {
      resolveOlderPage?.({
        messages: [
          summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
          summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
          summary({ event_id: "$c", sender: "@alice:localhost", body: "third", timestamp_ms: 3 }),
        ],
        next_cursor: null,
      });
    });
    await screen.findByText("first");
    await waitFor(() =>
      expect(screen.queryByText("Loading older messages…")).not.toBeInTheDocument(),
    );
    // The prepended "first" must not itself animate or bump the pill count
    // further once pagination resolves.
    expect(document.getElementById("message-$a")?.className).not.toMatch(/animate-in/);
    expect(screen.getByRole("button", { name: "1 new message" })).toBeInTheDocument();
  });

  it("opens a newly-selected room bottom-anchored, remounting Virtuoso per room", async () => {
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
    fireAtBottomStateChange(false); // user scrolled up in room A

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
    // A newly-opened room is never scrolled away from bottom, regardless of
    // the previous room's state — no pill, even if a live update arrives.
    expect(screen.queryByText(/new message/)).not.toBeInTheDocument();
  });

  it("clears an already-visible jump-to-present pill immediately when switching rooms, before room B's own atBottomStateChange fires", async () => {
    // Regression test: `atBottom`/`newMessageCount` live in `ChatShell`, not
    // in `useChatTimeline` or on the (per-room-remounted) Virtuoso instance,
    // so switching rooms alone doesn't reset them for free — without an
    // explicit reset, room A's stale pill would remain visible over room B's
    // first render, before B's Virtuoso has had a chance to report its own
    // `atBottomStateChange`.
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
    fireAtBottomStateChange(false);
    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({
            event_id: "$a",
            sender: "@alice:localhost",
            body: "room A msg",
            timestamp_ms: 1,
          }),
          summary({
            event_id: "$new",
            sender: "@alice:localhost",
            body: "room A new",
            timestamp_ms: 2,
          }),
        ],
      });
    });
    await screen.findByRole("button", { name: "1 new message" });

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
    expect(screen.queryByText(/new message/)).not.toBeInTheDocument();
  });

  it("does not show the pill for a message that arrived while at bottom, just because the user later scrolls away with nothing new arriving", async () => {
    // Regression test: `newMessageKeys`'s `useMemo` returns the same
    // memoized Set across renders where messages/loading/loadingMore/
    // activeRoomId haven't changed. An earlier version's pill-counting
    // effect depended on `[newMessageKeys, atBottom]` directly, so merely
    // scrolling away from bottom (with no new message) re-ran that effect
    // against the same stale "fresh" Set from the last real update and
    // incorrectly counted an already-seen message toward the pill.
    getTimelinePage.mockResolvedValue({
      messages: [
        summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
      ],
      next_cursor: null,
    });
    renderChatShell();
    await screen.findByText("first");

    // A message arrives while still at bottom (the default) — no pill.
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
    expect(screen.queryByText(/new message/)).not.toBeInTheDocument();

    // Scrolling away afterward, with no further message arriving, must not
    // retroactively count "second" toward the pill.
    fireAtBottomStateChange(false);
    expect(screen.queryByText(/new message/)).not.toBeInTheDocument();
  });

  it("scrolls to the user's own newly-sent message even while scrolled away from bottom", async () => {
    // Regression test: the jump-to-present pill deliberately excludes the
    // user's own messages (sending is already an intentional "return to
    // present" action), and Virtuoso's `followOutput="auto"` only follows
    // new content while already at bottom — so without an explicit scroll on
    // send, sending while scrolled up would leave the just-sent message
    // offscreen with no pill and no way back to it.
    getTimelinePage.mockResolvedValue({
      messages: [
        summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
      ],
      next_cursor: null,
    });
    renderChatShell();
    await screen.findByText("first");
    fireAtBottomStateChange(false);
    virtuosoScrollToIndexMock.mockClear();

    sendDraft("my own message");

    await vi.waitFor(() =>
      expect(virtuosoScrollToIndexMock).toHaveBeenCalledWith(
        expect.objectContaining({ index: "LAST", align: "end" }),
      ),
    );
  });

  it("loads and prepends older history when Virtuoso reports the top has been reached, decrementing firstItemIndex", async () => {
    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
      ],
      next_cursor: "more",
    });
    renderChatShell();
    await screen.findByText("second");
    const initialFirstItemIndex = Number(
      screen.getByTestId("fake-virtuoso").getAttribute("data-first-item-index"),
    );

    let resolveOlderPage:
      | ((page: { messages: unknown[]; next_cursor: string | null }) => void)
      | undefined;
    getTimelinePage.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOlderPage = resolve;
      }),
    );
    fireStartReached();
    // The older-history request is in flight — the loading indicator shows,
    // and another `startReached` shouldn't kick off a duplicate request.
    expect(await screen.findByText("Loading older messages…")).toBeInTheDocument();
    fireStartReached();
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
    // One older message was prepended — Virtuoso's `firstItemIndex` recipe
    // (see `useChatTimeline.ts`) must decrease by exactly that count in the
    // same update, so the previously-visible rows keep their logical
    // position instead of the list visibly jumping.
    expect(Number(screen.getByTestId("fake-virtuoso").getAttribute("data-first-item-index"))).toBe(
      initialFirstItemIndex - 1,
    );
  });

  it("computes firstItemIndex by the previously-first message's new position, not a length diff, when a live message races pagination", async () => {
    // Regression test: a plain `newLength - previousLength` diff would
    // over-count here — a live `timeline:update` appends a new message to
    // the tail *while* `loadMoreHistory`'s own request is still in flight,
    // so by the time that request resolves, the page it returns reflects
    // both the prepended history AND the appended live message. Diffing
    // lengths would misattribute the live arrival as more prepended history
    // and shift `firstItemIndex` (and so the visual anchor) by one too many.
    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
      ],
      next_cursor: "more",
    });
    renderChatShell();
    await screen.findByText("second");
    const initialFirstItemIndex = Number(
      screen.getByTestId("fake-virtuoso").getAttribute("data-first-item-index"),
    );

    let resolveOlderPage:
      | ((page: { messages: unknown[]; next_cursor: string | null }) => void)
      | undefined;
    getTimelinePage.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOlderPage = resolve;
      }),
    );
    fireStartReached();
    await screen.findByText("Loading older messages…");

    // A live message arrives at the tail while the pagination request is
    // still in flight.
    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
          summary({ event_id: "$c", sender: "@alice:localhost", body: "third", timestamp_ms: 3 }),
        ],
      });
    });
    await screen.findByText("third");

    // The pagination request resolves with exactly one older message
    // prepended, plus the live "$c" appended at the tail — two more items
    // than `previousLength`, but only one of them is actually older history.
    act(() => {
      resolveOlderPage?.({
        messages: [
          summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
          summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
          summary({ event_id: "$c", sender: "@alice:localhost", body: "third", timestamp_ms: 3 }),
        ],
        next_cursor: null,
      });
    });

    await screen.findByText("first");
    expect(Number(screen.getByTestId("fake-virtuoso").getAttribute("data-first-item-index"))).toBe(
      initialFirstItemIndex - 1,
    );
  });

  it("does not animate older history prepended by backward pagination", async () => {
    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
      ],
      next_cursor: "more",
    });
    renderChatShell();
    await screen.findByText("second");

    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
        summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
      ],
      next_cursor: null,
    });
    fireStartReached();

    await screen.findByText("first");
    expect(document.getElementById("message-$a")?.className).not.toMatch(/animate-in/);
  });

  it("does not animate history prepended by a live update racing an in-flight pagination request, and shifts firstItemIndex exactly once", async () => {
    // Regression test: if a `timeline:update` pushes the same
    // paginate_backwards diff before `loadMoreHistory`'s own await resolves,
    // that snapshot arrives with `loadingMore` still `true`. It must still
    // be treated as a pagination update, not a live arrival — and
    // `firstItemIndex` must shift by exactly one (the one message actually
    // prepended), not twice just because both the live update and
    // `loadMoreHistory`'s own response happen to carry the identical
    // prepended diff (see `useChatTimeline.ts`'s `applyMessages`).
    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
      ],
      next_cursor: "more",
    });
    renderChatShell();
    await screen.findByText("second");
    const initialFirstItemIndex = Number(
      screen.getByTestId("fake-virtuoso").getAttribute("data-first-item-index"),
    );

    let resolveOlderPage:
      | ((page: { messages: unknown[]; next_cursor: string | null }) => void)
      | undefined;
    getTimelinePage.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOlderPage = resolve;
      }),
    );
    fireStartReached();
    expect(await screen.findByText("Loading older messages…")).toBeInTheDocument();

    // A live timeline:update lands with the same prepended history while
    // `loadMoreHistory`'s own request is still in flight (loadingMore still
    // true at this point).
    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
          summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
        ],
      });
    });
    await screen.findByText("first");
    expect(document.getElementById("message-$a")?.className).not.toMatch(/animate-in/);
    // The live update alone already shifted firstItemIndex once.
    expect(Number(screen.getByTestId("fake-virtuoso").getAttribute("data-first-item-index"))).toBe(
      initialFirstItemIndex - 1,
    );

    act(() => {
      resolveOlderPage?.({
        messages: [
          summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
          summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
        ],
        next_cursor: null,
      });
    });
    await waitFor(() =>
      expect(screen.queryByText("Loading older messages…")).not.toBeInTheDocument(),
    );
    expect(document.getElementById("message-$a")?.className).not.toMatch(/animate-in/);
    // loadMoreHistory's own (identical) response must not shift it again.
    expect(Number(screen.getByTestId("fake-virtuoso").getAttribute("data-first-item-index"))).toBe(
      initialFirstItemIndex - 1,
    );
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
    fireStartReached();

    expect(getTimelinePage).not.toHaveBeenCalled();
  });

  it("auto-paginates when the newest page has zero renderable messages but more history remains", async () => {
    // Regression test: some Matrix timeline items (state events, polls,
    // etc.) are filtered out of `RoomMessageSummary` entirely — a room whose
    // *newest* page happens to be all such items would return `messages: []`
    // with a non-null `next_cursor`. Virtuoso only mounts when
    // `messages.length > 0`, so its `startReached` sentinel would never
    // exist to trigger the load the normal way, permanently stranding the
    // user on "No messages yet" despite real history being available.
    getTimelinePage.mockResolvedValueOnce({ messages: [], next_cursor: "more" });
    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({
          event_id: "$a",
          sender: "@alice:localhost",
          body: "older text",
          timestamp_ms: 1,
        }),
      ],
      next_cursor: null,
    });
    renderChatShell();

    await screen.findByText("older text");
    expect(getTimelinePage).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("No messages yet")).not.toBeInTheDocument();
  });

  it("shows 'No messages yet' once an empty page's history is confirmed exhausted", async () => {
    getTimelinePage.mockResolvedValueOnce({ messages: [], next_cursor: null });
    renderChatShell();

    await screen.findByText("No messages yet");
    expect(getTimelinePage).toHaveBeenCalledTimes(1);
  });

  it("keeps paginating internally when a backward-pagination page adds zero renderable rows to an already-non-empty timeline", async () => {
    // Regression test: a page can legitimately contribute zero renderable
    // rows to an already-loaded (non-empty) timeline too, not just on the
    // very first load — its underlying events were all filtered out of
    // `RoomMessageSummary`, but `next_cursor` still advances. Virtuoso's
    // `startReached` is deduped by rendered range and won't refire on its
    // own while such a response leaves that range unchanged, so
    // `loadMoreHistory` must keep paginating internally rather than
    // stranding the user with no way to reach the older content behind it.
    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
      ],
      next_cursor: "more",
    });
    renderChatShell();
    await screen.findByText("second");

    // The next page adds nothing renderable (same array, advanced cursor)...
    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
      ],
      next_cursor: "even-more",
    });
    // ...and the one after that finally does.
    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
        summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
      ],
      next_cursor: null,
    });
    fireStartReached();

    await screen.findByText("first");
    expect(getTimelinePage).toHaveBeenCalledTimes(3);
  });

  it("stops retrying empty-first-page auto-pagination after a request fails", async () => {
    // Regression test: a rejected loadMoreHistory() call leaves messages
    // empty and hasMore unchanged, so without a failure flag, ChatShell's
    // empty-first-page auto-pagination effect would immediately call it
    // again the moment loadingMore flips back to false — looping forever
    // against a persistent backend/network error.
    getTimelinePage.mockResolvedValueOnce({ messages: [], next_cursor: "more" });
    getTimelinePage.mockRejectedValueOnce(new Error("network error"));
    renderChatShell();

    await screen.findByText("Couldn't load messages");
    // One call for the initial (empty) page, one for the failed retry — no
    // further retries once paginationError is set.
    expect(getTimelinePage).toHaveBeenCalledTimes(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getTimelinePage).toHaveBeenCalledTimes(2);
  });

  it("does not stop the zero-prepend pagination loop early just because a live message races it", async () => {
    // Regression test: an earlier version judged loop progress by
    // `page.messages.length > previousLength`, which a live tail message
    // racing the in-flight request (see the existing firstItemIndex race
    // tests above) can satisfy without any real history having been
    // prepended — stopping the loop one page too early and stranding the
    // user behind an all-filtered-out page. Progress must be judged by
    // `applyMessages`' own identity-based return value instead.
    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
      ],
      next_cursor: "more",
    });
    renderChatShell();
    await screen.findByText("second");

    let resolveZeroPrependPage:
      | ((page: { messages: unknown[]; next_cursor: string | null }) => void)
      | undefined;
    getTimelinePage.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveZeroPrependPage = resolve;
      }),
    );
    fireStartReached();
    await screen.findByText("Loading older messages…");

    // A live message races this same in-flight request — the response's
    // length grows relative to what was loaded when the request started,
    // purely from this unrelated arrival, not from any real prepend.
    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
          summary({ event_id: "$c", sender: "@alice:localhost", body: "third", timestamp_ms: 3 }),
        ],
      });
    });
    await screen.findByText("third");

    // The pagination response itself prepends nothing (same "$b"/"$c" set,
    // no "$a"), but still has a next_cursor — the loop must continue rather
    // than stop here just because the array is longer than when the
    // request started.
    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
        summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
        summary({ event_id: "$c", sender: "@alice:localhost", body: "third", timestamp_ms: 3 }),
      ],
      next_cursor: null,
    });
    act(() => {
      resolveZeroPrependPage?.({
        messages: [
          summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
          summary({ event_id: "$c", sender: "@alice:localhost", body: "third", timestamp_ms: 3 }),
        ],
        next_cursor: "more",
      });
    });

    await screen.findByText("first");
    expect(getTimelinePage).toHaveBeenCalledTimes(3);
  });

  it("does not fetch an unnecessary extra page when a live update already applies this request's own prepend first", async () => {
    // Regression test (Codex P1): the opposite race from the previous test —
    // a live `timeline:update` for this same `paginate_backwards` call can
    // apply the prepend *before* the pagination response itself arrives. By
    // the time this loop processes that (now redundant) response,
    // `applyMessages`' own per-call return reports zero new prepends (the
    // live update already moved the tracked front message), which an
    // earlier version misread as "no progress, fetch another page" —
    // needlessly walking further back than the single page the user's
    // scroll-up asked for. Progress must be judged against the whole loop's
    // starting point, not each individual response.
    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
      ],
      next_cursor: "more",
    });
    renderChatShell();
    await screen.findByText("second");

    let resolvePaginationResponse:
      | ((page: { messages: unknown[]; next_cursor: string | null }) => void)
      | undefined;
    getTimelinePage.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePaginationResponse = resolve;
      }),
    );
    fireStartReached();
    await screen.findByText("Loading older messages…");

    // A live timeline:update lands with the same prepended history the
    // pagination request is still awaiting its own response for.
    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
          summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
        ],
      });
    });
    await screen.findByText("first");

    // The pagination response finally resolves with the identical (now
    // redundant) content.
    act(() => {
      resolvePaginationResponse?.({
        messages: [
          summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
          summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
        ],
        next_cursor: "more",
      });
    });

    await waitFor(() =>
      expect(screen.queryByText("Loading older messages…")).not.toBeInTheDocument(),
    );
    // Exactly the initial load plus the one pagination request — no
    // additional page fetched just because that response's own diff looked
    // like zero progress.
    expect(getTimelinePage).toHaveBeenCalledTimes(2);
  });

  it("treats an offset-neutral prepend applied by a racing live update as progress, without an extra page fetch", async () => {
    // Regression test (Codex P2, fresh evidence beyond the earlier fixes):
    // the live update can win the race and apply an *offset-neutral*
    // prepend itself (real content added, but an equal-count front-row
    // removal cancels firstItemIndex's net shift — see the non-racing
    // version of this test above). This request's own response then echoes
    // that identical (now redundant) content. Recomputing applyMessages from
    // scratch for that echo would report zero prepended rows (nothing left
    // to compare against), needlessly fetching another page — the preserved
    // prependedCount from the live update's own call must still count.
    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({
          event_id: "$undecryptable",
          sender: "@alice:localhost",
          body: "",
          is_undecrypted: true,
          timestamp_ms: 1,
        }),
        summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
      ],
      next_cursor: "more",
    });
    renderChatShell();
    await screen.findByText("second");

    let resolveOffsetNeutralPage:
      | ((page: { messages: unknown[]; next_cursor: string | null }) => void)
      | undefined;
    getTimelinePage.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOffsetNeutralPage = resolve;
      }),
    );
    fireStartReached();
    await screen.findByText("Loading older messages…");

    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({
            event_id: "$x",
            sender: "@alice:localhost",
            body: "prepended x",
            timestamp_ms: 0,
          }),
          summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
        ],
      });
    });
    await screen.findByText("prepended x");

    act(() => {
      resolveOffsetNeutralPage?.({
        messages: [
          summary({
            event_id: "$x",
            sender: "@alice:localhost",
            body: "prepended x",
            timestamp_ms: 0,
          }),
          summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
        ],
        next_cursor: "more",
      });
    });

    await waitFor(() =>
      expect(screen.queryByText("Loading older messages…")).not.toBeInTheDocument(),
    );
    expect(getTimelinePage).toHaveBeenCalledTimes(2);
  });

  it("keeps the prepended-row entrance-animation exclusion intact when a racing live update and this request's own response batch into the same commit", async () => {
    // Regression test (Codex P1): if the live timeline:update and this
    // pagination request's own (now-redundant) response are both processed
    // before React commits either state update, applyMessages must not let
    // the second (redundant) call overwrite the first's correct
    // prependedCount with 0 — otherwise ChatShell renders the prepended row
    // without suppression, animating it as if it were a brand new arrival.
    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
      ],
      next_cursor: "more",
    });
    renderChatShell();
    await screen.findByText("second");

    let resolveRedundantPage:
      | ((page: { messages: unknown[]; next_cursor: string | null }) => void)
      | undefined;
    getTimelinePage.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRedundantPage = resolve;
      }),
    );
    fireStartReached();
    await screen.findByText("Loading older messages…");

    // Both calls land within the same `act`, so React batches their state
    // updates into a single commit rather than rendering the live update's
    // (correct) intermediate state first.
    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
          summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
        ],
      });
      resolveRedundantPage?.({
        messages: [
          summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
          summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
        ],
        next_cursor: "more",
      });
    });

    await screen.findByText("first");
    expect(document.getElementById("message-$a")?.className).not.toMatch(/animate-in/);
  });

  it("shifts firstItemIndex forward when the previously-first message disappears from a later snapshot", async () => {
    // Regression test: if the old first message itself vanishes from a
    // later full snapshot (e.g. an UnableToDecrypt placeholder resolves into
    // a msgtype timeline_item_to_summary filters out), a plain "is the old
    // first message still first" check treats it as no change — but the
    // next surviving message's logical index must shift forward by one to
    // compensate, or Virtuoso loses its anchor for users reading near the top.
    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({
          event_id: "$undecryptable",
          sender: "@alice:localhost",
          body: "",
          is_undecrypted: true,
          timestamp_ms: 1,
        }),
        summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
      ],
      next_cursor: null,
    });
    renderChatShell();
    await screen.findByText("second");
    const initialFirstItemIndex = Number(
      screen.getByTestId("fake-virtuoso").getAttribute("data-first-item-index"),
    );

    // The undecryptable placeholder resolves into something filtered out
    // entirely — it disappears from the snapshot rather than updating in
    // place.
    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
        ],
      });
    });

    await waitFor(() =>
      expect(
        Number(screen.getByTestId("fake-virtuoso").getAttribute("data-first-item-index")),
      ).toBe(initialFirstItemIndex + 1),
    );
  });

  it("does not treat a front-row removal as pagination progress when the fetched page itself adds nothing", async () => {
    // Regression test: comparing "did the front key change at all" (rather
    // than requiring firstItemIndex to actually *decrease*) breaks if the
    // old front message disappears (see the previous test) at the same time
    // a fetched page contributes zero renderable rows — the loop must keep
    // going rather than stop just because *something* changed at the front.
    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({
          event_id: "$undecryptable",
          sender: "@alice:localhost",
          body: "",
          is_undecrypted: true,
          timestamp_ms: 1,
        }),
        summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
      ],
      next_cursor: "more",
    });
    renderChatShell();
    await screen.findByText("second");

    let resolveZeroProgressPage:
      | ((page: { messages: unknown[]; next_cursor: string | null }) => void)
      | undefined;
    getTimelinePage.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveZeroProgressPage = resolve;
      }),
    );
    fireStartReached();
    await screen.findByText("Loading older messages…");

    // The undecryptable placeholder disappears (a front-row removal, not a
    // prepend) while the pagination request is still in flight.
    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
        ],
      });
    });
    await waitFor(() =>
      expect(document.getElementById("message-$undecryptable")).not.toBeInTheDocument(),
    );

    // The fetched page itself contributes nothing new (same "$b", no "$a")
    // but still has a next_cursor — the loop must continue.
    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
        summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
      ],
      next_cursor: null,
    });
    act(() => {
      resolveZeroProgressPage?.({
        messages: [
          summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
        ],
        next_cursor: "more",
      });
    });

    await screen.findByText("first");
    expect(getTimelinePage).toHaveBeenCalledTimes(3);
  });

  it("treats an offset-neutral prepend (real content added, but a front-row removal cancels the net shift) as progress", async () => {
    // Regression test (Codex P2): a page can simultaneously prepend real
    // history *and* drop the same number of old front rows (e.g. an
    // UnableToDecrypt placeholder resolving into a filtered-out type),
    // netting `firstItemIndex`'s before/after diff to zero even though
    // genuine content was added. Judging progress from `applyMessages`' own
    // prepended-row count (not that diff) is required to stop the loop
    // after this one page instead of needlessly fetching another.
    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({
          event_id: "$undecryptable",
          sender: "@alice:localhost",
          body: "",
          is_undecrypted: true,
          timestamp_ms: 1,
        }),
        summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
      ],
      next_cursor: "more",
    });
    renderChatShell();
    await screen.findByText("second");

    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({
          event_id: "$x",
          sender: "@alice:localhost",
          body: "prepended x",
          timestamp_ms: 0,
        }),
        summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
      ],
      next_cursor: "more",
    });
    fireStartReached();

    await screen.findByText("prepended x");
    await waitFor(() =>
      expect(screen.queryByText("Loading older messages…")).not.toBeInTheDocument(),
    );
    // Only the initial load plus this one pagination request — the loop
    // must not fetch a further page just because the net firstItemIndex
    // shift happened to be zero.
    expect(getTimelinePage).toHaveBeenCalledTimes(2);
  });

  it("keeps paginating past a live-tail-only response when the timeline started empty", async () => {
    // Regression test (Codex P2): the empty-start progress signal must be
    // evaluated fresh on every loop iteration, not captured once from
    // `messages.length` before the loop began. If a live `timeline:update`
    // races the in-flight request and lands first with only a new tail
    // message (no older content), a pagination response containing that
    // same single message would otherwise be misread as "the first page of
    // real history arrived" and stop the loop — stranding the user behind
    // an unfetched page of genuine older history despite `next_cursor`
    // still being non-null.
    getTimelinePage.mockResolvedValueOnce({ messages: [], next_cursor: "more" });

    let resolveRacedEmptyStartPage:
      | ((page: { messages: unknown[]; next_cursor: string | null }) => void)
      | undefined;
    getTimelinePage.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRacedEmptyStartPage = resolve;
      }),
    );
    renderChatShell();
    await waitFor(() => expect(getTimelinePage).toHaveBeenCalledTimes(2));

    // A live message arrives before this in-flight request's own response —
    // no older history, just a fresh tail message.
    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({ event_id: "$live", sender: "@alice:localhost", body: "live", timestamp_ms: 5 }),
        ],
      });
    });
    await screen.findByText("live");

    // The next page (once the loop continues past this one) finally
    // contributes genuine older history.
    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({
          event_id: "$old",
          sender: "@alice:localhost",
          body: "older text",
          timestamp_ms: 1,
        }),
        summary({ event_id: "$live", sender: "@alice:localhost", body: "live", timestamp_ms: 5 }),
      ],
      next_cursor: null,
    });
    // The pagination request itself resolves with only that same racing
    // message — identical to what the live update already applied, so no
    // real prepend occurred.
    act(() => {
      resolveRacedEmptyStartPage?.({
        messages: [
          summary({ event_id: "$live", sender: "@alice:localhost", body: "live", timestamp_ms: 5 }),
        ],
        next_cursor: "more",
      });
    });

    await screen.findByText("older text");
    // Initial empty page, the race-duplicate page, and the page that
    // finally adds real content.
    expect(getTimelinePage).toHaveBeenCalledTimes(3);
  });

  it("excludes every genuinely-prepended row from entrance animation when a prepend and a front-row removal land in the same snapshot", async () => {
    // Regression test: excluding leading rows from "fresh" (entrance
    // animation / jump-to-present) by a plain firstItemIndex diff
    // under-counts when an update both prepends history *and* drops the old
    // front row in the same snapshot (e.g. an UnableToDecrypt placeholder
    // resolving into a filtered-out type) — the diff is only the *net*
    // shift. Here two rows are prepended ($x, $y) while the old front row
    // ($undecryptable) disappears, so the net shift is only 1, but the
    // correct skip count is 2 (both $x and $y are old history, not new
    // arrivals) — using the net shift would incorrectly treat $y as fresh.
    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({
          event_id: "$undecryptable",
          sender: "@alice:localhost",
          body: "",
          is_undecrypted: true,
          timestamp_ms: 1,
        }),
        summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
      ],
      next_cursor: null,
    });
    renderChatShell();
    await screen.findByText("second");

    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({
            event_id: "$x",
            sender: "@alice:localhost",
            body: "prepended x",
            timestamp_ms: 0,
          }),
          summary({
            event_id: "$y",
            sender: "@alice:localhost",
            body: "prepended y",
            timestamp_ms: 0.5,
          }),
          summary({ event_id: "$b", sender: "@alice:localhost", body: "second", timestamp_ms: 2 }),
        ],
      });
    });

    await screen.findByText("prepended y");
    expect(document.getElementById("message-$x")?.className).not.toMatch(/animate-in/);
    expect(document.getElementById("message-$y")?.className).not.toMatch(/animate-in/);
  });

  it("ignores a pagination failure from a room the user has since left", async () => {
    // Regression test: the catch block set paginationError unconditionally,
    // without the same visitGenerationRef guard the success/finally paths
    // already had — so room A's failed request landing after the user
    // switched to room B could show "Couldn't load messages" for B despite
    // only A's request having failed.
    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({
          event_id: "$a",
          sender: "@alice:localhost",
          body: "room A msg",
          timestamp_ms: 1,
        }),
      ],
      next_cursor: "more",
    });
    const roomB: RoomSummary = makeRoomSummary({ room_id: "!roomB:localhost", name: "Room B" });
    const store = createStore();
    const { rerender } = render(
      <JotaiProvider store={store}>
        <ChatShell room={room} currentUserId="@me:localhost" />
      </JotaiProvider>,
    );
    await screen.findByText("room A msg");

    let rejectRoomAPage: ((err: Error) => void) | undefined;
    getTimelinePage.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectRoomAPage = reject;
      }),
    );
    fireStartReached();

    getTimelinePage.mockResolvedValue({
      messages: [
        summary({
          event_id: "$roomB",
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

    act(() => {
      rejectRoomAPage?.(new Error("room A network error"));
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Couldn't load messages")).not.toBeInTheDocument();
  });

  it("scrolls to the user's own new message after a successful slash command send", async () => {
    // Regression test: the "scroll to present on own send" fix only wired
    // Composer's onSubmit, but a slash command (e.g. /me, which sends an
    // emote the same way a plain send does) goes through onSlashCommand
    // instead — leaving a successfully-sent /me offscreen with no way back
    // to it while scrolled away.
    getTimelinePage.mockResolvedValue({
      messages: [
        summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
      ],
      next_cursor: null,
    });
    runCommand.mockResolvedValue({ status: "success" });
    renderChatShell();
    await screen.findByText("first");
    fireAtBottomStateChange(false);
    virtuosoScrollToIndexMock.mockClear();

    const composer = screen.getByPlaceholderText("Message general");
    fireEvent.change(composer, { target: { value: "/me waves" } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: false });

    await vi.waitFor(() =>
      expect(virtuosoScrollToIndexMock).toHaveBeenCalledWith(
        expect.objectContaining({ index: "LAST", align: "end" }),
      ),
    );
  });

  it("does not scroll for a successful slash command that isn't /me", async () => {
    // Regression test: most slash commands (/topic, /invite, /kick, /ban,
    // ...) can succeed without ever appending a RoomMessageSummary —
    // scrolling to bottom for one of those while scrolled up would yank the
    // user down for no reason.
    getTimelinePage.mockResolvedValue({
      messages: [
        summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
      ],
      next_cursor: null,
    });
    runCommand.mockResolvedValue({ status: "success" });
    renderChatShell();
    await screen.findByText("first");
    fireAtBottomStateChange(false);
    virtuosoScrollToIndexMock.mockClear();

    const composer = screen.getByPlaceholderText("Message general");
    fireEvent.change(composer, { target: { value: "/topic new topic" } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: false });

    await vi.waitFor(() => expect(runCommand).toHaveBeenCalled());
    expect(virtuosoScrollToIndexMock).not.toHaveBeenCalled();
  });

  it("does not scroll for a failed /me slash command", async () => {
    getTimelinePage.mockResolvedValue({
      messages: [
        summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
      ],
      next_cursor: null,
    });
    runCommand.mockResolvedValue({ status: "error", message: "not allowed" });
    renderChatShell();
    await screen.findByText("first");
    fireAtBottomStateChange(false);
    virtuosoScrollToIndexMock.mockClear();

    const composer = screen.getByPlaceholderText("Message general");
    fireEvent.change(composer, { target: { value: "/me waves" } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: false });

    await screen.findByText("not allowed");
    expect(virtuosoScrollToIndexMock).not.toHaveBeenCalled();
  });

  it("does not scroll when sending a message fails before any local echo is created", async () => {
    // Regression test: `handleComposerSubmit`'s underlying `sendMessage`
    // call can reject (network/validation error) before any local echo is
    // ever created. Scrolling to bottom unconditionally in that case yanks
    // a user who was reading history down for a message that never
    // actually appeared.
    getTimelinePage.mockResolvedValue({
      messages: [
        summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
      ],
      next_cursor: null,
    });
    sendMessage.mockRejectedValueOnce(new Error("network error"));
    renderChatShell();
    await screen.findByText("first");
    fireAtBottomStateChange(false);
    virtuosoScrollToIndexMock.mockClear();

    sendDraft("this will fail");

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(virtuosoScrollToIndexMock).not.toHaveBeenCalled();
  });

  it("does not scroll a different room the user has since switched to when a stale send resolves", async () => {
    // Regression test: if a send from room A resolves *after* the user has
    // already switched to room B, `virtuosoRef` now points at B's (freshly
    // remounted) Virtuoso instance — scrolling unconditionally would move
    // B's view and mark it at-bottom/read for a message that landed in A,
    // not B.
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
    let resolveSend: ((txnId: string) => void) | undefined;
    sendMessage.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSend = resolve;
      }),
    );
    const roomB: RoomSummary = makeRoomSummary({ room_id: "!roomB:localhost", name: "Room B" });
    const store = createStore();
    const { rerender } = render(
      <JotaiProvider store={store}>
        <ChatShell room={room} currentUserId="@me:localhost" />
      </JotaiProvider>,
    );
    await screen.findByText("room A msg");
    fireAtBottomStateChange(false);

    const composer = screen.getByPlaceholderText(`Message ${room.name}`);
    fireEvent.change(composer, { target: { value: "stale send" } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: false });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());

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
    virtuosoScrollToIndexMock.mockClear();

    act(() => {
      resolveSend?.("txn-1");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(virtuosoScrollToIndexMock).not.toHaveBeenCalled();
  });

  it("gives the Virtuoso element a bounded flex height to fill the chat pane", async () => {
    // Regression test: the old scroller was itself the `flex-1
    // overflow-y-auto` child of the chat pane. Without `flex-1` on the new
    // Virtuoso element, it has no bounded height to size its internal
    // scroll area against — in a room with enough messages to scroll, it
    // could grow to fit its own content instead of owning the remaining
    // pane, breaking viewport measurement and potentially pushing the
    // composer offscreen.
    getTimelinePage.mockResolvedValue({
      messages: [
        summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
      ],
      next_cursor: null,
    });
    renderChatShell();
    await screen.findByText("first");

    expect(screen.getByTestId("fake-virtuoso").className).toMatch(/\bflex-1\b/);
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

  it("does not animate any row on initial room load", async () => {
    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({ event_id: "$one:localhost", sender: "@alice:localhost", body: "hi" }),
        summary({ event_id: "$two:localhost", sender: "@alice:localhost", body: "there" }),
      ],
      next_cursor: null,
    });
    renderChatShell();

    await screen.findByText("hi");
    expect(document.getElementById("message-$one:localhost")?.className).not.toMatch(/animate-in/);
    expect(document.getElementById("message-$two:localhost")?.className).not.toMatch(/animate-in/);
  });

  it("animates a message that arrives after the initial load", async () => {
    renderChatShell();
    await screen.findByText("No messages yet");

    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({ event_id: "$fresh:localhost", sender: "@alice:localhost", body: "surprise" }),
        ],
      });
    });

    await screen.findByText("surprise");
    expect(document.getElementById("message-$fresh:localhost")?.className).toMatch(/animate-in/);
  });

  it("re-runs the seed dance when a room is closed and the same room id is reopened", async () => {
    // Regression test: closing a room (activeRoomId -> null) then reopening
    // the *same* room id must reseed from scratch, not skip straight to
    // diffing against the previous visit's stale seenRowKeysRef.
    getTimelinePage.mockResolvedValueOnce({
      messages: [summary({ event_id: "$one:localhost", sender: "@alice:localhost", body: "hi" })],
      next_cursor: null,
    });
    const store = createStore();
    const { rerender } = renderChatShell(store);
    await screen.findByText("hi");
    expect(document.getElementById("message-$one:localhost")?.className).not.toMatch(/animate-in/);

    rerender(
      <JotaiProvider store={store}>
        <ChatShell room={null} currentUserId="@me:localhost" />
      </JotaiProvider>,
    );
    await screen.findByText("Select a room to start chatting");

    // Reopen the same room; it now has an extra message that "arrived"
    // while it was closed. Neither row should animate — this is a normal
    // initial load, not a live arrival.
    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({ event_id: "$one:localhost", sender: "@alice:localhost", body: "hi" }),
        summary({ event_id: "$two:localhost", sender: "@alice:localhost", body: "there" }),
      ],
      next_cursor: null,
    });
    rerender(
      <JotaiProvider store={store}>
        <ChatShell room={room} currentUserId="@me:localhost" />
      </JotaiProvider>,
    );

    await screen.findByText("there");
    expect(document.getElementById("message-$one:localhost")?.className).not.toMatch(/animate-in/);
    expect(document.getElementById("message-$two:localhost")?.className).not.toMatch(/animate-in/);
  });

  it("does not replay the entrance animation when an own message's local echo is acked", async () => {
    renderChatShell();
    await screen.findByText("No messages yet");

    sendDraft("hello");
    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({
            event_id: "txn-2",
            sender: "@me:localhost",
            body: "hello",
            transaction_id: "txn-2",
            send_state: { state: "pending" },
          }),
        ],
      });
    });
    await screen.findByText(/sending…/);

    // Matches the real backend behavior (see timeline.rs's
    // `build_message_summary`): `transaction_id` goes back to `None` once
    // the homeserver echo replaces the local item, so `messageRowKey`
    // (transaction_id ?? event_id) changes from "txn-2" to the real event
    // id on ack — this is the exact transition that could otherwise be
    // mistaken for a brand-new row and replay the entrance animation.
    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({
            event_id: "$acked:localhost",
            sender: "@me:localhost",
            body: "hello",
            transaction_id: null,
            send_state: { state: "sent" },
          }),
        ],
      });
    });

    await screen.findByText("hello");
    expect(document.getElementById("message-$acked:localhost")?.className).not.toMatch(
      /animate-in/,
    );
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

  it("shows a 'Read by {name}' tooltip when hovering a read-receipt chip", async () => {
    renderChatShell();
    await vi.waitFor(() => expect(timelineUpdateCallback).toBeDefined());

    act(() => {
      timelineUpdateCallback?.({
        room_id: room.room_id,
        messages: [
          summary({
            event_id: "$from-alice",
            sender: "@alice:localhost",
            sender_display_name: "Alice",
            body: "hello from alice",
            timestamp_ms: 1,
          }),
          summary({ event_id: "$b", sender: "@me:localhost", body: "hi", timestamp_ms: 2 }),
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

    // Distinguishes the read-receipt chip from Alice's own (also "AL")
    // sender-avatar initials elsewhere on the row — the chip is the small
    // 14px span, the sender avatar renders inside a size-8 Avatar.
    const chip = (await screen.findAllByText("AL")).find((el) =>
      el.className.includes("text-[7px]"),
    );
    if (!chip) throw new Error("read-receipt chip not found");
    // Real DOM focus (not `fireEvent.focus`, which dispatches a plain
    // non-bubbling `focus` event that React's `focusin`-based delegation
    // never sees) — the chip is `tabIndex={0}` specifically so keyboard/
    // screen-reader users can reach it, and Radix's TooltipTrigger opens
    // instantly on focus, which doubles as the simplest reliable way to
    // exercise the Radix wiring here without simulating pointer hover.
    await act(async () => {
      chip.focus();
      // Radix's Tooltip Presence/Portal content needs a tick beyond the
      // synchronous `open` state flip to actually mount into the portal.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getAllByText(/Read by Alice/).length).toBeGreaterThan(0);
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
    mockUseAdaptiveLayout.mockReturnValue("mobile");
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
    const composer = screen.getByTestId("composer-shell");
    expect(bar.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  it("excludes the current user from the following-the-conversation bar", async () => {
    getRoomMembers.mockResolvedValueOnce([
      {
        user_id: "@me:localhost",
        display_name: "Me",
        avatar_url: null,
        power_level: 0,
        membership: "join",
      },
      {
        user_id: "@alice:localhost",
        display_name: "Alice",
        avatar_url: null,
        power_level: 0,
        membership: "join",
      },
    ]);
    renderChatShell();

    expect(
      await screen.findByRole("button", {
        name: "Alice is following the conversation",
      }),
    ).toBeInTheDocument();
  });

  it("hides the following-the-conversation bar in a solo room with only the current user", async () => {
    getRoomMembers.mockResolvedValueOnce([
      {
        user_id: "@me:localhost",
        display_name: "Me",
        avatar_url: null,
        power_level: 0,
        membership: "join",
      },
    ]);
    renderChatShell();

    await waitFor(() => expect(getRoomMembers).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: /following the conversation/ }),
    ).not.toBeInTheDocument();
  });

  it("freezes the unread divider above the message that was first unread, not a live index", async () => {
    const unreadRoom = makeRoomSummary({ unread_messages: 1 });
    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({ event_id: "$a", sender: "@alice:localhost", body: "one", timestamp_ms: 1 }),
        summary({ event_id: "$b", sender: "@alice:localhost", body: "two", timestamp_ms: 2 }),
      ],
      next_cursor: null,
    });
    renderChatShell(createStore(), unreadRoom);

    await screen.findByText("New messages");
    const messageA = document.getElementById("message-$a") as HTMLElement;
    const messageB = document.getElementById("message-$b") as HTMLElement;
    const divider = screen.getByText("New messages");
    // Divider sits between $a and $b.
    expect(isBefore(messageA, divider)).toBe(true);
    expect(isBefore(divider, messageB)).toBe(true);

    // A new message arrives while the room stays open — a naive live
    // recompute (messages.length - frozen count) would move the divider to
    // sit above this new message instead of staying above $b.
    act(() => {
      timelineUpdateCallback?.({
        room_id: unreadRoom.room_id,
        messages: [
          summary({ event_id: "$a", sender: "@alice:localhost", body: "one", timestamp_ms: 1 }),
          summary({ event_id: "$b", sender: "@alice:localhost", body: "two", timestamp_ms: 2 }),
          summary({ event_id: "$c", sender: "@alice:localhost", body: "three", timestamp_ms: 3 }),
        ],
      });
    });

    await screen.findByText("three");
    expect(screen.getAllByText("New messages")).toHaveLength(1);
    const dividerAfterUpdate = screen.getByText("New messages");
    const messageAAfter = document.getElementById("message-$a") as HTMLElement;
    const messageBAfter = document.getElementById("message-$b") as HTMLElement;
    expect(isBefore(messageAAfter, dividerAfterUpdate)).toBe(true);
    expect(isBefore(dividerAfterUpdate, messageBAfter)).toBe(true);
  });

  it("still shows the unread divider in a room whose newest page was empty and had to auto-paginate to find content", async () => {
    // Regression test: seeding the unread-divider boundary (and the
    // entrance-animation seen-set) used to run as soon as `!loading`, which
    // could fire while `messages` was still empty — the newest page having
    // zero renderable rows but more history behind it (see the empty-first-
    // page auto-pagination effect). That permanently froze the unread
    // boundary against an empty snapshot, so the room's *real* first batch
    // (whenever auto-pagination found it) rendered with no divider at all,
    // even though the room genuinely has unread messages.
    const unreadRoom = makeRoomSummary({ unread_messages: 1 });
    getTimelinePage.mockResolvedValueOnce({ messages: [], next_cursor: "more" });
    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({ event_id: "$a", sender: "@alice:localhost", body: "one", timestamp_ms: 1 }),
        summary({ event_id: "$b", sender: "@alice:localhost", body: "two", timestamp_ms: 2 }),
      ],
      next_cursor: null,
    });
    renderChatShell(createStore(), unreadRoom);

    await screen.findByText("New messages");
    const messageA = document.getElementById("message-$a") as HTMLElement;
    const messageB = document.getElementById("message-$b") as HTMLElement;
    const divider = screen.getByText("New messages");
    expect(isBefore(messageA, divider)).toBe(true);
    expect(isBefore(divider, messageB)).toBe(true);
  });

  it("does not entrance-animate a room's real first batch after auto-pagination past an empty newest page", async () => {
    const unreadRoom = makeRoomSummary({ unread_messages: 0 });
    getTimelinePage.mockResolvedValueOnce({ messages: [], next_cursor: "more" });
    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({
          event_id: "$a",
          sender: "@alice:localhost",
          body: "older text",
          timestamp_ms: 1,
        }),
      ],
      next_cursor: null,
    });
    renderChatShell(createStore(), unreadRoom);

    await screen.findByText("older text");
    expect(document.getElementById("message-$a")?.className).not.toMatch(/animate-in/);
  });

  it("breaks a same-sender message group across the unread divider", async () => {
    const unreadRoom = makeRoomSummary({ unread_messages: 1 });
    getTimelinePage.mockResolvedValueOnce({
      messages: [
        summary({
          event_id: "$a",
          sender: "@alice:localhost",
          sender_display_name: "Alice",
          body: "one",
          timestamp_ms: 1,
        }),
        summary({
          event_id: "$b",
          sender: "@alice:localhost",
          sender_display_name: "Alice",
          body: "two",
          timestamp_ms: 2,
        }),
      ],
      next_cursor: null,
    });
    renderChatShell(createStore(), unreadRoom);

    await screen.findByText("New messages");
    // Same sender on both sides of the divider — without the group break,
    // message $b (right after the divider) would render without its own
    // avatar/name, looking like a continuation of $a's group above it.
    expect(screen.getAllByText("Alice")).toHaveLength(2);
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

  it("clicking a reply preview scrolls the virtualizer to the replied-to message's plain array index", async () => {
    // Regression test: the reply-preview "jump to the replied-to message"
    // click used to be a plain `document.getElementById(...).scrollIntoView`
    // — that only ever worked because every message was permanently mounted
    // in the old flat `.map()`. Under Virtuoso, a loaded-but-offscreen
    // message has no DOM node to find, so ChatShell now looks up the
    // target's position in `messages` and calls `scrollToIndex` directly.
    // Uses the *plain* 0-based array index, not `firstItemIndex + index` —
    // unlike the numbering `itemContent`/`computeItemKey` receive,
    // `scrollToIndex`'s numeric `index` is clamped against `data.length`
    // directly; an earlier version passed the `firstItemIndex`-offset value
    // here (matching the reasoning that led to the jump-to-present pill's
    // "LAST" fix), which is a huge, always-out-of-range number that
    // Virtuoso's own clamping silently resolved to the *last* item — every
    // reply jump landed on the newest message instead of the replied-to one.
    getTimelinePage.mockResolvedValue({
      messages: [
        summary({ event_id: "$original", sender: "@me:localhost", body: "the original" }),
        summary({
          event_id: "$reply",
          sender: "@alice:localhost",
          body: "hi back",
          in_reply_to: {
            event_id: "$original",
            sender: "@me:localhost",
            sender_display_name: null,
            preview: "the original",
          },
        }),
      ],
      next_cursor: null,
    });
    renderChatShell();
    await screen.findByText("hi back");

    fireEvent.click(screen.getByRole("button", { name: /the original/ }));

    expect(virtuosoScrollToIndexMock).toHaveBeenCalledWith(
      expect.objectContaining({ index: 0, align: "center" }),
    );
  });

  it("does not scroll when clicking a reply preview whose target isn't in the currently-loaded messages", async () => {
    getTimelinePage.mockResolvedValue({
      messages: [
        summary({
          event_id: "$reply",
          sender: "@alice:localhost",
          body: "hi back",
          in_reply_to: {
            event_id: "$not-loaded",
            sender: "@me:localhost",
            sender_display_name: null,
            preview: "long gone",
          },
        }),
      ],
      next_cursor: null,
    });
    renderChatShell();
    await screen.findByText("hi back");
    virtuosoScrollToIndexMock.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /long gone/ }));

    expect(virtuosoScrollToIndexMock).not.toHaveBeenCalled();
  });

  it("keys virtualized rows by message identity, not position", async () => {
    // Regression test: without `computeItemKey`, Virtuoso keys rendered rows
    // by their current index. A full `timeline:update` snapshot can remove
    // an item from the *middle* of `messages` (e.g. an `UnableToDecrypt`
    // placeholder resolves into a msgtype `RoomMessageSummary` filters out
    // entirely), shifting every later message's index by one — index-keyed
    // rows would then have every later message inherit the previous row's
    // React state and Virtuoso's measurement cache instead of getting a
    // fresh mount. `computeItemKey` must return the same identity
    // (`messageRowKey`) `ChatShell` already uses elsewhere for this exact
    // purpose (the entrance-animation seen-set, the fake Virtuoso's own
    // React keys in this test file).
    getTimelinePage.mockResolvedValue({
      messages: [
        summary({ event_id: "$a", sender: "@alice:localhost", body: "first", timestamp_ms: 1 }),
      ],
      next_cursor: null,
    });
    renderChatShell();
    await screen.findByText("first");

    expect(virtuosoComputeItemKey).toBeDefined();
    expect(
      virtuosoComputeItemKey?.(
        0,
        summary({ event_id: "$a", sender: "@alice:localhost", body: "first" }),
        undefined,
      ),
    ).toBe("$a");
    // Own message identity is keyed by its (still-local) transaction id, not
    // its eventual event id — same as `messageRowKey` everywhere else.
    expect(
      virtuosoComputeItemKey?.(
        0,
        summary({
          event_id: "$b",
          sender: "@me:localhost",
          body: "pending",
          transaction_id: "txn-1",
        }),
        undefined,
      ),
    ).toBe("txn-1");
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

    const text = await screen.findByText("click here");

    expect(text.tagName).toBe("SPAN");
    expect(screen.queryByRole("link", { name: "click here" })).toBeNull();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("renders a relative or fragment link as non-interactive text", async () => {
    // Regression test: an earlier version resolved `href` against
    // `window.location.href` before checking its scheme, which turned a
    // relative path into an absolute `http(s)` URL and opened it via
    // `openUrl`. Relative and fragment hrefs are now rendered as plain text
    // so the webview cannot navigate away from the chat.
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

    const text = await screen.findByText("click here");

    expect(text.tagName).toBe("SPAN");
    expect(screen.queryByRole("link", { name: "click here" })).toBeNull();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("dispatches the layout component matching the messageLayout appearance setting", async () => {
    getTimelinePage.mockResolvedValue({
      messages: [
        summary({
          event_id: "$msg:localhost",
          sender: "@alice:localhost",
          sender_display_name: "Alice",
          body: "hi there",
          timestamp_ms: Date.now(),
        }),
      ],
      next_cursor: null,
    });

    const store = createStore();
    store.set(messageLayoutAtom, "irc");
    renderChatShell(store);

    // IRC mode's distinguishing structure: `<nick>` prefix, not a bubble.
    expect(await screen.findByText("<Alice>")).toBeInTheDocument();
  });
});
