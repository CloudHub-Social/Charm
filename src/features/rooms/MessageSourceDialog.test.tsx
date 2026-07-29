import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as MatrixModule from "@/lib/matrix";
import { MessageSourceDialog } from "./MessageSourceDialog";

const getEventSource = vi.fn();

vi.mock("@/lib/matrix", async () => {
  const actual = await vi.importActual<typeof MatrixModule>("@/lib/matrix");
  return { ...actual, getEventSource: (...args: unknown[]) => getEventSource(...args) };
});

beforeEach(() => {
  getEventSource.mockReset();
});

describe("MessageSourceDialog", () => {
  it("fetches and renders the event source when opened", async () => {
    getEventSource.mockResolvedValue('{\n  "type": "m.room.message"\n}');

    render(
      <MessageSourceDialog
        open
        roomId="!room:localhost"
        eventId="$event:localhost"
        onOpenChange={() => {}}
      />,
    );

    expect(await screen.findByText(/m\.room\.message/)).toBeInTheDocument();
    expect(getEventSource).toHaveBeenCalledWith("!room:localhost", "$event:localhost");
  });

  it("shows an error message when the fetch fails", async () => {
    getEventSource.mockRejectedValue(new Error("boom"));

    render(
      <MessageSourceDialog
        open
        roomId="!room:localhost"
        eventId="$event:localhost"
        onOpenChange={() => {}}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });

  it("renders a non-Error rejection without crashing", async () => {
    getEventSource.mockRejectedValue("offline");

    render(
      <MessageSourceDialog
        open
        roomId="!room:localhost"
        eventId="$event:localhost"
        onOpenChange={() => {}}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
  });

  it("ignores a successful request that settles after the dialog closes", async () => {
    let resolveSource!: (source: string) => void;
    getEventSource.mockReturnValue(
      new Promise((resolve) => {
        resolveSource = resolve;
      }),
    );
    const { rerender } = render(
      <MessageSourceDialog
        open
        roomId="!room:localhost"
        eventId="$event:localhost"
        onOpenChange={() => {}}
      />,
    );

    rerender(
      <MessageSourceDialog
        open={false}
        roomId="!room:localhost"
        eventId="$event:localhost"
        onOpenChange={() => {}}
      />,
    );
    act(() => {
      resolveSource('{"type":"m.room.message"}');
    });

    expect(screen.queryByText(/m\.room\.message/)).not.toBeInTheDocument();
  });

  it("ignores a failed request that settles after the dialog closes", async () => {
    let rejectSource!: (reason: unknown) => void;
    getEventSource.mockReturnValue(
      new Promise((_, reject) => {
        rejectSource = reject;
      }),
    );
    const { rerender } = render(
      <MessageSourceDialog
        open
        roomId="!room:localhost"
        eventId="$event:localhost"
        onOpenChange={() => {}}
      />,
    );

    rerender(
      <MessageSourceDialog
        open={false}
        roomId="!room:localhost"
        eventId="$event:localhost"
        onOpenChange={() => {}}
      />,
    );
    act(() => {
      rejectSource(new Error("late failure"));
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not fetch when closed", () => {
    render(
      <MessageSourceDialog open={false} roomId={null} eventId={null} onOpenChange={() => {}} />,
    );
    expect(getEventSource).not.toHaveBeenCalled();
  });
});
