import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as MatrixModule from "@/lib/matrix";
import { RoomDirectoryDialog } from "./RoomDirectoryDialog";

const searchPublicRooms = vi.fn();
const joinRoom = vi.fn();
const resolveAvatar = vi.fn();

vi.mock("@/lib/matrix", async (importOriginal) => ({
  ...(await importOriginal<typeof MatrixModule>()),
  searchPublicRooms: (...args: unknown[]) => searchPublicRooms(...args),
  joinRoom: (...args: unknown[]) => joinRoom(...args),
  resolveAvatar: (...args: unknown[]) => resolveAvatar(...args),
}));

vi.mock("@/lib/platform", () => ({ isWebBuild: () => false }));

const matrixRoom: MatrixModule.PublicRoomSummary = {
  room_id: "!matrix:example.org",
  name: "Matrix HQ",
  topic: "Public Matrix discussion",
  canonical_alias: "#matrix:example.org",
  avatar_url: null,
  joined_members: 42,
};

function renderDialog() {
  const onOpenChange = vi.fn();
  const onJoined = vi.fn();
  render(<RoomDirectoryDialog open onOpenChange={onOpenChange} onJoined={onJoined} />);
  return { onOpenChange, onJoined };
}

describe("RoomDirectoryDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("loads the homeserver directory and shows room metadata", async () => {
    searchPublicRooms.mockResolvedValueOnce({
      rooms: [matrixRoom],
      next_batch: null,
      total_room_count_estimate: 120,
    });

    renderDialog();

    expect(await screen.findByText("Matrix HQ")).toBeInTheDocument();
    expect(searchPublicRooms).toHaveBeenCalledWith(null);
    expect(screen.getByText("#matrix:example.org")).toBeInTheDocument();
    expect(screen.getByText("42 members")).toBeInTheDocument();
    expect(screen.getByText("About 120 public rooms")).toBeInTheDocument();
  });

  it("keeps the initials fallback when native avatar resolution fails", async () => {
    resolveAvatar.mockRejectedValueOnce(new Error("media unavailable"));
    searchPublicRooms.mockResolvedValueOnce({
      rooms: [{ ...matrixRoom, avatar_url: "mxc://example.org/avatar" }],
      next_batch: null,
      total_room_count_estimate: 1,
    });
    renderDialog();
    expect(await screen.findByText("Matrix HQ")).toBeInTheDocument();
    await waitFor(() => expect(resolveAvatar).toHaveBeenCalledWith("mxc://example.org/avatar"));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it.each(["page-2", ""])(
    "preserves opaque pagination token %j and deduplicates the next page",
    async (token) => {
      searchPublicRooms
        .mockResolvedValueOnce({
          rooms: [matrixRoom],
          next_batch: token,
          total_room_count_estimate: 2,
        })
        .mockResolvedValueOnce({
          rooms: [matrixRoom],
          next_batch: token,
          total_room_count_estimate: 2,
        })
        .mockResolvedValueOnce({
          rooms: [matrixRoom, { ...matrixRoom, room_id: "!rust:example.org", name: "Rust" }],
          next_batch: null,
          total_room_count_estimate: 2,
        });
      renderDialog();
      expect(await screen.findByText("Matrix HQ")).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText("Search public rooms"), {
        target: { value: "matrix" },
      });
      await waitFor(() => expect(searchPublicRooms).toHaveBeenCalledWith("matrix"));

      fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
      await waitFor(() => expect(searchPublicRooms).toHaveBeenCalledWith("matrix", token));
      expect(await screen.findByText("Rust")).toBeInTheDocument();
      expect(screen.getAllByText("Matrix HQ")).toHaveLength(1);
    },
  );

  it("joins the directory room ID even when an alias is present, selects it, and closes", async () => {
    searchPublicRooms.mockResolvedValueOnce({
      rooms: [matrixRoom],
      next_batch: null,
      total_room_count_estimate: 1,
    });
    joinRoom.mockResolvedValueOnce({ room_id: "!matrix:example.org", is_space: false });
    const { onOpenChange, onJoined } = renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: "Join" }));

    expect(joinRoom).toHaveBeenCalledWith("!matrix:example.org");
    await waitFor(() =>
      expect(onJoined).toHaveBeenCalledWith("!matrix:example.org", expect.any(AbortSignal)),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not navigate or close a reopened dialog after an old join completes", async () => {
    searchPublicRooms.mockResolvedValue({
      rooms: [matrixRoom],
      next_batch: null,
      total_room_count_estimate: null,
    });
    let complete!: (value: { room_id: string; is_space: boolean }) => void;
    joinRoom.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const onJoined = vi.fn();
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <RoomDirectoryDialog open onJoined={onJoined} onOpenChange={onOpenChange} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Join" }));
    rerender(<RoomDirectoryDialog open={false} onJoined={onJoined} onOpenChange={onOpenChange} />);
    rerender(<RoomDirectoryDialog open onJoined={onJoined} onOpenChange={onOpenChange} />);
    await act(async () => complete({ room_id: matrixRoom.room_id, is_space: false }));
    expect(onJoined).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("distinguishes successful membership from failed room navigation", async () => {
    searchPublicRooms.mockResolvedValueOnce({
      rooms: [matrixRoom],
      next_batch: null,
      total_room_count_estimate: null,
    });
    joinRoom.mockResolvedValueOnce({ room_id: matrixRoom.room_id, is_space: false });
    const { onJoined } = renderDialog();
    onJoined.mockRejectedValueOnce(new Error("navigation unavailable"));
    fireEvent.click(await screen.findByRole("button", { name: "Join" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Joined the room, but couldn't open it",
    );
  });

  it("aborts parent navigation when dismissed during its refresh", async () => {
    searchPublicRooms.mockResolvedValueOnce({
      rooms: [matrixRoom],
      next_batch: null,
      total_room_count_estimate: null,
    });
    joinRoom.mockResolvedValueOnce({ room_id: matrixRoom.room_id, is_space: false });
    let finish!: () => void;
    const onJoined = vi.fn((id: string, signal?: AbortSignal) => {
      void id;
      void signal;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <RoomDirectoryDialog open onJoined={onJoined} onOpenChange={onOpenChange} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Join" }));
    await waitFor(() => expect(onJoined).toHaveBeenCalledOnce());
    const signal = onJoined.mock.calls[0][1];
    expect(signal?.aborted).toBe(false);
    rerender(<RoomDirectoryDialog open={false} onJoined={onJoined} onOpenChange={onOpenChange} />);
    expect(signal?.aborted).toBe(true);
    await act(async () => finish());
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("disables old pagination as soon as a replacement search starts", async () => {
    searchPublicRooms
      .mockResolvedValueOnce({
        rooms: [matrixRoom],
        next_batch: "old-page",
        total_room_count_estimate: 2,
      })
      .mockResolvedValueOnce({
        rooms: [matrixRoom],
        next_batch: null,
        total_room_count_estimate: 1,
      });
    renderDialog();
    const oldLoadMore = await screen.findByRole("button", { name: "Load more" });
    fireEvent.change(screen.getByLabelText("Search public rooms"), { target: { value: "matrix" } });
    fireEvent.click(oldLoadMore);
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    expect(searchPublicRooms).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Matrix HQ")).toBeInTheDocument();
    expect(searchPublicRooms).toHaveBeenCalledTimes(2);
    expect(searchPublicRooms).toHaveBeenLastCalledWith("matrix");
    expect(screen.queryByLabelText("Loading public rooms")).not.toBeInTheDocument();
  });

  it("clears stale pagination state when a new search supersedes it", async () => {
    let resolveStalePage: (page: MatrixModule.PublicRoomPage) => void = () => {};
    searchPublicRooms
      .mockResolvedValueOnce({
        rooms: [matrixRoom],
        next_batch: "old-page-2",
        total_room_count_estimate: 2,
      })
      .mockReturnValueOnce(
        new Promise<MatrixModule.PublicRoomPage>((resolve) => {
          resolveStalePage = resolve;
        }),
      )
      .mockResolvedValueOnce({
        rooms: [{ ...matrixRoom, room_id: "!rust:example.org", name: "Rust" }],
        next_batch: "fresh-page-2",
        total_room_count_estimate: 2,
      });
    renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Search public rooms"), {
      target: { value: "rust" },
    });

    expect(await screen.findByText("Rust")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled();

    resolveStalePage({
      rooms: [{ ...matrixRoom, room_id: "!stale:example.org", name: "Stale" }],
      next_batch: null,
      total_room_count_estimate: 2,
    });
    await Promise.resolve();

    expect(screen.queryByText("Stale")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled();
  });
});
