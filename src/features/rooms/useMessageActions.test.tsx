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

vi.mock("@/lib/matrix", () => ({
  addBookmark: (...args: unknown[]) => mockAddBookmark(...args),
  removeBookmark: (...args: unknown[]) => mockRemoveBookmark(...args),
  listBookmarks: () => mockListBookmarks(),
  discardFailedMessage: vi.fn(),
  redactEvent: (...args: unknown[]) => mockRedactEvent(...args),
  resendMessage: vi.fn(),
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
  const queryClient = new QueryClient();
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
  beforeEach(() => {
    mockAddBookmark.mockReset().mockResolvedValue(undefined);
    mockRemoveBookmark.mockReset().mockResolvedValue(undefined);
    mockListBookmarks.mockReset().mockResolvedValue([]);
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
    mockListBookmarks.mockResolvedValue([
      { room_id: "!room:localhost", event_id: "$a", saved_at_ms: 1 } as BookmarkEntry,
    ]);
    const { result } = setup("!room:localhost");
    await waitFor(() => expect(result.current.bookmarkedEventIds.has("$a")).toBe(true));

    await act(async () => {
      await result.current.handleUnbookmark("$a");
    });

    expect(mockRemoveBookmark).toHaveBeenCalledWith("$a");
    expect(result.current.bookmarkedEventIds.has("$a")).toBe(false);
  });

  it("rolls back the optimistic unbookmark if remove_bookmark fails", async () => {
    mockListBookmarks.mockResolvedValue([
      { room_id: "!room:localhost", event_id: "$a", saved_at_ms: 1 } as BookmarkEntry,
    ]);
    mockRemoveBookmark.mockRejectedValue(new Error("network error"));
    const { result } = setup("!room:localhost");
    await waitFor(() => expect(result.current.bookmarkedEventIds.has("$a")).toBe(true));

    await act(async () => {
      await result.current.handleUnbookmark("$a");
    });

    expect(result.current.bookmarkedEventIds.has("$a")).toBe(true);
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
});
