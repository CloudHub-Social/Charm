import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SavedMessagesPanel } from "./SavedMessagesPanel";
import type { BookmarkEntry, RoomSummary } from "@/lib/matrix";
import { renderWithProviders } from "@/test/renderWithProviders";

const listBookmarks = vi.fn();
const listRooms = vi.fn();
const removeBookmark = vi.fn();

vi.mock("@/lib/matrix", () => ({
  listBookmarks: (...args: unknown[]) => listBookmarks(...args),
  listRooms: (...args: unknown[]) => listRooms(...args),
  removeBookmark: (...args: unknown[]) => removeBookmark(...args),
}));

function makeRoom(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    room_id: "!room:localhost",
    name: "Room",
    ...overrides,
  } as RoomSummary;
}

function makeBookmark(overrides: Partial<BookmarkEntry> = {}): BookmarkEntry {
  return {
    room_id: "!room:localhost",
    event_id: "$a",
    saved_at_ms: 1000,
    sender: "@alice:localhost",
    sender_display_name: "Alice",
    body_preview: "hello there",
    timestamp_ms: 900,
    ...overrides,
  };
}

describe("SavedMessagesPanel", () => {
  beforeEach(() => {
    listBookmarks.mockReset();
    listRooms.mockReset().mockResolvedValue([makeRoom()]);
    removeBookmark.mockReset().mockResolvedValue(undefined);
  });

  it("shows an empty state when there are no bookmarks", async () => {
    listBookmarks.mockResolvedValue([]);
    renderWithProviders(<SavedMessagesPanel onJumpToMessage={vi.fn()} />);

    expect(
      await screen.findByText("Bookmark a message from its action menu to save it here."),
    ).toBeInTheDocument();
  });

  it("renders bookmarks in list_bookmarks' own order with room context", async () => {
    // The Rust `list_bookmarks` command already sorts newest-saved-first
    // (Spec 12) — this asserts the panel renders that order verbatim
    // rather than re-sorting it itself.
    listBookmarks.mockResolvedValue([
      makeBookmark({ event_id: "$newer", saved_at_ms: 2000, body_preview: "newer message" }),
      makeBookmark({ event_id: "$older", saved_at_ms: 1000, body_preview: "older message" }),
    ]);
    renderWithProviders(<SavedMessagesPanel onJumpToMessage={vi.fn()} />);

    await screen.findByText("older message");
    const previews = screen.getAllByText(/message$/).map((el) => el.textContent);
    expect(previews).toEqual(["newer message", "older message"]);
    expect(screen.getAllByText("Room")).toHaveLength(2);
  });

  it("falls back to the bare room id when the room isn't in the current room list", async () => {
    listRooms.mockResolvedValue([]);
    listBookmarks.mockResolvedValue([makeBookmark({ room_id: "!left-room:localhost" })]);
    renderWithProviders(<SavedMessagesPanel onJumpToMessage={vi.fn()} />);

    expect(await screen.findByText("!left-room:localhost")).toBeInTheDocument();
  });

  it("calls onJumpToMessage with the bookmark's room and event id when clicked", async () => {
    const onJumpToMessage = vi.fn();
    listBookmarks.mockResolvedValue([makeBookmark({ room_id: "!room:localhost", event_id: "$a" })]);
    renderWithProviders(<SavedMessagesPanel onJumpToMessage={onJumpToMessage} />);

    fireEvent.click(await screen.findByText("hello there"));

    expect(onJumpToMessage).toHaveBeenCalledWith("!room:localhost", "$a");
  });

  it("removes a bookmark optimistically and calls removeBookmark", async () => {
    // On success, `handleRemove` invalidates the shared bookmarks query
    // (Spec 12 review fix — keeps other surfaces like a mounted
    // `ChatShell`'s message action menu in sync), which refetches via
    // `listBookmarks`; the second resolved value below stands in for the
    // real `list_bookmarks` round-trip now reflecting the removal.
    listBookmarks.mockResolvedValueOnce([makeBookmark({ event_id: "$a" })]).mockResolvedValue([]);
    renderWithProviders(<SavedMessagesPanel onJumpToMessage={vi.fn()} />);

    await screen.findByText("hello there");
    fireEvent.click(screen.getByRole("button", { name: "Remove bookmark" }));

    await waitFor(() => expect(removeBookmark).toHaveBeenCalledWith("$a"));
    await waitFor(() => expect(screen.queryByText("hello there")).not.toBeInTheDocument());
  });

  it("restores the bookmark in the list if removeBookmark fails", async () => {
    listBookmarks.mockResolvedValue([makeBookmark({ event_id: "$a" })]);
    removeBookmark.mockRejectedValue(new Error("network error"));
    renderWithProviders(<SavedMessagesPanel onJumpToMessage={vi.fn()} />);

    await screen.findByText("hello there");
    fireEvent.click(screen.getByRole("button", { name: "Remove bookmark" }));

    await waitFor(() => expect(removeBookmark).toHaveBeenCalledWith("$a"));
    expect(await screen.findByText("hello there")).toBeInTheDocument();
  });

  it("shows a loading indicator before bookmarks resolve", async () => {
    let resolveBookmarks: (bookmarks: BookmarkEntry[]) => void = () => {};
    listBookmarks.mockReturnValue(
      new Promise<BookmarkEntry[]>((resolve) => {
        resolveBookmarks = resolve;
      }),
    );
    renderWithProviders(<SavedMessagesPanel onJumpToMessage={vi.fn()} />);

    expect(screen.getByText("Loading saved messages…")).toBeInTheDocument();

    resolveBookmarks([]);
    await screen.findByText("Bookmark a message from its action menu to save it here.");
  });
});
