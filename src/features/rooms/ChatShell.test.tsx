import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as MatrixLib from "@/lib/matrix";
import type { RoomSummary } from "@/lib/matrix";
import { ChatShell } from "./ChatShell";

const getTimelinePage = vi.fn();
const onTimelineUpdate = vi.fn();
const onUploadProgress = vi.fn();
const sendAttachment = vi.fn();
const sendMessage = vi.fn();
const openFileDialog = vi.fn();

let uploadProgressCallback:
  | ((progress: { txn_id: string; room_id: string; sent: number; total: number }) => void)
  | undefined;

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openFileDialog(...args),
}));

vi.mock("@/lib/matrix", async () => {
  const actual = await vi.importActual<typeof MatrixLib>("@/lib/matrix");
  return {
    ...actual,
    getTimelinePage: (...args: unknown[]) => getTimelinePage(...args),
    onTimelineUpdate: (...args: unknown[]) => onTimelineUpdate(...args),
    onUploadProgress: (cb: typeof uploadProgressCallback) => {
      uploadProgressCallback = cb;
      return onUploadProgress(cb);
    },
    sendAttachment: (...args: unknown[]) => sendAttachment(...args),
    sendMessage: (...args: unknown[]) => sendMessage(...args),
  };
});

const room: RoomSummary = {
  room_id: "!abc:localhost",
  name: "general",
  unread_count: 0,
};

beforeEach(() => {
  getTimelinePage.mockReset().mockResolvedValue({ messages: [], next_cursor: null });
  onTimelineUpdate.mockReset().mockResolvedValue(() => {});
  onUploadProgress.mockReset().mockResolvedValue(() => {});
  sendAttachment.mockReset().mockResolvedValue(undefined);
  sendMessage.mockReset().mockResolvedValue(undefined);
  openFileDialog.mockReset();
  uploadProgressCallback = undefined;
});

describe("ChatShell", () => {
  it("prompts to select a room when none is selected", () => {
    render(<ChatShell room={null} currentUserId="@me:localhost" />);
    expect(screen.getByText("Select a room to start chatting")).toBeInTheDocument();
  });

  it("enables the attach button and opens the file dialog on click", async () => {
    openFileDialog.mockResolvedValue("/Users/me/cat.png");
    render(<ChatShell room={room} currentUserId="@me:localhost" />);

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

    render(<ChatShell room={room} currentUserId="@me:localhost" />);

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

  it("dispatches the same upload path on paste-image-into-composer", async () => {
    render(<ChatShell room={room} currentUserId="@me:localhost" />);
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
