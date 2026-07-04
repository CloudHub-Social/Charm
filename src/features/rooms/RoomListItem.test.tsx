import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RoomListItem } from "./RoomListItem";
import type { RoomSummary } from "@/lib/matrix";

const room: RoomSummary = {
  room_id: "!abc123:localhost",
  name: "general",
  unread_count: 0,
};

describe("RoomListItem", () => {
  it("renders the room name", () => {
    render(<RoomListItem room={room} active={false} onSelect={() => {}} />);
    expect(screen.getByText("general")).toBeInTheDocument();
  });

  it("shows an unread badge when there are unread messages", () => {
    render(<RoomListItem room={{ ...room, unread_count: 3 }} active={false} onSelect={() => {}} />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("hides the unread badge when there are no unread messages", () => {
    render(<RoomListItem room={room} active={false} onSelect={() => {}} />);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("calls onSelect when clicked", () => {
    const onSelect = vi.fn();
    render(<RoomListItem room={room} active={false} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledOnce();
  });
});
