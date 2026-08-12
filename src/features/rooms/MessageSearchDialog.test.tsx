import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, wrapWithProviders } from "@/test/renderWithProviders";
import type * as MatrixModule from "@/lib/matrix";
import { effectiveMessageSearchRoomId, MessageSearchDialog } from "./MessageSearchDialog";

const searchMessages = vi.fn();
const isWebBuild = vi.fn(() => false);

vi.mock("@/lib/matrix", async (importOriginal) => ({
  ...(await importOriginal<typeof MatrixModule>()),
  searchMessages: (...args: unknown[]) => searchMessages(...args),
}));

vi.mock("@/lib/platform", () => ({
  isWebBuild: () => isWebBuild(),
}));

const room = {
  room_id: "!room:example.org",
  name: "Security",
  membership: "join",
} as MatrixModule.RoomSummary;

describe("MessageSearchDialog", () => {
  beforeEach(() => {
    searchMessages.mockReset();
    isWebBuild.mockReturnValue(false);
  });

  it("never widens stale room scope when the active room disappears", () => {
    expect(effectiveMessageSearchRoomId("room", null, [room])).toBeUndefined();
    expect(effectiveMessageSearchRoomId("room", room.room_id, [])).toBeUndefined();
    expect(effectiveMessageSearchRoomId("all", null, [])).toBeNull();
  });

  it("requires an explicit scope change when the active room disappears", () => {
    const props = {
      open: true,
      onOpenChange: vi.fn(),
      activeRoomId: room.room_id,
      onSelectResult: vi.fn(),
    };
    const { rerender, client } = renderWithProviders(
      <MessageSearchDialog {...props} rooms={[room]} />,
    );

    fireEvent.change(screen.getByLabelText("Message search query"), {
      target: { value: "security" },
    });
    rerender(wrapWithProviders(<MessageSearchDialog {...props} rooms={[]} />, client));

    expect(screen.getByRole("radio", { name: "This room" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "This room" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "All rooms" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
    fireEvent.submit(screen.getByLabelText("Message search query").closest("form")!);
    expect(searchMessages).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("radio", { name: "All rooms" }));
    expect(screen.getByRole("button", { name: "Search" })).not.toBeDisabled();

    rerender(wrapWithProviders(<MessageSearchDialog {...props} rooms={[room]} />, client));
    expect(screen.getByRole("radio", { name: "All rooms" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "This room" })).not.toBeChecked();
  });

  it("discloses hosted companion memory custody on web", () => {
    isWebBuild.mockReturnValue(true);
    renderWithProviders(
      <MessageSearchDialog
        open
        onOpenChange={vi.fn()}
        rooms={[room]}
        activeRoomId={room.room_id}
        onSelectResult={vi.fn()}
      />,
    );

    expect(screen.getByText(/hosted Charm companion’s memory/i)).toBeInTheDocument();
    expect(screen.getByText(/encrypted per-account index/i)).toBeInTheDocument();
  });

  it("searches the active room and navigates to the selected event", async () => {
    searchMessages.mockResolvedValue({
      results: [
        {
          room_id: room.room_id,
          event_id: "$event",
          sender: "@alice:example.org",
          origin_server_ts: 1_700_000_000_000,
          snippet: "hello Matrix world",
          match_ranges: [{ start: 6, end: 12 }],
        },
      ],
      next_cursor: null,
      incomplete: false,
    });
    const onSelectResult = vi.fn();
    renderWithProviders(
      <MessageSearchDialog
        open
        onOpenChange={vi.fn()}
        rooms={[room]}
        activeRoomId={room.room_id}
        onSelectResult={onSelectResult}
      />,
    );

    const queryInput = screen.getByLabelText("Message search query");
    fireEvent.submit(queryInput.closest("form")!);
    expect(searchMessages).not.toHaveBeenCalled();
    fireEvent.change(queryInput, {
      target: { value: "Matrix" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() =>
      expect(searchMessages).toHaveBeenCalledWith("Matrix", room.room_id, 30, null),
    );
    expect(screen.getByText("Matrix", { selector: "mark" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Security/ }));
    expect(onSelectResult).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/reveals the event ID/i);
    fireEvent.click(screen.getByRole("button", { name: "Open message" }));
    expect(onSelectResult).toHaveBeenCalledWith(expect.objectContaining({ event_id: "$event" }));
  });

  it("discloses an incomplete local index", async () => {
    searchMessages.mockResolvedValue({ results: [], next_cursor: null, incomplete: true });
    renderWithProviders(
      <MessageSearchDialog
        open
        onOpenChange={vi.fn()}
        rooms={[room]}
        activeRoomId={null}
        onSelectResult={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Message search query"), {
      target: { value: "history" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByRole("status")).toHaveTextContent(/may be incomplete/i);
  });

  it("searches all rooms and appends a cursor page", async () => {
    searchMessages
      .mockResolvedValueOnce({
        results: [
          {
            room_id: "!unknown:example.org",
            event_id: "$first",
            sender: "@alice:example.org",
            origin_server_ts: 1,
            snippet: "first result",
            match_ranges: [],
          },
        ],
        next_cursor: "next-page",
        incomplete: false,
      })
      .mockResolvedValueOnce({
        results: [
          {
            room_id: room.room_id,
            event_id: "$second",
            sender: "@bob:example.org",
            origin_server_ts: 2,
            snippet: "second result",
            match_ranges: [{ start: 50, end: 60 }],
          },
        ],
        next_cursor: null,
        incomplete: false,
      });
    renderWithProviders(
      <MessageSearchDialog
        open
        onOpenChange={vi.fn()}
        rooms={[room]}
        activeRoomId={room.room_id}
        onSelectResult={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "All rooms" }));
    fireEvent.change(screen.getByLabelText("Message search query"), {
      target: { value: "result" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("first result")).toBeInTheDocument();
    expect(screen.getByText(/!unknown:example.org/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() =>
      expect(searchMessages).toHaveBeenLastCalledWith("result", null, 30, "next-page"),
    );
    expect(screen.getByText("first result")).toBeInTheDocument();
    expect(await screen.findByText("second result")).toBeInTheDocument();
  });

  it("clears results and pagination when the user changes scope", async () => {
    searchMessages.mockResolvedValue({
      results: [
        {
          room_id: room.room_id,
          event_id: "$first",
          sender: "@alice:example.org",
          origin_server_ts: 1,
          snippet: "first result",
          match_ranges: [],
        },
      ],
      next_cursor: "room-cursor",
      incomplete: false,
    });
    renderWithProviders(
      <MessageSearchDialog
        open
        onOpenChange={vi.fn()}
        rooms={[room]}
        activeRoomId={room.room_id}
        onSelectResult={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Message search query"), {
      target: { value: "result" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("first result")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "All rooms" }));

    expect(screen.queryByText("first result")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    expect(searchMessages).toHaveBeenCalledOnce();
  });

  it("shows a generic error after an asynchronous backend failure", async () => {
    let rejectSearch: (reason?: unknown) => void = () => {};
    searchMessages.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectSearch = reject;
        }),
    );
    renderWithProviders(
      <MessageSearchDialog
        open
        onOpenChange={vi.fn()}
        rooms={[room]}
        activeRoomId={room.room_id}
        onSelectResult={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Message search query"), {
      target: { value: "private phrase" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(searchMessages).toHaveBeenCalledOnce());
    await act(async () => rejectSearch(new Error("sensitive backend detail")));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Message search is temporarily unavailable.");
    expect(alert).not.toHaveTextContent("private phrase");
  });

  it("prompts the user to restart after a stale pagination cursor", async () => {
    searchMessages
      .mockResolvedValueOnce({
        results: [],
        next_cursor: "expired-cursor",
        incomplete: false,
      })
      .mockRejectedValueOnce({
        code: "stale_cursor",
        message: "message search cursor is stale; restart the search",
      });
    renderWithProviders(
      <MessageSearchDialog
        open
        onOpenChange={vi.fn()}
        rooms={[room]}
        activeRoomId={room.room_id}
        onSelectResult={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Message search query"), {
      target: { value: "history" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Search results expired. Run the search again.",
    );
  });

  it("ignores a stale result after a newer search finishes", async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    searchMessages
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        results: [],
        next_cursor: null,
        incomplete: false,
      });
    renderWithProviders(
      <MessageSearchDialog
        open
        onOpenChange={vi.fn()}
        rooms={[room]}
        activeRoomId={room.room_id}
        onSelectResult={vi.fn()}
      />,
    );

    const input = screen.getByLabelText("Message search query");
    fireEvent.change(input, { target: { value: "first" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.change(input, { target: { value: "second" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(searchMessages).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("No messages found.")).toBeInTheDocument();

    await act(async () =>
      resolveFirst({
        results: [
          {
            room_id: room.room_id,
            event_id: "$stale",
            sender: "@alice:example.org",
            origin_server_ts: 1,
            snippet: "stale result",
            match_ranges: [],
          },
        ],
        next_cursor: null,
        incomplete: false,
      }),
    );
    expect(screen.queryByText("stale result")).not.toBeInTheDocument();
  });

  it("ignores an in-flight result after the dialog closes and reopens", async () => {
    let resolveSearch: (value: unknown) => void = () => {};
    searchMessages.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve;
        }),
    );
    const props = {
      onOpenChange: vi.fn(),
      rooms: [room],
      activeRoomId: room.room_id,
      onSelectResult: vi.fn(),
    };
    const { rerender, client } = renderWithProviders(<MessageSearchDialog open {...props} />);

    fireEvent.change(screen.getByLabelText("Message search query"), {
      target: { value: "previous session" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(searchMessages).toHaveBeenCalledOnce());

    rerender(wrapWithProviders(<MessageSearchDialog open={false} {...props} />, client));
    rerender(wrapWithProviders(<MessageSearchDialog open {...props} />, client));
    await act(async () =>
      resolveSearch({
        results: [
          {
            room_id: room.room_id,
            event_id: "$stale-reopen",
            sender: "@alice:example.org",
            origin_server_ts: 1,
            snippet: "stale reopened result",
            match_ranges: [],
          },
        ],
        next_cursor: null,
        incomplete: false,
      }),
    );

    expect(screen.queryByText("stale reopened result")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Search" })).not.toBeDisabled());
  });
});
