import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeRoomSummary } from "./testFixtures";
import { MobileSpacesView } from "./MobileSpacesView";

const rooms = [
  makeRoomSummary({ room_id: "!space:example.org", name: "Friends", is_space: true }),
  makeRoomSummary({
    room_id: "!nested:example.org",
    name: "Games",
    is_space: true,
    parent_space_ids: ["!space:example.org"],
  }),
  makeRoomSummary({
    room_id: "!room:example.org",
    name: "general",
    parent_space_ids: ["!nested:example.org"],
    has_unread: true,
  }),
  makeRoomSummary({
    room_id: "!dm:example.org",
    name: "Ada",
    is_direct: true,
    has_unread: true,
  }),
];

describe("MobileSpacesView", () => {
  it("renders native-style root destinations and nested spaces without duplicating rooms", () => {
    render(
      <MobileSpacesView
        rooms={rooms}
        activeMode="space"
        activeSpaceId="!nested:example.org"
        showAllRooms={false}
        onSelectHome={vi.fn()}
        onSelectDms={vi.fn()}
        onSelectSpace={vi.fn()}
        onCreateJoin={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /Home/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Direct messages/ })).toHaveTextContent("1");
    expect(screen.getByRole("button", { name: "Friends, unread activity" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Games, unread activity" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getAllByText("Games")).toHaveLength(1);
  });

  it("routes selection and create actions through the shell owner", () => {
    const onSelectSpace = vi.fn();
    const onCreateJoin = vi.fn();
    render(
      <MobileSpacesView
        rooms={rooms}
        activeMode="home"
        activeSpaceId={null}
        showAllRooms={false}
        onSelectHome={vi.fn()}
        onSelectDms={vi.fn()}
        onSelectSpace={onSelectSpace}
        onCreateJoin={onCreateJoin}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Friends, unread activity" }));
    fireEvent.click(screen.getByRole("button", { name: "Add or join a space" }));

    expect(onSelectSpace).toHaveBeenCalledWith("!space:example.org");
    expect(onCreateJoin).toHaveBeenCalledOnce();
  });
});
