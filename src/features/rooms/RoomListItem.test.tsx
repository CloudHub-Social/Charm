import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RoomListItem } from "./RoomListItem";
import { makeRoomSummary } from "./testFixtures";

const room = makeRoomSummary();

describe("RoomListItem", () => {
  it("renders the room name", () => {
    render(<RoomListItem room={room} active={false} onSelect={() => {}} />);
    expect(screen.getByText("general")).toBeInTheDocument();
  });

  it("shows an unread badge when there are unread messages", () => {
    render(
      <RoomListItem
        room={makeRoomSummary({ unread_count: 3, has_unread: true })}
        active={false}
        onSelect={() => {}}
      />,
    );
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

  it("renders bold text and a marked-unread dot when has_unread is true, even with a zero notification count", () => {
    render(
      <RoomListItem
        room={makeRoomSummary({ has_unread: true, is_marked_unread: true })}
        active={false}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("general")).toHaveClass("font-bold");
    expect(screen.getByText("Marked unread")).toBeInTheDocument();
  });

  it("shows a muted indicator when is_muted is true", () => {
    render(
      <RoomListItem
        room={makeRoomSummary({ is_muted: true })}
        active={false}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByLabelText("Muted")).toBeInTheDocument();
  });

  it("does not render a context menu without any action handlers", () => {
    render(<RoomListItem room={room} active={false} onSelect={() => {}} />);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens a context menu with favourite/mark actions when handlers are provided", async () => {
    const onToggleFavourite = vi.fn();
    render(
      <RoomListItem
        room={room}
        active={false}
        onSelect={() => {}}
        onToggleFavourite={onToggleFavourite}
        onMarkRead={() => {}}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("button"));
    const item = await screen.findByText("Add to Favourites");
    fireEvent.click(item);
    expect(onToggleFavourite).toHaveBeenCalledOnce();
  });
});
