import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as MatrixModule from "@/lib/matrix";
import { EditHistoryDialog } from "./EditHistoryDialog";

const getEditHistory = vi.fn();

vi.mock("@/lib/matrix", async () => {
  const actual = await vi.importActual<typeof MatrixModule>("@/lib/matrix");
  return { ...actual, getEditHistory: (...args: unknown[]) => getEditHistory(...args) };
});

beforeEach(() => {
  getEditHistory.mockReset();
});

describe("EditHistoryDialog", () => {
  it("renders each entry oldest-first as returned", async () => {
    getEditHistory.mockResolvedValue([
      {
        event_id: "$orig:localhost",
        body: "hello",
        formatted_body: null,
        sender: "@alice:localhost",
        origin_server_ts: 1000,
      },
      {
        event_id: "$edit:localhost",
        body: "hello world",
        formatted_body: null,
        sender: "@alice:localhost",
        origin_server_ts: 2000,
      },
    ]);

    render(
      <EditHistoryDialog
        open
        roomId="!room:localhost"
        eventId="$orig:localhost"
        onOpenChange={() => {}}
      />,
    );

    expect(await screen.findByText("hello")).toBeInTheDocument();
    expect(screen.getByText("hello world")).toBeInTheDocument();
    expect(screen.getByText("Original")).toBeInTheDocument();
    expect(screen.getByText("Edit 1")).toBeInTheDocument();
  });

  it("shows an error message when the fetch fails", async () => {
    getEditHistory.mockRejectedValue(new Error("boom"));

    render(
      <EditHistoryDialog
        open
        roomId="!room:localhost"
        eventId="$orig:localhost"
        onOpenChange={() => {}}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });

  it("renders a non-Error rejection without crashing", async () => {
    getEditHistory.mockRejectedValue("offline");

    render(
      <EditHistoryDialog
        open
        roomId="!room:localhost"
        eventId="$orig:localhost"
        onOpenChange={() => {}}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
  });

  it("ignores a successful request that settles after the dialog closes", async () => {
    let resolveHistory!: (entries: []) => void;
    getEditHistory.mockReturnValue(
      new Promise((resolve) => {
        resolveHistory = resolve;
      }),
    );
    const { rerender } = render(
      <EditHistoryDialog
        open
        roomId="!room:localhost"
        eventId="$orig:localhost"
        onOpenChange={() => {}}
      />,
    );

    rerender(
      <EditHistoryDialog
        open={false}
        roomId="!room:localhost"
        eventId="$orig:localhost"
        onOpenChange={() => {}}
      />,
    );
    act(() => {
      resolveHistory([]);
    });

    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("ignores a failed request that settles after the dialog closes", async () => {
    let rejectHistory!: (reason: unknown) => void;
    getEditHistory.mockReturnValue(
      new Promise((_, reject) => {
        rejectHistory = reject;
      }),
    );
    const { rerender } = render(
      <EditHistoryDialog
        open
        roomId="!room:localhost"
        eventId="$orig:localhost"
        onOpenChange={() => {}}
      />,
    );

    rerender(
      <EditHistoryDialog
        open={false}
        roomId="!room:localhost"
        eventId="$orig:localhost"
        onOpenChange={() => {}}
      />,
    );
    act(() => {
      rejectHistory(new Error("late failure"));
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
