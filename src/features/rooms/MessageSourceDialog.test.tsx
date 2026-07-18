import { render, screen } from "@testing-library/react";
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

  it("does not fetch when closed", () => {
    render(
      <MessageSourceDialog open={false} roomId={null} eventId={null} onOpenChange={() => {}} />,
    );
    expect(getEventSource).not.toHaveBeenCalled();
  });
});
