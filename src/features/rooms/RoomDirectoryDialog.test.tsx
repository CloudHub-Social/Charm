import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as MatrixModule from "@/lib/matrix";
import { RoomDirectoryDialog } from "./RoomDirectoryDialog";

const searchPublicRooms = vi.fn();
const joinRoom = vi.fn();

vi.mock("@/lib/matrix", async (importOriginal) => ({
  ...(await importOriginal<typeof MatrixModule>()),
  searchPublicRooms: (...args: unknown[]) => searchPublicRooms(...args),
  joinRoom: (...args: unknown[]) => joinRoom(...args),
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

  it("debounces server-side search and appends a deduplicated next page", async () => {
    searchPublicRooms
      .mockResolvedValueOnce({
        rooms: [matrixRoom],
        next_batch: "page-2",
        total_room_count_estimate: 2,
      })
      .mockResolvedValueOnce({
        rooms: [matrixRoom],
        next_batch: "page-2",
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
    await waitFor(() => expect(searchPublicRooms).toHaveBeenCalledWith("matrix", "page-2"));
    expect(await screen.findByText("Rust")).toBeInTheDocument();
    expect(screen.getAllByText("Matrix HQ")).toHaveLength(1);
  });

  it("joins by canonical alias, selects the resolved room, and closes", async () => {
    searchPublicRooms.mockResolvedValueOnce({
      rooms: [matrixRoom],
      next_batch: null,
      total_room_count_estimate: 1,
    });
    joinRoom.mockResolvedValueOnce({ room_id: "!matrix:example.org", is_space: false });
    const { onOpenChange, onJoined } = renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: "Join" }));

    expect(joinRoom).toHaveBeenCalledWith("#matrix:example.org");
    await waitFor(() => expect(onJoined).toHaveBeenCalledWith("!matrix:example.org"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
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
