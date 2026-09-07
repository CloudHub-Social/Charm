import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeRoomSummary } from "@/features/rooms/testFixtures";
import { ActivityView } from "./ActivityView";

describe("ActivityView", () => {
  it("shows only actionable rooms and routes joined rooms", () => {
    const onSelectRoom = vi.fn();
    render(
      <ActivityView
        rooms={[
          makeRoomSummary({ room_id: "!quiet:test", name: "Quiet" }),
          makeRoomSummary({
            room_id: "!mention:test",
            name: "Design room",
            unread_count: 3,
            has_unread: true,
          }),
          makeRoomSummary({
            room_id: "!invite:test",
            name: "New community",
            membership: "invite",
            inviter_display_name: "Ada",
          }),
        ]}
        onSelectRoom={onSelectRoom}
      />,
    );

    expect(screen.queryByText("Quiet")).not.toBeInTheDocument();
    expect(screen.getByText("Ada invited you")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Design room/i }));
    expect(onSelectRoom).toHaveBeenCalledWith("!mention:test");
  });

  it("renders a reassuring empty state", () => {
    render(<ActivityView rooms={[]} onSelectRoom={vi.fn()} />);
    expect(screen.getByText("You’re all caught up")).toBeInTheDocument();
  });

  it("counts marked-unread conversations as a notification", () => {
    render(
      <ActivityView
        rooms={[
          makeRoomSummary({
            room_id: "!marked:test",
            name: "Marked unread",
            is_marked_unread: true,
          }),
        ]}
        onSelectRoom={vi.fn()}
      />,
    );

    expect(screen.getByText("1 notification")).toBeInTheDocument();
  });

  it("includes ordinary unread conversations without a highlight", () => {
    render(
      <ActivityView
        rooms={[
          makeRoomSummary({
            room_id: "!ambient:test",
            name: "Ambient unread",
            has_unread: true,
          }),
        ]}
        onSelectRoom={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /Ambient unread/i })).toBeInTheDocument();
  });
});
