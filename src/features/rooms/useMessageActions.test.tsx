import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMessageActions } from "./useMessageActions";
import type { BookmarkEntry, RoomMessageSummary } from "@/lib/matrix";

const mockAddBookmark = vi.fn();
const mockRemoveBookmark = vi.fn();
const mockListBookmarks = vi.fn<() => Promise<BookmarkEntry[]>>();
const mockToggleReaction = vi.fn();
const mockRedactEvent = vi.fn();
const mockResendMessage = vi.fn();
const mockDiscardFailedMessage = vi.fn();

vi.mock("@/lib/matrix", () => ({
  addBookmark: (...args: unknown[]) => mockAddBookmark(...args),
  removeBookmark: (...args: unknown[]) => mockRemoveBookmark(...args),
  listBookmarks: () => mockListBookmarks(),
  discardFailedMessage: (...args: unknown[]) => mockDiscardFailedMessage(...args),
  redactEvent: (...args: unknown[]) => mockRedactEvent(...args),
  resendMessage: (...args: unknown[]) => mockResendMessage(...args),
  toggleReaction: (...args: unknown[]) => mockToggleReaction(...args),
}));

// The `bookmarks` flag defaults on here — this file exercises the bookmark
// behavior itself; flag-off gating is covered separately.
vi.mock("@/featureFlags", () => ({ useFlag: () => true }));

function setup(
  roomId: string | null = "!room:localhost",
  overrides: Partial<{
    setReplyTarget: (reply: unknown) => void;
    setEditingEventId: (eventId: string | null) => void;
  }> = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(
    () =>
      useMessageActions({
        roomId,
        setReplyTarget: overrides.setReplyTarget ?? vi.fn(),
        setEditingEventId: overrides.setEditingEventId ?? vi.fn(),
      }),
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    },
  );
}

function makeMessage(overrides: Partial<RoomMessageSummary> = {}): RoomMessageSummary {
  return {
    event_id: "$msg",
    sender: "@alice:localhost",
    sender_display_name: "Alice",
    body: "hello",
    ...overrides,
  } as RoomMessageSummary;
}

describe("useMessageActions bookmarks (Spec 12)", () => {
  // `handleBookmark`/`handleUnbookmark` invalidate the shared bookmarks
  // query, which refetches via `listBookmarks` — real `add_bookmark`/
  // `remove_bookmark` calls mutate the same server-side list that
  // `list_bookmarks` then reads back, so this in-memory array keeps the
  // mock consistent with that real round trip instead of refetching a
  // canned response that doesn't reflect the just-made change.
  let serverBookmarks: BookmarkEntry[] = [];

  beforeEach(() => {
    serverBookmarks = [];
    mockAddBookmark.mockReset().mockImplementation((roomId: string, eventId: string) => {
      serverBookmarks.push({
        room_id: roomId,
        event_id: eventId,
        saved_at_ms: Date.now(),
        sender: "",
        sender_display_name: null,
        body_preview: "",
        timestamp_ms: Date.now(),
      } as BookmarkEntry);
      return Promise.resolve();
    });
    mockRemoveBookmark.mockReset().mockImplementation((eventId: string) => {
      serverBookmarks = serverBookmarks.filter((b) => b.event_id !== eventId);
      return Promise.resolve();
    });
    mockListBookmarks.mockReset().mockImplementation(() => Promise.resolve(serverBookmarks));
  });

  it("seeds bookmarkedEventIds from list_bookmarks, scoped to the active room", async () => {
    mockListBookmarks.mockResolvedValue([
      { room_id: "!room:localhost", event_id: "$a", saved_at_ms: 1 } as BookmarkEntry,
      { room_id: "!other:localhost", event_id: "$b", saved_at_ms: 2 } as BookmarkEntry,
    ]);

    const { result } = setup("!room:localhost");

    await waitFor(() => expect(result.current.bookmarkedEventIds.has("$a")).toBe(true));
    expect(result.current.bookmarkedEventIds.has("$b")).toBe(false);
  });

  it("optimistically marks a message bookmarked and calls addBookmark", async () => {
    const { result } = setup("!room:localhost");
    await waitFor(() => expect(mockListBookmarks).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleBookmark("$new");
    });

    expect(mockAddBookmark).toHaveBeenCalledWith("!room:localhost", "$new");
    expect(result.current.bookmarkedEventIds.has("$new")).toBe(true);
  });

  it("rolls back the optimistic bookmark if add_bookmark fails", async () => {
    mockAddBookmark.mockRejectedValue(new Error("not loaded"));
    const { result } = setup("!room:localhost");
    await waitFor(() => expect(mockListBookmarks).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleBookmark("$new");
    });

    expect(result.current.bookmarkedEventIds.has("$new")).toBe(false);
  });

  it("optimistically unmarks a message and calls removeBookmark", async () => {
    serverBookmarks = [
      { room_id: "!room:localhost", event_id: "$a", saved_at_ms: 1 } as BookmarkEntry,
    ];
    const { result } = setup("!room:localhost");
    await waitFor(() => expect(result.current.bookmarkedEventIds.has("$a")).toBe(true));

    await act(async () => {
      await result.current.handleUnbookmark("$a");
    });

    expect(mockRemoveBookmark).toHaveBeenCalledWith("$a");
    // react-query's post-invalidate refetch notification can land in a
    // microtask outside what a single `act()` flush picks up, so assert
    // via `waitFor` rather than immediately after `act` resolves.
    await waitFor(() => expect(result.current.bookmarkedEventIds.has("$a")).toBe(false));
  });

  it("rolls back the optimistic unbookmark if remove_bookmark fails", async () => {
    serverBookmarks = [
      { room_id: "!room:localhost", event_id: "$a", saved_at_ms: 1 } as BookmarkEntry,
    ];
    mockRemoveBookmark.mockRejectedValue(new Error("network error"));
    const { result } = setup("!room:localhost");
    await waitFor(() => expect(result.current.bookmarkedEventIds.has("$a")).toBe(true));

    await act(async () => {
      await result.current.handleUnbookmark("$a");
    });

    expect(result.current.bookmarkedEventIds.has("$a")).toBe(true);
  });

  it("restores the pre-optimistic bookmarks list if remove_bookmark fails and the recovery refetch also fails", async () => {
    serverBookmarks = [
      { room_id: "!room:localhost", event_id: "$a", saved_at_ms: 1 } as BookmarkEntry,
    ];
    mockRemoveBookmark.mockRejectedValue(new Error("network error"));
    const { result } = setup("!room:localhost");
    await waitFor(() => expect(result.current.bookmarkedEventIds.has("$a")).toBe(true));

    // The recovery refetch triggered inside handleUnbookmark's catch block
    // also fails here (not just remove_bookmark itself) — exercises the
    // fallback that restores the pre-optimistic-removal snapshot directly
    // via setQueryData rather than relying on that refetch to reconcile it.
    mockListBookmarks.mockRejectedValueOnce(new Error("also down"));

    await act(async () => {
      await result.current.handleUnbookmark("$a");
    });

    await waitFor(() => expect(result.current.bookmarkedEventIds.has("$a")).toBe(true));
  });

  it("does not overwrite the bookmarks cache with undefined when the pre-optimistic snapshot was itself undefined (Sentry review fix)", async () => {
    // `bookmarks` (and so the `previous` snapshot `handleUnbookmark` captures
    // at call time) is `undefined` whenever the query has no data yet — e.g.
    // its initial fetch failed, or (per the review finding) it raced a
    // room-close that disabled the query. Simulate that with a
    // permanently-failing `listBookmarks`, so the initial fetch never
    // populates `bookmarks` at all.
    mockListBookmarks.mockReset().mockRejectedValue(new Error("down"));
    mockRemoveBookmark.mockRejectedValue(new Error("network error"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () =>
        useMessageActions({
          roomId: "!room:localhost",
          setReplyTarget: vi.fn(),
          setEditingEventId: vi.fn(),
        }),
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
      },
    );
    await waitFor(() => expect(mockListBookmarks).toHaveBeenCalled());
    expect(result.current.bookmarkedEventIds.size).toBe(0);

    // remove_bookmark fails, and the recovery refetch (also `listBookmarks`)
    // fails too, so the catch block's fallback runs with `previous ===
    // undefined`.
    await act(async () => {
      await result.current.handleUnbookmark("$a");
    });

    const cached = queryClient.getQueryData<BookmarkEntry[]>(["bookmarks"]);
    // Before the fix, the fallback unconditionally called
    // `setQueryData(BOOKMARKS_QUERY_KEY, previous)` with `previous ===
    // undefined`, clobbering whatever the optimistic removal above had just
    // written (`[]`) back to `undefined`.
    expect(cached).toEqual([]);
  });

  it("clears bookmarkedEventIds when there is no active room", async () => {
    const { result } = setup(null);
    expect(result.current.bookmarkedEventIds.size).toBe(0);
    expect(mockListBookmarks).not.toHaveBeenCalled();
  });

  it("does nothing when bookmarking with no active room", async () => {
    const { result } = setup(null);

    await act(async () => {
      await result.current.handleBookmark("$new");
    });

    expect(mockAddBookmark).not.toHaveBeenCalled();
  });
});

describe("useMessageActions other handlers", () => {
  beforeEach(() => {
    mockListBookmarks.mockReset().mockResolvedValue([]);
    mockToggleReaction.mockReset();
    mockRedactEvent.mockReset();
    mockResendMessage.mockReset();
    mockDiscardFailedMessage.mockReset();
  });

  it("sets the reply target from a message", () => {
    const setReplyTarget = vi.fn();
    const { result } = setup("!room:localhost", { setReplyTarget });

    result.current.handleReply(makeMessage({ event_id: "$msg", body: "hi" }));

    expect(setReplyTarget).toHaveBeenCalledWith({
      event_id: "$msg",
      sender: "@alice:localhost",
      sender_display_name: "Alice",
      preview: "hi",
    });
  });

  it("clears the reply target and sets the editing event id on edit", () => {
    const setReplyTarget = vi.fn();
    const setEditingEventId = vi.fn();
    const { result } = setup("!room:localhost", { setReplyTarget, setEditingEventId });

    result.current.handleEdit("$msg");

    expect(setReplyTarget).toHaveBeenCalledWith(null);
    expect(setEditingEventId).toHaveBeenCalledWith("$msg");
  });

  it("toggles a reaction via toggleReaction", async () => {
    mockToggleReaction.mockResolvedValue(undefined);
    const { result } = setup("!room:localhost");

    await act(async () => {
      await result.current.handleToggleReaction("$msg", "👍");
    });

    expect(mockToggleReaction).toHaveBeenCalledWith("!room:localhost", "$msg", "👍");
  });

  it("swallows a toggleReaction failure", async () => {
    mockToggleReaction.mockRejectedValue(new Error("network error"));
    const { result } = setup("!room:localhost");

    await act(async () => {
      await result.current.handleToggleReaction("$msg", "👍");
    });

    expect(mockToggleReaction).toHaveBeenCalled();
  });

  it("redacts a message and reports success", async () => {
    mockRedactEvent.mockResolvedValue(undefined);
    const { result } = setup("!room:localhost");

    const succeeded = await result.current.handleDelete("$msg", "spam");

    expect(mockRedactEvent).toHaveBeenCalledWith("!room:localhost", "$msg", "spam");
    expect(succeeded).toBe(true);
  });

  it("reports failure when redactEvent rejects", async () => {
    mockRedactEvent.mockRejectedValue(new Error("forbidden"));
    const { result } = setup("!room:localhost");

    const succeeded = await result.current.handleDelete("$msg");

    expect(succeeded).toBe(false);
  });

  it("does nothing when deleting with no active room", async () => {
    const { result } = setup(null);

    const succeeded = await result.current.handleDelete("$msg");

    expect(succeeded).toBe(false);
    expect(mockRedactEvent).not.toHaveBeenCalled();
  });

  it("resends a failed message via resendMessage", async () => {
    mockResendMessage.mockResolvedValue(undefined);
    const { result } = setup("!room:localhost");

    await act(async () => {
      await result.current.handleResend("txn-1");
    });

    expect(mockResendMessage).toHaveBeenCalledWith("!room:localhost", "txn-1");
  });

  it("swallows a resendMessage failure", async () => {
    mockResendMessage.mockRejectedValue(new Error("still failing"));
    const { result } = setup("!room:localhost");

    await act(async () => {
      await result.current.handleResend("txn-1");
    });

    expect(mockResendMessage).toHaveBeenCalled();
  });

  it("does nothing when resending with no active room", async () => {
    const { result } = setup(null);

    await act(async () => {
      await result.current.handleResend("txn-1");
    });

    expect(mockResendMessage).not.toHaveBeenCalled();
  });

  it("discards a failed message's local echo via discardFailedMessage", async () => {
    mockDiscardFailedMessage.mockResolvedValue(undefined);
    const { result } = setup("!room:localhost");

    await act(async () => {
      await result.current.handleDiscard("txn-1");
    });

    expect(mockDiscardFailedMessage).toHaveBeenCalledWith("!room:localhost", "txn-1");
  });

  it("swallows a discardFailedMessage failure", async () => {
    mockDiscardFailedMessage.mockRejectedValue(new Error("already gone"));
    const { result } = setup("!room:localhost");

    await act(async () => {
      await result.current.handleDiscard("txn-1");
    });

    expect(mockDiscardFailedMessage).toHaveBeenCalled();
  });

  it("does nothing when discarding with no active room", async () => {
    const { result } = setup(null);

    await act(async () => {
      await result.current.handleDiscard("txn-1");
    });

    expect(mockDiscardFailedMessage).not.toHaveBeenCalled();
  });
});
