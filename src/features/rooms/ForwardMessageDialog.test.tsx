import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as MatrixModule from "@/lib/matrix";
import { ForwardMessageDialog } from "./ForwardMessageDialog";

const listRooms = vi.fn();
const forwardMessage = vi.fn();

vi.mock("@/lib/matrix", async () => {
  const actual = await vi.importActual<typeof MatrixModule>("@/lib/matrix");
  return {
    ...actual,
    listRooms: (...args: unknown[]) => listRooms(...args),
    forwardMessage: (...args: unknown[]) => forwardMessage(...args),
  };
});

function renderDialog(onForwarded = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ForwardMessageDialog
        open
        sourceRoomId="!source:localhost"
        eventId="$event:localhost"
        onOpenChange={() => {}}
        onForwarded={onForwarded}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  listRooms.mockReset();
  forwardMessage.mockReset();
});

describe("ForwardMessageDialog", () => {
  it("lists rooms and forwards to the clicked one", async () => {
    listRooms.mockResolvedValue([
      { room_id: "!a:localhost", name: "Alpha", avatar_url: null, avatar_path: null },
      { room_id: "!b:localhost", name: "Bravo", avatar_url: null, avatar_path: null },
    ]);
    forwardMessage.mockResolvedValue("txn-1");
    const onForwarded = vi.fn();

    renderDialog(onForwarded);

    fireEvent.click(await screen.findByText("Alpha"));

    expect(forwardMessage).toHaveBeenCalledWith(
      "!source:localhost",
      "$event:localhost",
      "!a:localhost",
    );
  });

  it("filters rooms by name", async () => {
    listRooms.mockResolvedValue([
      { room_id: "!a:localhost", name: "Alpha", avatar_url: null, avatar_path: null },
      { room_id: "!b:localhost", name: "Bravo", avatar_url: null, avatar_path: null },
    ]);

    renderDialog();

    await screen.findByText("Alpha");
    fireEvent.change(screen.getByPlaceholderText("Filter rooms…"), {
      target: { value: "brav" },
    });

    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
    expect(screen.getByText("Bravo")).toBeInTheDocument();
  });

  it("shows an inline error when forwarding fails", async () => {
    listRooms.mockResolvedValue([
      { room_id: "!a:localhost", name: "Alpha", avatar_url: null, avatar_path: null },
    ]);
    forwardMessage.mockRejectedValue(new Error("boom"));

    renderDialog();

    fireEvent.click(await screen.findByText("Alpha"));

    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });
});
