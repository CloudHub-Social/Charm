import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as MatrixModule from "@/lib/matrix";
import { MessageSourceDialog } from "./MessageSourceDialog";

const getEventSource = vi.fn();
const clipboardWriteText = vi.fn();

vi.mock("@/lib/matrix", async () => {
  const actual = await vi.importActual<typeof MatrixModule>("@/lib/matrix");
  return { ...actual, getEventSource: (...args: unknown[]) => getEventSource(...args) };
});

beforeEach(() => {
  getEventSource.mockReset();
  clipboardWriteText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboardWriteText },
  });
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

  it("clears loading when an in-flight target is invalidated", () => {
    getEventSource.mockReturnValue(new Promise(() => {}));
    const { rerender } = render(
      <MessageSourceDialog
        open
        roomId="!room:localhost"
        eventId="$event:localhost"
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByText("Loading…")).toBeInTheDocument();

    rerender(<MessageSourceDialog open roomId={null} eventId={null} onOpenChange={() => {}} />);

    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(getEventSource).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Copy" })).toBeDisabled();
  });
});

describe("MessageSourceDialog request isolation", () => {
  const originalSource = '{"event_id":"$original","content":{"body":"original source"}}';
  const nextSource = '{"event_id":"$next","content":{"body":"next source"}}';

  function view(roomId = "!room:localhost", eventId = "$original", open = true) {
    return (
      <MessageSourceDialog open={open} roomId={roomId} eventId={eventId} onOpenChange={vi.fn()} />
    );
  }

  it.each(["event", "room"])(
    "hides and disables copying the previous source while a new %s loads or fails",
    async (target) => {
      getEventSource.mockResolvedValueOnce(originalSource);
      let rejectNext!: (reason: Error) => void;
      getEventSource.mockReturnValueOnce(
        new Promise<string>((_resolve, reject) => {
          rejectNext = reject;
        }),
      );
      const { rerender } = render(view());
      expect(await screen.findByText(originalSource)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Copy" })).toBeEnabled();

      const roomId = target === "room" ? "!next:localhost" : "!room:localhost";
      const eventId = target === "event" ? "$next" : "$original";
      rerender(view(roomId, eventId));
      expect(screen.queryByText(originalSource)).not.toBeInTheDocument();
      expect(screen.getByText("Loading…")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Copy" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      expect(clipboardWriteText).not.toHaveBeenCalled();
      await act(async () => {
        rejectNext(new Error("new source unavailable"));
      });
      expect(screen.getByRole("alert")).toHaveTextContent("new source unavailable");
      expect(screen.queryByText(originalSource)).not.toBeInTheDocument();
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Copy" })).toBeDisabled();
      expect(getEventSource).toHaveBeenLastCalledWith(roomId, eventId);
    },
  );

  it.each([
    ["target switch", false],
    ["target switch", true],
    ["reopen", false],
    ["reopen", true],
  ] as const)("ignores an old request after %s (failure %s)", async (target, failure) => {
    let finishOld!: () => void;
    getEventSource.mockReturnValueOnce(
      new Promise<string>((resolve, reject) => {
        finishOld = () =>
          failure ? reject(new Error("old source failure")) : resolve(originalSource);
      }),
    );
    getEventSource.mockResolvedValueOnce(nextSource);
    const { rerender } = render(view());
    if (target === "reopen") {
      rerender(view("!room:localhost", "$original", false));
      rerender(view());
    } else {
      rerender(view("!next:localhost", "$next"));
    }
    expect(await screen.findByText(nextSource)).toBeInTheDocument();
    await act(async () => {
      finishOld();
    });
    expect(screen.queryByText(originalSource)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(nextSource)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledExactlyOnceWith(nextSource));
  });

  it.each(["event", "reopen"])(
    "does not apply an old clipboard completion to a new %s session",
    async (target) => {
      getEventSource.mockResolvedValueOnce(originalSource).mockResolvedValueOnce(nextSource);
      let completeCopy!: () => void;
      clipboardWriteText.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          completeCopy = resolve;
        }),
      );
      const { rerender } = render(view());
      await screen.findByText(originalSource);
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      if (target === "reopen") {
        rerender(view("!room:localhost", "$original", false));
        rerender(view());
      } else {
        rerender(view("!room:localhost", "$next"));
      }
      await screen.findByText(nextSource);
      await act(async () => {
        completeCopy();
      });
      expect(screen.queryByRole("button", { name: "Copied" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Copy" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
      expect(clipboardWriteText.mock.calls).toEqual([[originalSource], [nextSource]]);
    },
  );

  it("resets source and copied feedback when the same target is closed and reopened", async () => {
    getEventSource.mockResolvedValueOnce(originalSource);
    let resolveAgain!: (source: string) => void;
    getEventSource.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveAgain = resolve;
      }),
    );
    const { rerender } = render(view());
    await screen.findByText(originalSource);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await screen.findByRole("button", { name: "Copied" });
    rerender(view("!room:localhost", "$original", false));
    rerender(view());
    expect(screen.getByRole("dialog", { name: "View source" })).toBeInTheDocument();
    expect(screen.queryByText(originalSource)).not.toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy" })).toBeDisabled();
    await act(async () => {
      resolveAgain(nextSource);
    });
    expect(screen.getByText(nextSource)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy" })).toBeEnabled();
    expect(getEventSource).toHaveBeenCalledTimes(2);
  });

  it("keeps copy failure local and preserves close behavior", async () => {
    getEventSource.mockResolvedValue(originalSource);
    clipboardWriteText.mockRejectedValueOnce(new Error("clipboard denied"));
    const onOpenChange = vi.fn();
    render(
      <MessageSourceDialog
        open
        roomId="!room:localhost"
        eventId="$original"
        onOpenChange={onOpenChange}
      />,
    );
    await screen.findByText(originalSource);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });
    expect(screen.getByRole("button", { name: "Copy" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
