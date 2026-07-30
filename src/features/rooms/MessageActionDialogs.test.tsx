import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageActionDialogs } from "./MessageActionDialogs";

vi.mock("@/components/ui/confirm-with-reason-dialog", () => ({
  ConfirmWithReasonDialog: ({
    title,
    onConfirm,
    onOpenChange,
  }: {
    title: string;
    onConfirm: (reason: string) => Promise<boolean>;
    onOpenChange: (open: boolean) => void;
  }) => (
    <div>
      <span>{title}</span>
      <button onClick={() => void onConfirm("because")}>confirm</button>
      <button onClick={() => onOpenChange(false)}>close</button>
    </div>
  ),
}));
vi.mock("./MessageSourceDialog", () => ({
  MessageSourceDialog: ({ roomId, eventId }: { roomId: string; eventId: string }) => (
    <span>{`source:${roomId}:${eventId}`}</span>
  ),
}));
vi.mock("./EditHistoryDialog", () => ({
  EditHistoryDialog: ({ roomId, eventId }: { roomId: string; eventId: string }) => (
    <span>{`history:${roomId}:${eventId}`}</span>
  ),
}));
vi.mock("./ForwardMessageDialog", () => ({
  ForwardMessageDialog: ({ sourceRoomId, eventId }: { sourceRoomId: string; eventId: string }) => (
    <span>{`forward:${sourceRoomId}:${eventId}`}</span>
  ),
}));

describe("MessageActionDialogs", () => {
  it("passes the complete room-scoped target through confirmation", () => {
    const onConfirm = vi.fn(async () => true);
    const target = {
      kind: "report" as const,
      roomId: "!room:example.org",
      eventId: "$event:example.org",
    };
    render(<MessageActionDialogs target={target} onClose={vi.fn()} onConfirm={onConfirm} />);

    fireEvent.click(screen.getByText("confirm"));
    expect(onConfirm).toHaveBeenCalledWith(target, "because");
  });

  it.each([
    ["source", "source:!room:example.org:$event:example.org"],
    ["history", "history:!room:example.org:$event:example.org"],
    ["forward", "forward:!room:example.org:$event:example.org"],
  ] as const)("routes the %s target without recombining room and event state", (kind, expected) => {
    render(
      <MessageActionDialogs
        target={{ kind, roomId: "!room:example.org", eventId: "$event:example.org" }}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText(expected)).toBeInTheDocument();
  });
});
